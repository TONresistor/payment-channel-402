/**
 * E2E mainnet — 800 bidirectional off-chain payments
 *
 * Tests: PaymentChannel (createPaymentState, signState, verifyState,
 *        signClose, verifyClose, getMyBalance), cooperativeClose with final state
 *
 * 4 waves:
 *   Wave 1: A→B x200 (small amounts)
 *   Wave 2: B→A x100 (double amounts, nets to zero)
 *   Wave 3: A↔B x200 rounds asymmetric (B accumulates)
 *   Wave 4: B→A x100 (drain B back to A, round-trip verified)
 *
 * Run: npx vitest run test/e2e/offchain-payments.test.ts
 */

import { toNano } from "@ton/core";
import type { ChannelState } from "pc402-core";
import { balanceToSentCoins, PaymentChannel } from "pc402-core";
import { describe, expect, it } from "vitest";
import {
  createChannel,
  getContext,
  sendAndWait,
  waitActive,
  waitDrained,
  waitForChannelState,
} from "./setup.js";

describe("e2e mainnet: off-chain payments", { timeout: 120_000 }, () => {
  it("800 bidirectional payments then cooperativeClose with round-trip verification", async () => {
    const ctx = await getContext();
    const { channel, channelId, address } = createChannel(ctx);
    const depositA = toNano("0.05");

    // Deploy + Init
    await sendAndWait(ctx.walletA, () => channel.deployAndTopUp(ctx.senderA, true, depositA));
    await waitActive(ctx.client, address);
    await sendAndWait(ctx.walletA, () => channel.init(ctx.senderA, depositA, 0n, ctx.keyPairA));
    await waitForChannelState(channel, 1);

    // PaymentChannel instances
    const pcA = new PaymentChannel({
      channelId,
      isA: true,
      myKeyPair: ctx.keyPairA,
      hisPublicKey: ctx.keyPairB.publicKey,
      initBalanceA: depositA,
      initBalanceB: 0n,
    });
    const pcB = new PaymentChannel({
      channelId,
      isA: false,
      myKeyPair: ctx.keyPairB,
      hisPublicKey: ctx.keyPairA.publicKey,
      initBalanceA: depositA,
      initBalanceB: 0n,
    });

    let cur: ChannelState = { balanceA: depositA, balanceB: 0n, seqnoA: 0, seqnoB: 0 };
    const t0 = Date.now();

    // Wave 1: A→B x200 (0.0001 each = 0.02 total)
    for (let i = 0; i < 200; i++) {
      cur = pcA.createPaymentState(cur, toNano("0.0001"));
      const sig = pcA.signState(cur);
      expect(pcB.verifyState(cur, sig)).toBe(true);
    }

    // Wave 2: B→A x100 (0.0002 each = 0.02 total, nets wave 1)
    for (let i = 0; i < 100; i++) {
      cur = pcB.createPaymentState(cur, toNano("0.0002"));
      const sig = pcB.signState(cur);
      expect(pcA.verifyState(cur, sig)).toBe(true);
    }

    // Wave 3: A↔B x200 rounds asymmetric (A sends 0.0001, B sends 0.00005 back)
    // Net per round: B gains 0.00005. Total: B gains 0.01
    for (let i = 0; i < 200; i++) {
      cur = pcA.createPaymentState(cur, toNano("0.0001"));
      let sig = pcA.signState(cur);
      expect(pcB.verifyState(cur, sig)).toBe(true);
      cur = pcB.createPaymentState(cur, toNano("0.00005"));
      sig = pcB.signState(cur);
      expect(pcA.verifyState(cur, sig)).toBe(true);
    }

    // Wave 4: B→A x100 (drain B completely)
    const bBal = pcB.getMyBalance(cur);
    expect(bBal).toBeGreaterThan(0n);
    const drainAmt = bBal / 100n;
    for (let i = 0; i < 99; i++) {
      cur = pcB.createPaymentState(cur, drainAmt);
      const sig = pcB.signState(cur);
      expect(pcA.verifyState(cur, sig)).toBe(true);
    }
    const rem = pcB.getMyBalance(cur);
    cur = pcB.createPaymentState(cur, rem);
    const lastSig = pcB.signState(cur);
    expect(pcA.verifyState(cur, lastSig)).toBe(true);

    const elapsed = Date.now() - t0;
    const totalTx = 200 + 100 + 400 + 100;

    // Round-trip: A has everything, B has 0
    expect(pcA.getMyBalance(cur)).toBe(depositA);
    expect(pcB.getMyBalance(cur)).toBe(0n);

    console.log(`  ${totalTx} payments in ${elapsed}ms (${(elapsed / totalTx).toFixed(1)}ms/tx)`);
    console.log(`  seqnoA=${cur.seqnoA} seqnoB=${cur.seqnoB}`);

    // Close with final state
    const sentA = balanceToSentCoins(depositA, cur.balanceA);
    const sentB = balanceToSentCoins(0n, cur.balanceB);

    // Verify PaymentChannel signClose/verifyClose
    const pcSigA = pcA.signClose(cur);
    const pcSigB = pcB.signClose(cur);
    expect(pcA.verifyClose(cur, pcSigB)).toBe(true);
    expect(pcB.verifyClose(cur, pcSigA)).toBe(true);

    // Close on-chain
    const closeSigA = channel.signClose(sentA, sentB, ctx.keyPairA);
    const closeSigB = channel.signClose(sentA, sentB, ctx.keyPairB);
    await sendAndWait(ctx.walletA, () =>
      channel.cooperativeClose(ctx.senderA, sentA, sentB, closeSigA, closeSigB),
    );
    await waitDrained(ctx.client, address);

    const state = await waitForChannelState(channel, 0);
    expect(state.state).toBe(0);
  });
});
