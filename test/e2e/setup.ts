/**
 * Shared setup for E2E mainnet tests.
 * Each test file creates its own channel — no shared state between tests.
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
import { OnchainChannel } from "pc402-channel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const ton = (n: bigint) => (Number(n) / 1e9).toFixed(4);

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.status === 429 || e?.response?.status === 429 || e?.message?.includes("429")) {
        await sleep((i + 1) * 3000);
      } else {
        throw e;
      }
    }
  }
  return fn();
}

export async function waitSeqno(
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
  throw new Error("Timeout waiting for seqno change");
}

export async function sendAndWait(
  wallet: ReturnType<typeof TonClient.prototype.open<WalletContractV5R1>>,
  action: () => Promise<void>,
) {
  const seq = await withRetry(() => wallet.getSeqno());
  await withRetry(action);
  await waitSeqno(wallet, seq);
  await sleep(5_000);
}

export async function waitDrained(client: TonClient, addr: Address, timeout = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const s = await client.getContractState(addr);
      if (s.state === "uninitialized" || s.state === "frozen" || s.balance < toNano("0.005"))
        return;
    } catch {
      return;
    }
    await sleep(3_000);
  }
  throw new Error("Timeout waiting for channel drain");
}

export async function waitActive(client: TonClient, addr: Address, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const s = await client.getContractState(addr);
      if (s.state === "active") return;
    } catch {}
    await sleep(3_000);
  }
  throw new Error("Timeout waiting for contract active");
}

export async function waitForChannelState(ch: OnchainChannel, expected: number, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const s = await withRetry(() => ch.getOnchainState());
      if (s.state === expected) return s;
    } catch {}
    await sleep(5_000);
  }
  return withRetry(() => ch.getOnchainState());
}

// ---------------------------------------------------------------------------
// Wallet + channel factory
// ---------------------------------------------------------------------------

export interface E2EContext {
  client: TonClient;
  keyPairA: KeyPair;
  keyPairB: KeyPair;
  walletA: ReturnType<typeof TonClient.prototype.open<WalletContractV5R1>>;
  walletB: ReturnType<typeof TonClient.prototype.open<WalletContractV5R1>>;
  senderA: ReturnType<ReturnType<typeof TonClient.prototype.open<WalletContractV5R1>>["sender"]>;
  senderB: ReturnType<ReturnType<typeof TonClient.prototype.open<WalletContractV5R1>>["sender"]>;
  addressA: Address;
  addressB: Address;
}

let _ctx: E2EContext | null = null;

export async function getContext(): Promise<E2EContext> {
  if (_ctx) return _ctx;

  const walletPath = resolve(__dirname, "../../.wallet.json");
  const walletData = JSON.parse(readFileSync(walletPath, "utf-8"));

  const client = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    apiKey: process.env.TONCENTER_API_KEY,
  });

  const keyPairA = await mnemonicToPrivateKey(walletData.walletA.mnemonic);
  const keyPairB = await mnemonicToPrivateKey(walletData.walletB.mnemonic);

  const walletContractA = WalletContractV5R1.create({ publicKey: keyPairA.publicKey });
  const walletContractB = WalletContractV5R1.create({ publicKey: keyPairB.publicKey });

  const walletA = client.open(walletContractA);
  const walletB = client.open(walletContractB);

  _ctx = {
    client,
    keyPairA,
    keyPairB,
    walletA,
    walletB,
    senderA: walletA.sender(keyPairA.secretKey),
    senderB: walletB.sender(keyPairB.secretKey),
    addressA: walletContractA.address,
    addressB: walletContractB.address,
  };
  return _ctx;
}

export function createChannel(
  ctx: E2EContext,
  opts?: { quarantineDuration?: number; conditionalCloseDuration?: number },
) {
  const channelId = BigInt(`0x${randomBytes(16).toString("hex")}`);

  const channel = new OnchainChannel({
    client: ctx.client,
    keyPairA: ctx.keyPairA,
    keyPairB: ctx.keyPairB,
    channelId,
    addressA: ctx.addressA,
    addressB: ctx.addressB,
    initBalanceA: 0n,
    initBalanceB: 0n,
    closingConfig: {
      quarantineDuration: opts?.quarantineDuration ?? 0,
      conditionalCloseDuration: opts?.conditionalCloseDuration ?? 0,
      misbehaviorFine: 0n,
    },
  });

  return { channel, channelId, address: channel.getAddress() };
}
