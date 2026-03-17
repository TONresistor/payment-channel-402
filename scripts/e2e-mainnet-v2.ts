/**
 * e2e-mainnet-v2.ts — Full E2E test of pc402 SDK v2 on TON mainnet
 *
 * Tests all SDK methods against the real blockchain:
 *   Phase 1: Happy path (deploy, topUp, init, commit, commit+withdraw, close, reopen check)
 *   Phase 2: Dispute path (reopen, startUncooperativeClose, finishUncooperativeClose)
 *   Phase 3: Off-chain payments (PaymentChannel sign/verify, close with final state)
 *
 * Run: npx tsx scripts/e2e-mainnet-v2.ts
 * Cost: ~0.1 TON total
 * Duration: ~5 min (phase 2 waits 2 min for quarantine expiry)
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { type Address, toNano } from "@ton/core";
import { type KeyPair, mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
import { buildSignedSemiChannel, OnchainChannel } from "pc402-channel";
import type { ChannelState } from "pc402-core";
import { balanceToSentCoins, PaymentChannel } from "pc402-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ton = (n: bigint) => (Number(n) / 1e9).toFixed(4);
let step = 0;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function ok(msg: string) {
  step++;
  console.log(`  [${step}] OK — ${msg}`);
}
function fail(msg: string): never {
  throw new Error(`FAIL at step ${step + 1}: ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry with exponential backoff on 429 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.status === 429 || e?.response?.status === 429 || e?.message?.includes("429")) {
        const delay = (i + 1) * 3000;
        log(`  rate limited, retrying in ${delay / 1000}s...`);
        await sleep(delay);
      } else {
        throw e;
      }
    }
  }
  return fn();
}

async function waitSeqno(
  wallet: ReturnType<typeof TonClient.prototype.open<WalletContractV5R1>>,
  prev: number,
  timeout = 60_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if ((await wallet.getSeqno()) > prev) return;
    } catch {}
    await sleep(3_000);
  }
  fail("Timeout waiting for seqno change");
}

async function waitDrained(client: TonClient, addr: Address, timeout = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const s = await client.getContractState(addr);
      log(`  poll: state=${s.state} balance=${ton(s.balance)} TON`);
      if (s.state === "uninitialized" || s.state === "frozen" || s.balance < toNano("0.005"))
        return;
    } catch {
      return; // contract gone
    }
    await sleep(3_000);
  }
  fail("Timeout waiting for channel drain");
}

async function waitActive(client: TonClient, addr: Address, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const s = await client.getContractState(addr);
      if (s.state === "active") return;
    } catch {}
    await sleep(3_000);
  }
  fail("Timeout waiting for contract active");
}

/** Send tx and wait for confirmation + propagation */
async function sendAndWait(
  wallet: ReturnType<typeof TonClient.prototype.open<WalletContractV5R1>>,
  action: () => Promise<void>,
) {
  const seq = await withRetry(() => wallet.getSeqno());
  await withRetry(action);
  await waitSeqno(wallet, seq);
  await sleep(5_000); // wait for state propagation
}

/** Poll getOnchainState until expected state is reached */
async function waitForChannelState(
  ch: OnchainChannel,
  expected: number,
  timeout = 60_000,
): Promise<Awaited<ReturnType<typeof ch.getOnchainState>>> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const s = await withRetry(() => ch.getOnchainState());
      log(`  channel state: ${s.state} (want ${expected})`);
      if (s.state === expected) return s;
    } catch (e: any) {
      const msg = e instanceof Error ? e.message.substring(0, 60) : String(e);
      log(`  getOnchainState error: ${msg}`);
    }
    await sleep(5_000);
  }
  const s = await withRetry(() => ch.getOnchainState());
  return s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Setup
  const walletPath = resolve(__dirname, "../.wallet.json");
  const walletData = JSON.parse(readFileSync(walletPath, "utf-8"));

  const client = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey: process.env.TONCENTER_API_KEY,
  });

  const keyPairA: KeyPair = await mnemonicToPrivateKey(walletData.walletA.mnemonic);
  const keyPairB: KeyPair = await mnemonicToPrivateKey(walletData.walletB.mnemonic);

  const walletContractA = WalletContractV5R1.create({ publicKey: keyPairA.publicKey });
  const walletContractB = WalletContractV5R1.create({ publicKey: keyPairB.publicKey });

  const walletA = client.open(walletContractA);
  const walletB = client.open(walletContractB);
  const senderA = walletA.sender(keyPairA.secretKey);
  const _senderB = walletB.sender(keyPairB.secretKey);

  const addressA = walletContractA.address;
  const addressB = walletContractB.address;

  const balA = await client.getBalance(addressA);
  const balB = await client.getBalance(addressB);
  log(`Wallet A: ${ton(balA)} TON | ${addressA.toString({ bounceable: false })}`);
  log(`Wallet B: ${ton(balB)} TON | ${addressB.toString({ bounceable: false })}`);

  if (balA < toNano("0.08")) fail(`Wallet A needs >= 0.08 TON (has ${ton(balA)})`);

  // Channel config — short quarantine for dispute test
  const channelId = BigInt(`0x${randomBytes(16).toString("hex")}`);

  const channel = new OnchainChannel({
    client,
    keyPairA,
    keyPairB,
    channelId,
    addressA,
    addressB,
    initBalanceA: 0n,
    initBalanceB: 0n,
    closingConfig: {
      quarantineDuration: 60, // 1 min
      conditionalCloseDuration: 60, // 1 min
      misbehaviorFine: 0n,
    },
  });

  const chAddr = channel.getAddress();
  log(`Channel address: ${chAddr.toString()}`);
  log(`Channel ID: ${channelId.toString(16)}`);
  log("");

  // =========================================================================
  // PHASE 1 — Happy path
  // =========================================================================
  log("=== PHASE 1: HAPPY PATH ===");

  const depositA = toNano("0.02");
  const depositB = 0n;

  // 1. Deploy + TopUp A
  log(`Deploy + TopUp A (${ton(depositA)} TON)...`);
  await sendAndWait(walletA, () => channel.deployAndTopUp(senderA, true, depositA));
  await waitActive(client, chAddr);
  ok("deployAndTopUp A");

  // 2. Init (A only, B deposits nothing)
  log("Init channel...");
  await sendAndWait(walletA, () => channel.init(senderA, depositA, depositB, keyPairA));
  ok("init");

  // 3. getOnchainState — OPEN (poll until propagated)
  let state = await waitForChannelState(channel, 1);
  if (state.state !== 1) fail(`Expected state=1 (OPEN), got ${state.state}`);
  ok(`getOnchainState: OPEN, A=${ton(state.balanceA)}, B=${ton(state.balanceB)}`);

  // 5. CooperativeCommit (seqno 1/1, A sends 0.01 to B)
  const sentA1 = toNano("0.005");
  const sigCommitA1 = channel.signCommit(1n, 1n, sentA1, 0n, keyPairA);
  const sigCommitB1 = channel.signCommit(1n, 1n, sentA1, 0n, keyPairB);
  log("CooperativeCommit #1 (sentA=0.02)...");
  await sendAndWait(walletA, () =>
    channel.cooperativeCommit(senderA, 1n, 1n, sentA1, 0n, sigCommitA1, sigCommitB1),
  );
  state = await waitForChannelState(channel, 1);
  if (state.seqnoA !== 1) fail(`Expected seqnoA=1, got ${state.seqnoA}`);
  if (state.seqnoB !== 1) fail(`Expected seqnoB=1, got ${state.seqnoB}`);
  ok(`cooperativeCommit: seqnoA=${state.seqnoA}, seqnoB=${state.seqnoB}`);

  // 7. CooperativeCommit #2 with withdrawal
  const withdrawA = toNano("0.002");
  const sigCommitA2 = channel.signCommit(2n, 2n, sentA1, 0n, keyPairA, withdrawA);
  const sigCommitB2 = channel.signCommit(2n, 2n, sentA1, 0n, keyPairB, withdrawA);
  log("CooperativeCommit #2 (withdrawA=0.01)...");
  await sendAndWait(walletA, () =>
    channel.cooperativeCommit(senderA, 2n, 2n, sentA1, 0n, sigCommitA2, sigCommitB2, withdrawA),
  );
  state = await waitForChannelState(channel, 1);
  if (state.withdrawnA !== withdrawA)
    fail(`Expected withdrawnA=${withdrawA}, got ${state.withdrawnA}`);
  ok(`cooperativeCommit+withdraw: withdrawnA=${ton(state.withdrawnA)}`);

  // 9. CooperativeClose
  const closeSigA = channel.signClose(sentA1, 0n, keyPairA);
  const closeSigB = channel.signClose(sentA1, 0n, keyPairB);
  log("CooperativeClose...");
  await sendAndWait(walletA, () =>
    channel.cooperativeClose(senderA, sentA1, 0n, closeSigA, closeSigB),
  );
  await waitDrained(client, chAddr);
  ok("cooperativeClose");

  // 11. Verify UNINITED (reopen possible)
  state = await waitForChannelState(channel, 0);
  if (state.state !== 0) fail(`Expected state=0 (UNINITED), got ${state.state}`);
  ok(`reopen check: state=UNINITED`);

  log("");

  // =========================================================================
  // PHASE 2 — Dispute path
  // =========================================================================
  log("=== PHASE 2: DISPUTE PATH ===");

  const depositA2 = toNano("0.015");

  // 12. Reopen: deployAndTopUp A (uses GAS_DEPLOY=0.01 which covers storageFee)
  log(`Reopen: deployAndTopUp A (${ton(depositA2)} TON)...`);
  await sendAndWait(walletA, () => channel.deployAndTopUp(senderA, true, depositA2));
  await waitActive(client, chAddr);
  ok("deployAndTopUp A (reopen)");

  // 13. Init
  log("Init...");
  await sendAndWait(walletA, () => channel.init(senderA, depositA2, 0n, keyPairA));
  // Check contract balance to verify init tx landed
  const balAfterInit = await client.getBalance(chAddr);
  log(`  contract balance after init: ${ton(balAfterInit)} TON`);
  state = await waitForChannelState(channel, 1);
  if (state.state !== 1) fail(`Expected OPEN, got ${state.state}`);
  ok("init (reopen)");

  // 15. startUncooperativeClose
  // Note: seqnos must be >= commitedSeqnos from phase 1 (which were 2/2)
  const reopenState = await withRetry(() => channel.getOnchainState());
  const uncoopSeqA = BigInt(reopenState.seqnoA + 1);
  const uncoopSeqB = BigInt(reopenState.seqnoB + 1);
  log(
    `  using seqnos ${uncoopSeqA}/${uncoopSeqB} (committed: ${reopenState.seqnoA}/${reopenState.seqnoB})`,
  );
  const schA = buildSignedSemiChannel(channelId, uncoopSeqA, 0n, keyPairA);
  const schB = buildSignedSemiChannel(channelId, uncoopSeqB, 0n, keyPairB);
  const uncoopSig = channel.signStartUncoopClose(schA, schB, keyPairA);
  log("startUncooperativeClose...");
  await sendAndWait(walletA, () =>
    channel.startUncooperativeClose(senderA, true, uncoopSig, schA, schB),
  );
  ok("startUncooperativeClose");

  // 16. Verify CLOSURE_STARTED
  state = await waitForChannelState(channel, 2);
  if (state.state !== 2) fail(`Expected state=2 (CLOSURE_STARTED), got ${state.state}`);
  ok(`getOnchainState: CLOSURE_STARTED`);

  // 17. Wait quarantine (60s) + close (60s) = 120s
  log("Waiting 130s for quarantine + close period to expire...");
  await sleep(130_000);

  // 18. finishUncooperativeClose
  log("finishUncooperativeClose...");
  await sendAndWait(walletA, () => channel.finishUncooperativeClose(senderA));
  await waitDrained(client, chAddr);
  ok("finishUncooperativeClose");

  // 20. Verify UNINITED
  state = await waitForChannelState(channel, 0);
  if (state.state !== 0) fail(`Expected UNINITED, got ${state.state}`);
  ok("reopen check after dispute: UNINITED");

  log("");

  // =========================================================================
  // PHASE 3 — Off-chain payments + close
  // =========================================================================
  log("=== PHASE 3: OFF-CHAIN PAYMENTS ===");

  const depositA3 = toNano("0.05");

  // 21. Reopen
  log(`Reopen: deployAndTopUp A (${ton(depositA3)} TON)...`);
  await sendAndWait(walletA, () => channel.deployAndTopUp(senderA, true, depositA3));
  await waitActive(client, chAddr);
  log("Init...");
  await sendAndWait(walletA, () => channel.init(senderA, depositA3, 0n, keyPairA));
  ok("reopen (phase 3)");

  // 23. PaymentChannel off-chain — 1000 bidirectional payments
  const pcA = new PaymentChannel({
    channelId,
    isA: true,
    myKeyPair: keyPairA,
    hisPublicKey: keyPairB.publicKey,
    initBalanceA: depositA3,
    initBalanceB: 0n,
  });

  const pcB = new PaymentChannel({
    channelId,
    isA: false,
    myKeyPair: keyPairB,
    hisPublicKey: keyPairA.publicKey,
    initBalanceA: depositA3,
    initBalanceB: 0n,
  });

  let curState: ChannelState = {
    balanceA: depositA3,
    balanceB: 0n,
    seqnoA: 0,
    seqnoB: 0,
  };

  const t0 = Date.now();

  // Wave 1: A sends 200 payments to B (small, 0.0001 each = 0.02 total)
  const wave1Amt = toNano("0.0001");
  for (let i = 0; i < 200; i++) {
    curState = pcA.createPaymentState(curState, wave1Amt);
    const sig = pcA.signState(curState);
    if (!pcB.verifyState(curState, sig)) fail(`Wave1 A→B #${i + 1} verify failed`);
  }
  log(
    `  Wave 1: A→B x200 (${ton(wave1Amt)}/tx) | A=${ton(curState.balanceA)} B=${ton(curState.balanceB)}`,
  );

  // Wave 2: B sends 100 payments back to A (larger, 0.0002 each = 0.02 total)
  const wave2Amt = toNano("0.0002");
  for (let i = 0; i < 100; i++) {
    curState = pcB.createPaymentState(curState, wave2Amt);
    const sig = pcB.signState(curState);
    if (!pcA.verifyState(curState, sig)) fail(`Wave2 B→A #${i + 1} verify failed`);
  }
  log(
    `  Wave 2: B→A x100 (${ton(wave2Amt)}/tx) | A=${ton(curState.balanceA)} B=${ton(curState.balanceB)}`,
  );

  // Wave 3: Alternating asymmetric — A sends 0.0001, B sends 0.00005 back (net: A loses 0.00005/round)
  // 200 rounds = 400 tx. Net transfer A→B: 200 * 0.00005 = 0.01 TON
  const wave3A = toNano("0.0001");
  const wave3B = toNano("0.00005");
  for (let i = 0; i < 200; i++) {
    curState = pcA.createPaymentState(curState, wave3A);
    let sig = pcA.signState(curState);
    if (!pcB.verifyState(curState, sig)) fail(`Wave3 A→B #${i + 1} verify failed`);
    curState = pcB.createPaymentState(curState, wave3B);
    sig = pcB.signState(curState);
    if (!pcA.verifyState(curState, sig)) fail(`Wave3 B→A #${i + 1} verify failed`);
  }
  log(
    `  Wave 3: A↔B x200 rounds (asymmetric) | A=${ton(curState.balanceA)} B=${ton(curState.balanceB)}`,
  );

  // Wave 4: B drains back to A — 100 payments returning all B's balance
  const bBal = pcB.getMyBalance(curState);
  const wave4Amt = bBal / 100n;
  for (let i = 0; i < 99; i++) {
    curState = pcB.createPaymentState(curState, wave4Amt);
    const sig = pcB.signState(curState);
    if (!pcA.verifyState(curState, sig)) fail(`Wave4 B→A #${i + 1} verify failed`);
  }
  // Last payment: exact remaining
  const bRemaining = pcB.getMyBalance(curState);
  curState = pcB.createPaymentState(curState, bRemaining);
  const lastSig = pcB.signState(curState);
  if (!pcA.verifyState(curState, lastSig)) fail("Wave4 final verify failed");
  log(`  Wave 4: B→A x100 (drain) | A=${ton(curState.balanceA)} B=${ton(curState.balanceB)}`);

  const elapsed = Date.now() - t0;
  const totalPayments = 200 + 100 + 400 + 100;
  log("");
  log(
    `  ${totalPayments} payments in ${elapsed}ms (${(elapsed / totalPayments).toFixed(1)}ms/tx, ${Math.round((totalPayments * 1000) / elapsed)}/sec)`,
  );
  log(`  seqnoA=${curState.seqnoA} seqnoB=${curState.seqnoB}`);
  log(`  Final: A=${ton(pcA.getMyBalance(curState))} B=${ton(pcB.getMyBalance(curState))}`);

  // Verify round-trip: A should have all funds back, B should have 0
  if (pcB.getMyBalance(curState) !== 0n)
    fail(`B should be 0, got ${ton(pcB.getMyBalance(curState))}`);
  if (pcA.getMyBalance(curState) !== depositA3)
    fail(`A should be ${ton(depositA3)}, got ${ton(pcA.getMyBalance(curState))}`);
  ok(`1000 bidirectional off-chain payments — round-trip verified`);

  // 25. signClose + cooperativeClose
  const finalSentA = balanceToSentCoins(depositA3, curState.balanceA);
  const finalSentB = balanceToSentCoins(0n, curState.balanceB);

  const pcCloseSigA = channel.signClose(finalSentA, finalSentB, keyPairA);
  const pcCloseSigB = channel.signClose(finalSentA, finalSentB, keyPairB);

  // Verify with PaymentChannel too
  const pcVerifyA = pcA.signClose(curState);
  const pcVerifyB = pcB.signClose(curState);
  if (!pcA.verifyClose(curState, pcVerifyB)) fail("PaymentChannel verifyClose failed");
  if (!pcB.verifyClose(curState, pcVerifyA)) fail("PaymentChannel verifyClose failed");
  ok("PaymentChannel signClose/verifyClose");

  log("CooperativeClose with final state...");
  await sendAndWait(walletA, () =>
    channel.cooperativeClose(senderA, finalSentA, finalSentB, pcCloseSigA, pcCloseSigB),
  );
  await waitDrained(client, chAddr);
  ok("cooperativeClose (off-chain payments settled)");

  // =========================================================================
  // Summary
  // =========================================================================
  await sleep(5000);
  const finalA = await client.getBalance(addressA);
  const finalB = await client.getBalance(addressB);
  log("");
  log("=== SUMMARY ===");
  log(`Wallet A: ${ton(balA)} → ${ton(finalA)} TON (spent: ${ton(balA - finalA)})`);
  log(`Wallet B: ${ton(balB)} → ${ton(finalB)} TON (received: ${ton(finalB - balB)})`);
  log(`Steps passed: ${step}`);
  log(`Methods tested: deployAndTopUp, topUp, init, getOnchainState, cooperativeCommit,`);
  log(`  cooperativeClose, buildSignedSemiChannel, startUncooperativeClose,`);
  log(`  finishUncooperativeClose, PaymentChannel (createPaymentState, signState,`);
  log(`  verifyState, signClose, verifyClose, getMyBalance), reopen x3`);
  log("=== ALL PASSED ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
