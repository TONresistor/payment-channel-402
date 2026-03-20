import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyPairFromSeed } from "@ton/crypto";
import type { KeyPair } from "@ton/crypto";
import {
  buildPaymentRequired,
  buildPaymentResponse,
  type ChannelState,
  MemoryStorage,
  parsePaymentRequired,
  parsePaymentSignature,
  PaymentChannel,
} from "pc402-core";
import { createPC402Fetch } from "../src/client.js";
import { ChannelPool } from "../src/channel-pool.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeKeyPair(seed: number): KeyPair {
  return keyPairFromSeed(Buffer.alloc(32, seed));
}

const clientKP = makeKeyPair(1);
const serverKP = makeKeyPair(2);

const CHANNEL_ID = 42n;
const CHANNEL_ADDR = "EQTest_Channel_Address_000000000000000000000000000000";
const INIT_BALANCE_A = 1_000_000_000n; // 1 TON
const INIT_BALANCE_B = 0n;
const PRICE = 10_000_000n; // 0.01 TON

const SERVER_ADDR = "EQServer_Address_00000000000000000000000000000000000";

function makePaymentRequiredHeader(): string {
  return buildPaymentRequired({
    price: PRICE,
    serverPublicKey: serverKP.publicKey,
    serverAddress: SERVER_ADDR,
    channelAddress: CHANNEL_ADDR,
    channelId: CHANNEL_ID,
    initBalanceA: INIT_BALANCE_A,
    initBalanceB: INIT_BALANCE_B,
  });
}

/** Build a server-side PaymentChannel to verify client signatures. */
function makeServerChannel(): PaymentChannel {
  return new PaymentChannel({
    channelId: CHANNEL_ID,
    isA: false,
    myKeyPair: serverKP,
    hisPublicKey: clientKP.publicKey,
    initBalanceA: INIT_BALANCE_A,
    initBalanceB: INIT_BALANCE_B,
  });
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPC402Fetch", () => {
  it("passes through non-402 responses", async () => {
    const okResponse = new Response("ok", { status: 200 });
    mockFetch.mockResolvedValue(okResponse);

    const fetch402 = createPC402Fetch({ keyPair: clientKP });
    const res = await fetch402("https://api.example.com/data");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws on 402 without PAYMENT-REQUIRED header", async () => {
    const res402 = new Response("Payment Required", { status: 402 });
    mockFetch.mockResolvedValue(res402);

    const fetch402 = createPC402Fetch({ keyPair: clientKP });
    await expect(fetch402("https://api.example.com/data")).rejects.toThrow(
      "402 without PAYMENT-REQUIRED",
    );
  });

  it("throws on 402 with invalid PAYMENT-REQUIRED header", async () => {
    const res402 = new Response("Payment Required", {
      status: 402,
      headers: { "payment-required": "not-valid-base64!!!" },
    });
    mockFetch.mockResolvedValue(res402);

    const fetch402 = createPC402Fetch({ keyPair: clientKP });
    await expect(fetch402("https://api.example.com/data")).rejects.toThrow(
      "Invalid PAYMENT-REQUIRED",
    );
  });

  it("handles 402 -> payment -> 200 flow", async () => {
    const prHeader = makePaymentRequiredHeader();
    const serverChannel = makeServerChannel();

    // First call: 402 with payment requirements
    const res402 = new Response("Payment Required", {
      status: 402,
      headers: { "payment-required": prHeader },
    });

    // Second call: 200 with payment response (counter-signature)
    const counterSig = serverChannel.signState({
      balanceA: INIT_BALANCE_A - PRICE,
      balanceB: INIT_BALANCE_B + PRICE,
      seqnoA: 1,
      seqnoB: 0,
    });
    const prResponse = buildPaymentResponse({ counterSignature: counterSig });
    const res200 = new Response('{"data":"ok"}', {
      status: 200,
      headers: {
        "content-type": "application/json",
        "payment-response": prResponse,
      },
    });

    mockFetch.mockResolvedValueOnce(res402).mockResolvedValueOnce(res200);

    const storage = new MemoryStorage();
    const fetch402 = createPC402Fetch({ keyPair: clientKP, storage });
    const res = await fetch402("https://api.example.com/data");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify the retry request has PAYMENT-SIGNATURE header
    const retryCall = mockFetch.mock.calls[1];
    const retryInit = retryCall[1] as RequestInit;
    const retryHeaders = retryInit.headers as Headers;
    expect(retryHeaders.get("payment-signature")).toBeTruthy();

    // Verify the payment signature is valid
    const sigHeader = retryHeaders.get("payment-signature")!;
    const parsed = parsePaymentSignature(sigHeader);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload.channelAddress).toBe(CHANNEL_ADDR);
    expect(parsed!.payload.channelId).toBe(CHANNEL_ID.toString());
    expect(parsed!.payload.state.seqnoA).toBe(1);
  });

  it("persists state across requests", async () => {
    const prHeader = makePaymentRequiredHeader();
    const serverChannel = makeServerChannel();
    const storage = new MemoryStorage();
    const fetch402 = createPC402Fetch({ keyPair: clientKP, storage });

    // Helper: mock a 402 -> 200 cycle
    async function doPayment(expectedSeqno: number) {
      const expectedBalanceA = INIT_BALANCE_A - PRICE * BigInt(expectedSeqno);
      const expectedBalanceB = INIT_BALANCE_B + PRICE * BigInt(expectedSeqno);

      const res402 = new Response("Pay", {
        status: 402,
        headers: { "payment-required": prHeader },
      });

      const counterSig = serverChannel.signState({
        balanceA: expectedBalanceA,
        balanceB: expectedBalanceB,
        seqnoA: expectedSeqno,
        seqnoB: 0,
      });
      const res200 = new Response("ok", {
        status: 200,
        headers: { "payment-response": buildPaymentResponse({ counterSignature: counterSig }) },
      });

      mockFetch.mockResolvedValueOnce(res402).mockResolvedValueOnce(res200);
      const res = await fetch402("https://api.example.com/data");
      expect(res.status).toBe(200);

      // Verify seqno in payment header
      const retryHeaders = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][1]
        .headers as Headers;
      const parsed = parsePaymentSignature(retryHeaders.get("payment-signature")!);
      expect(parsed!.payload.state.seqnoA).toBe(expectedSeqno);
    }

    await doPayment(1);
    await doPayment(2);
    await doPayment(3);
  });

  it("includes initBalanceA/B in payment header", async () => {
    const prHeader = makePaymentRequiredHeader();
    const serverChannel = makeServerChannel();

    const counterSig = serverChannel.signState({
      balanceA: INIT_BALANCE_A - PRICE,
      balanceB: INIT_BALANCE_B + PRICE,
      seqnoA: 1,
      seqnoB: 0,
    });

    mockFetch
      .mockResolvedValueOnce(
        new Response("Pay", {
          status: 402,
          headers: { "payment-required": prHeader },
        }),
      )
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: { "payment-response": buildPaymentResponse({ counterSignature: counterSig }) },
        }),
      );

    const fetch402 = createPC402Fetch({ keyPair: clientKP });
    await fetch402("https://api.example.com/data");

    const retryHeaders = mockFetch.mock.calls[1][1].headers as Headers;
    const parsed = parsePaymentSignature(retryHeaders.get("payment-signature")!);
    expect(parsed!.payload.initBalanceA).toBe(INIT_BALANCE_A.toString());
    expect(parsed!.payload.initBalanceB).toBe(INIT_BALANCE_B.toString());
  });

  it("handles server's commitRequest and includes co-signature in next payment", async () => {
    const prHeader = makePaymentRequiredHeader();
    const serverChannel = makeServerChannel();
    const storage = new MemoryStorage();
    const fetch402 = createPC402Fetch({ keyPair: clientKP, storage });

    // First payment: server sends commitRequest
    const state1: ChannelState = {
      balanceA: INIT_BALANCE_A - PRICE,
      balanceB: INIT_BALANCE_B + PRICE,
      seqnoA: 1,
      seqnoB: 0,
    };

    const counterSig1 = serverChannel.signState(state1);
    const commitSig = serverChannel.signCommit(1n, 0n, PRICE, 0n, 0n, PRICE);

    const prResponse1 = buildPaymentResponse({
      counterSignature: counterSig1,
      commitRequest: {
        seqnoA: 1,
        seqnoB: 0,
        sentA: PRICE,
        sentB: 0n,
        withdrawA: 0n,
        withdrawB: PRICE,
        serverSignature: commitSig,
      },
    });

    mockFetch
      .mockResolvedValueOnce(
        new Response("Pay", {
          status: 402,
          headers: { "payment-required": prHeader },
        }),
      )
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: { "payment-response": prResponse1 },
        }),
      );

    await fetch402("https://api.example.com/data");

    // Second payment: should include commitSignature
    const state2: ChannelState = {
      balanceA: INIT_BALANCE_A - PRICE * 2n,
      balanceB: INIT_BALANCE_B + PRICE * 2n,
      seqnoA: 2,
      seqnoB: 0,
    };
    const counterSig2 = serverChannel.signState(state2);

    mockFetch
      .mockResolvedValueOnce(
        new Response("Pay", {
          status: 402,
          headers: { "payment-required": prHeader },
        }),
      )
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: {
            "payment-response": buildPaymentResponse({ counterSignature: counterSig2 }),
          },
        }),
      );

    await fetch402("https://api.example.com/data");

    // Verify the second retry includes commitSignature
    const retryHeaders = mockFetch.mock.calls[3][1].headers as Headers;
    const parsed = parsePaymentSignature(retryHeaders.get("payment-signature")!);
    expect(parsed!.payload.commitSignature).toBeTruthy();
  });

  it("forwards original request headers and init options", async () => {
    const prHeader = makePaymentRequiredHeader();
    const serverChannel = makeServerChannel();
    const counterSig = serverChannel.signState({
      balanceA: INIT_BALANCE_A - PRICE,
      balanceB: INIT_BALANCE_B + PRICE,
      seqnoA: 1,
      seqnoB: 0,
    });

    mockFetch
      .mockResolvedValueOnce(
        new Response("Pay", {
          status: 402,
          headers: { "payment-required": prHeader },
        }),
      )
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: { "payment-response": buildPaymentResponse({ counterSignature: counterSig }) },
        }),
      );

    const fetch402 = createPC402Fetch({ keyPair: clientKP });
    await fetch402("https://api.example.com/data", {
      method: "POST",
      headers: { "x-custom": "value", "content-type": "application/json" },
      body: '{"query":"test"}',
    });

    // Verify original headers are preserved in retry
    const retryInit = mockFetch.mock.calls[1][1] as RequestInit;
    const retryHeaders = retryInit.headers as Headers;
    expect(retryHeaders.get("x-custom")).toBe("value");
    expect(retryHeaders.get("content-type")).toBe("application/json");
    expect(retryInit.method).toBe("POST");
    expect(retryInit.body).toBe('{"query":"test"}');
  });
});

describe("ChannelPool", () => {
  it("creates and restores channels from storage", async () => {
    const storage = new MemoryStorage();
    const pool = new ChannelPool(clientKP, storage);

    const requirements = parsePaymentRequired(makePaymentRequiredHeader())!;

    // First call: creates new channel
    const entry1 = await pool.getOrCreate(requirements);
    expect(entry1.state.seqnoA).toBe(0);
    expect(entry1.state.balanceA).toBe(INIT_BALANCE_A);

    // Save state
    const newState: ChannelState = {
      balanceA: INIT_BALANCE_A - PRICE,
      balanceB: INIT_BALANCE_B + PRICE,
      seqnoA: 1,
      seqnoB: 0,
    };
    await pool.saveState(CHANNEL_ADDR, newState);

    // Second call: restores from storage
    const entry2 = await pool.getOrCreate(requirements);
    expect(entry2.state.seqnoA).toBe(1);
    expect(entry2.state.balanceA).toBe(INIT_BALANCE_A - PRICE);
  });

  it("lists and closes channels", async () => {
    const storage = new MemoryStorage();
    const pool = new ChannelPool(clientKP, storage);

    const requirements = parsePaymentRequired(makePaymentRequiredHeader())!;
    await pool.getOrCreate(requirements);

    const channels = await pool.listChannels();
    expect(channels).toContain(CHANNEL_ADDR);

    await pool.closeChannel(CHANNEL_ADDR);
    const channelsAfter = await pool.listChannels();
    expect(channelsAfter).not.toContain(CHANNEL_ADDR);
  });

  it("manages pending commit signatures", async () => {
    const storage = new MemoryStorage();
    const pool = new ChannelPool(clientKP, storage);

    const sig = Buffer.alloc(64, 0xab);
    await pool.savePendingCommit(CHANNEL_ADDR, sig);

    const popped = await pool.popPendingCommit(CHANNEL_ADDR);
    expect(popped).not.toBeNull();
    expect(popped!.equals(sig)).toBe(true);

    // Should be cleared after pop
    const popped2 = await pool.popPendingCommit(CHANNEL_ADDR);
    expect(popped2).toBeNull();
  });
});
