/**
 * pc402-core — Protocol helpers unit tests
 *
 * Tests for all encode/decode, build/parse, and verification functions
 * in protocol.ts. Uses real Ed25519 keypairs and PaymentChannel for
 * signature operations.
 */

import { keyPairFromSeed } from "@ton/crypto";
import { describe, expect, it } from "vitest";
import { PaymentChannel } from "../src/channel.js";
import {
  buildPaymentError,
  buildPaymentRequired,
  buildPaymentResponse,
  buildPaymentSignature,
  decodeHeader,
  encodeHeader,
  parsePaymentRequired,
  parsePaymentResponse,
  parsePaymentSignature,
  verifyPaymentSignature,
} from "../src/protocol.js";
import type { ChannelConfig, ChannelState } from "../src/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_ADDRESS = "EQAbc123testChannelAddress000000";
const SERVER_ADDRESS = "EQServerWalletAddress0000000000000";
const CHANNEL_ID = 42_000_000n;
const INIT_BALANCE_A = 1_000_000_000n; // 1 TON
const INIT_BALANCE_B = 0n;
const PRICE = 10_000_000n; // 0.01 TON

function makeKeyPair(seed: number) {
  return keyPairFromSeed(Buffer.alloc(32, seed));
}

const clientKeyPair = makeKeyPair(0x02);
const serverKeyPair = makeKeyPair(0x01);

const clientConfig: ChannelConfig = {
  channelId: CHANNEL_ID,
  isA: true,
  myKeyPair: clientKeyPair,
  hisPublicKey: Buffer.from(serverKeyPair.publicKey),
  initBalanceA: INIT_BALANCE_A,
  initBalanceB: INIT_BALANCE_B,
};

const serverConfig: ChannelConfig = {
  channelId: CHANNEL_ID,
  isA: false,
  myKeyPair: serverKeyPair,
  hisPublicKey: Buffer.from(clientKeyPair.publicKey),
  initBalanceA: INIT_BALANCE_A,
  initBalanceB: INIT_BALANCE_B,
};

const clientChannel = new PaymentChannel(clientConfig);
const serverChannel = new PaymentChannel(serverConfig);

const INITIAL_STATE: ChannelState = {
  balanceA: INIT_BALANCE_A,
  balanceB: 0n,
  seqnoA: 0,
  seqnoB: 0,
};

// ---------------------------------------------------------------------------
// 1. encodeHeader / decodeHeader round-trip
// ---------------------------------------------------------------------------

describe("encodeHeader / decodeHeader", () => {
  it("round-trip with plain object", () => {
    const obj = { hello: "world", num: 42, nested: { a: true } };
    const encoded = encodeHeader(obj);
    const decoded = decodeHeader<typeof obj>(encoded);
    expect(decoded).toEqual(obj);
  });

  it("round-trip with array", () => {
    const arr = [1, "two", null, { x: 3 }];
    const encoded = encodeHeader(arr);
    const decoded = decodeHeader<typeof arr>(encoded);
    expect(decoded).toEqual(arr);
  });

  it("returns null for invalid base64", () => {
    expect(decodeHeader("!!!NOT_VALID_BASE64!!!")).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    const notJson = Buffer.from("this is not json", "utf-8").toString("base64");
    expect(decodeHeader(notJson)).toBeNull();
  });

  it("handles empty object", () => {
    const encoded = encodeHeader({});
    expect(decodeHeader(encoded)).toEqual({});
  });

  it("handles strings with unicode", () => {
    const obj = { emoji: "hello world", cyrillic: "\u041F\u0440\u0438\u0432\u0435\u0442" };
    const encoded = encodeHeader(obj);
    expect(decodeHeader<typeof obj>(encoded)).toEqual(obj);
  });
});

// ---------------------------------------------------------------------------
// 2. buildPaymentRequired / parsePaymentRequired round-trip
// ---------------------------------------------------------------------------

describe("buildPaymentRequired / parsePaymentRequired", () => {
  it("round-trip preserves all fields (with channel)", () => {
    const header = buildPaymentRequired({
      price: PRICE,
      serverPublicKey: Buffer.from(serverKeyPair.publicKey),
      serverAddress: SERVER_ADDRESS,
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID,
      initBalanceA: INIT_BALANCE_A,
      initBalanceB: INIT_BALANCE_B,
    });

    const parsed = parsePaymentRequired(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.scheme).toBe("pc402");
    expect(parsed?.network).toBe("ton:-239");
    expect(parsed?.asset).toBe("TON");
    expect(parsed?.amount).toBe(PRICE.toString());
    expect(parsed?.payee.publicKey).toBe(Buffer.from(serverKeyPair.publicKey).toString("hex"));
    expect(parsed?.payee.address).toBe(SERVER_ADDRESS);
    expect(parsed?.channel?.address).toBe(CHANNEL_ADDRESS);
    expect(parsed?.channel?.channelId).toBe(CHANNEL_ID.toString());
    expect(parsed?.channel?.initBalanceA).toBe(INIT_BALANCE_A.toString());
    expect(parsed?.channel?.initBalanceB).toBe(INIT_BALANCE_B.toString());
  });

  it("discovery mode (no channel) — payee present, channel absent", () => {
    const header = buildPaymentRequired({
      price: PRICE,
      serverPublicKey: Buffer.from(serverKeyPair.publicKey),
      serverAddress: SERVER_ADDRESS,
    });

    const parsed = parsePaymentRequired(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.payee.publicKey).toBe(Buffer.from(serverKeyPair.publicKey).toString("hex"));
    expect(parsed?.channel).toBeUndefined();
  });

  it("custom network and asset", () => {
    const header = buildPaymentRequired({
      price: 1n,
      serverPublicKey: Buffer.from(serverKeyPair.publicKey),
      serverAddress: SERVER_ADDRESS,
      channelAddress: "addr",
      channelId: 1n,
      initBalanceA: 100n,
      network: "ton:testnet",
      asset: "JETTON",
    });

    const parsed = parsePaymentRequired(header);
    expect(parsed?.network).toBe("ton:testnet");
    expect(parsed?.asset).toBe("JETTON");
  });

  it("returns null for non-pc402 scheme", () => {
    const badHeader = encodeHeader({ scheme: "other", amount: "100" });
    expect(parsePaymentRequired(badHeader)).toBeNull();
  });

  it("returns null for missing payee", () => {
    const badHeader = encodeHeader({ scheme: "pc402", amount: "100", network: "ton:-239" });
    expect(parsePaymentRequired(badHeader)).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parsePaymentRequired("GARBAGE")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. buildPaymentSignature / parsePaymentSignature round-trip
// ---------------------------------------------------------------------------

describe("buildPaymentSignature / parsePaymentSignature", () => {
  it("round-trip preserves all fields", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const signature = clientChannel.signState(state);

    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state,
      signature,
      publicKey: Buffer.from(clientKeyPair.publicKey),
    });

    const parsed = parsePaymentSignature(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.payload.channelAddress).toBe(CHANNEL_ADDRESS);
    expect(parsed?.payload.channelId).toBe(CHANNEL_ID.toString());
    expect(parsed?.payload.state.balanceA).toBe(state.balanceA.toString());
    expect(parsed?.payload.state.balanceB).toBe(state.balanceB.toString());
    expect(parsed?.payload.state.seqnoA).toBe(state.seqnoA);
    expect(parsed?.payload.state.seqnoB).toBe(state.seqnoB);
    expect(parsed?.payload.signature).toBe(signature.toString("base64"));
    expect(parsed?.payload.publicKey).toBe(Buffer.from(clientKeyPair.publicKey).toString("hex"));
  });

  it("returns null for non-pc402 envelope", () => {
    const bad = encodeHeader({ x402Version: 1, scheme: "other", payload: {} });
    expect(parsePaymentSignature(bad)).toBeNull();
  });

  it("returns null for missing payload", () => {
    const bad = encodeHeader({ x402Version: 2, scheme: "pc402" });
    expect(parsePaymentSignature(bad)).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parsePaymentSignature("NOT_BASE64!!!")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. buildPaymentResponse / parsePaymentResponse round-trip
// ---------------------------------------------------------------------------

describe("buildPaymentResponse / parsePaymentResponse", () => {
  it("round-trip preserves all fields", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const counterSig = serverChannel.signState(state);

    const header = buildPaymentResponse({
      counterSignature: counterSig,
    });

    const parsed = parsePaymentResponse(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.success).toBe(true);
    expect(parsed?.counterSignature).toBe(counterSig.toString("base64"));
    expect(parsed?.network).toBe("ton:-239");
  });

  it("custom network", () => {
    const header = buildPaymentResponse({
      counterSignature: Buffer.alloc(64, 0),
      network: "ton:testnet",
    });

    const parsed = parsePaymentResponse(header);
    expect(parsed?.network).toBe("ton:testnet");
  });

  it("returns null for malformed", () => {
    expect(parsePaymentResponse("GARBAGE")).toBeNull();
  });

  it("returns null for missing success field", () => {
    const bad = encodeHeader({ counterSignature: "abc", network: "ton:-239" });
    expect(parsePaymentResponse(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. verifyPaymentSignature — valid signature
// ---------------------------------------------------------------------------

describe("verifyPaymentSignature", () => {
  function buildValidHeader(
    state: ChannelState,
    overrides?: {
      channelAddress?: string;
      channelId?: string;
      signature?: Buffer;
      publicKey?: Buffer;
      balanceA?: string;
      balanceB?: string;
    },
  ): string {
    const sig = overrides?.signature ?? clientChannel.signState(state);
    return buildPaymentSignature({
      channelAddress: overrides?.channelAddress ?? CHANNEL_ADDRESS,
      channelId: overrides?.channelId ?? CHANNEL_ID.toString(),
      state: overrides?.balanceA
        ? {
            ...state,
            balanceA: BigInt(overrides.balanceA),
            balanceB: BigInt(overrides.balanceB ?? state.balanceB.toString()),
          }
        : state,
      signature: sig,
      publicKey: overrides?.publicKey ?? Buffer.from(clientKeyPair.publicKey),
    });
  }

  it("valid signature -> valid: true", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const header = buildValidHeader(state);

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(true);
    expect(result.state).toBeDefined();
    expect(result.state?.seqnoA).toBe(1);
    expect(result.state?.balanceA).toBe(INIT_BALANCE_A - PRICE);
    expect(result.paidAmount).toBe(PRICE);
  });

  // -------------------------------------------------------------------------
  // 6. invalid_signature
  // -------------------------------------------------------------------------

  it("invalid signature -> invalid_signature", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const badSig = Buffer.alloc(64, 0);
    const header = buildValidHeader(state, { signature: badSig });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("invalid_signature");
  });

  // -------------------------------------------------------------------------
  // 7. stale_seqno
  // -------------------------------------------------------------------------

  it("stale seqno -> stale_seqno", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const header = buildValidHeader(state);

    // Last state has seqnoA=5, but our payment has seqnoA=1
    const lastState: ChannelState = {
      balanceA: INIT_BALANCE_A - PRICE * 5n,
      balanceB: PRICE * 5n,
      seqnoA: 5,
      seqnoB: 0,
    };

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      lastState,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("stale_seqno");
  });

  // -------------------------------------------------------------------------
  // 8. insufficient_payment
  // -------------------------------------------------------------------------

  it("insufficient payment -> insufficient_payment", () => {
    // Pay only 1 nanoton when price is 10_000_000
    const underpayState: ChannelState = {
      balanceA: INIT_BALANCE_A - 1n,
      balanceB: 1n,
      seqnoA: 1,
      seqnoB: 0,
    };
    const header = buildValidHeader(underpayState);

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("insufficient_payment");
  });

  // -------------------------------------------------------------------------
  // 9. balance_mismatch
  // -------------------------------------------------------------------------

  it("balance mismatch -> balance_mismatch", () => {
    // Create a channel with inflated initBalanceA so we can sign a state
    // that doesn't conserve balance from the server's perspective.
    const inflatedClientChannel = new PaymentChannel({
      channelId: CHANNEL_ID,
      isA: true,
      myKeyPair: clientKeyPair,
      hisPublicKey: Buffer.from(serverKeyPair.publicKey),
      initBalanceA: INIT_BALANCE_A * 2n,
      initBalanceB: INIT_BALANCE_B,
    });

    // balanceA + balanceB = 1.5B != 1B (server initTotal)
    const inflatedState: ChannelState = {
      balanceA: INIT_BALANCE_A + 500_000_000n,
      balanceB: 0n,
      seqnoA: 1,
      seqnoB: 0,
    };
    const sig = inflatedClientChannel.signState(inflatedState);
    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state: inflatedState,
      signature: sig,
      publicKey: Buffer.from(clientKeyPair.publicKey),
    });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("balance_mismatch");
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  it("unknown_channel when channelId mismatches", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const header = buildValidHeader(state, { channelId: "999999" });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("unknown_channel");
  });

  it("unknown_channel when channelAddress mismatches", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const header = buildValidHeader(state, { channelAddress: "EQwrongAddr" });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("unknown_channel");
  });

  it("invalid_payload for garbage header", () => {
    const result = verifyPaymentSignature(
      "THIS_IS_NOT_VALID!!!",
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("invalid_payload");
  });

  it("second payment with correct seqno -> valid", () => {
    // First payment: seqnoA=1
    const state1 = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    // Second payment: seqnoA=2
    const state2 = clientChannel.createPaymentState(state1, PRICE);
    const header2 = buildValidHeader(state2);

    const result = verifyPaymentSignature(
      header2,
      serverChannel,
      state1, // last accepted state
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(true);
    expect(result.state?.seqnoA).toBe(2);
    expect(result.paidAmount).toBe(PRICE);
  });

  it("overpayment is accepted", () => {
    // Pay 2x the price
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE * 2n);
    const header = buildValidHeader(state);

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(true);
    expect(result.paidAmount).toBe(PRICE * 2n);
  });
});

// ---------------------------------------------------------------------------
// Commit protocol (HTTP 402 cooperative commit)
// ---------------------------------------------------------------------------

describe("commit protocol", () => {
  it("should round-trip commitRequest through PAYMENT-RESPONSE", () => {
    const serverSig = serverChannel.signCommit(1n, 1n, PRICE, 0n, 0n, PRICE);

    const header = buildPaymentResponse({
      counterSignature: Buffer.alloc(64, 0xaa),
      commitRequest: {
        seqnoA: 1,
        seqnoB: 1,
        sentA: PRICE,
        sentB: 0n,
        withdrawA: 0n,
        withdrawB: PRICE,
        serverSignature: serverSig,
      },
    });

    const parsed = parsePaymentResponse(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.commitRequest).toBeDefined();
    expect(parsed?.commitRequest?.seqnoA).toBe(1);
    expect(parsed?.commitRequest?.seqnoB).toBe(1);
    expect(parsed?.commitRequest?.sentA).toBe(PRICE.toString());
    expect(parsed?.commitRequest?.withdrawB).toBe(PRICE.toString());
    expect(parsed?.commitRequest?.serverSignature).toBeTruthy();
  });

  it("should round-trip commitSignature through PAYMENT-SIGNATURE", () => {
    const commitSig = Buffer.alloc(64, 0xcc);

    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state: INITIAL_STATE,
      signature: Buffer.alloc(64, 0xbb),
      publicKey: clientKeyPair.publicKey,
      commitSignature: commitSig,
    });

    const parsed = parsePaymentSignature(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.payload.commitSignature).toBeTruthy();
    const decoded = Buffer.from(parsed!.payload.commitSignature!, "base64");
    expect(decoded).toEqual(commitSig);
  });

  it("should be backward compatible — no commitRequest in response", () => {
    const header = buildPaymentResponse({
      counterSignature: Buffer.alloc(64, 0xaa),
    });

    const parsed = parsePaymentResponse(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.commitRequest).toBeUndefined();
  });

  it("should be backward compatible — no commitSignature in payment", () => {
    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state: INITIAL_STATE,
      signature: Buffer.alloc(64, 0xbb),
      publicKey: clientKeyPair.publicKey,
    });

    const parsed = parsePaymentSignature(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.payload.commitSignature).toBeUndefined();
  });

  it("client should sign and server should verify commit", () => {
    const sentA = PRICE;
    const sentB = 0n;
    const withdrawB = PRICE;

    // Server signs commit (B side)
    const serverSig = serverChannel.signCommit(1n, 1n, sentA, sentB, 0n, withdrawB);

    // Client verifies server's signature
    const serverValid = clientChannel.verifyCommit(1n, 1n, sentA, sentB, serverSig, 0n, withdrawB);
    expect(serverValid).toBe(true);

    // Client co-signs (A side)
    const clientSig = clientChannel.signCommit(1n, 1n, sentA, sentB, 0n, withdrawB);

    // Server verifies client's co-signature
    const clientValid = serverChannel.verifyCommit(1n, 1n, sentA, sentB, clientSig, 0n, withdrawB);
    expect(clientValid).toBe(true);
  });

  it("should reject commit signature with wrong values", () => {
    const clientSig = clientChannel.signCommit(1n, 1n, PRICE, 0n, 0n, PRICE);

    // Verify with different sentA — should fail
    const valid = serverChannel.verifyCommit(1n, 1n, PRICE * 2n, 0n, clientSig, 0n, PRICE);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPaymentError
// ---------------------------------------------------------------------------

describe("buildPaymentError", () => {
  it("encodes a valid error response", () => {
    const header = buildPaymentError("insufficient_payment", "paid too little");
    const parsed = parsePaymentResponse(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.success).toBe(false);
    if (!parsed || parsed.success) return;
    expect(parsed.error).toBe("insufficient_payment");
    expect(parsed.errorMessage).toBe("paid too little");
    expect(parsed.network).toBe("ton:-239");
  });

  it("custom network", () => {
    const header = buildPaymentError("stale_seqno", "msg", "ton:testnet");
    const parsed = parsePaymentResponse(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.success).toBe(false);
    if (!parsed || parsed.success) return;
    expect(parsed.network).toBe("ton:testnet");
  });
});

// ---------------------------------------------------------------------------
// closeRequest round-trip
// ---------------------------------------------------------------------------

describe("closeRequest protocol", () => {
  it("should round-trip closeRequest through PAYMENT-RESPONSE", () => {
    const header = buildPaymentResponse({
      counterSignature: Buffer.alloc(64, 0xaa),
      closeRequest: {
        sentA: PRICE * 5n,
        sentB: 0n,
        serverSignature: Buffer.alloc(64, 0xef),
      },
    });

    const parsed = parsePaymentResponse(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.success).toBe(true);
    if (!parsed || !parsed.success) return;
    expect(parsed.closeRequest).toBeDefined();
    expect(parsed.closeRequest?.sentA).toBe((PRICE * 5n).toString());
    expect(parsed.closeRequest?.sentB).toBe("0");
    expect(parsed.closeRequest?.serverSignature).toBeTruthy();
  });

  it("should round-trip closeSignature through PAYMENT-SIGNATURE", () => {
    const closeSig = Buffer.alloc(64, 0xfe);

    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state: INITIAL_STATE,
      signature: Buffer.alloc(64, 0xbb),
      publicKey: clientKeyPair.publicKey,
      closeSignature: closeSig,
    });

    const parsed = parsePaymentSignature(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.payload.closeSignature).toBeTruthy();
    const decoded = Buffer.from(parsed!.payload.closeSignature!, "base64");
    expect(decoded).toEqual(closeSig);
  });
});

// ---------------------------------------------------------------------------
// verifyPaymentSignature — v0.2 checks
// ---------------------------------------------------------------------------

describe("verifyPaymentSignature v0.2", () => {
  function buildValidHeader(state: ChannelState, pubKey?: Buffer): string {
    const sig = clientChannel.signState(state);
    return buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state,
      signature: sig,
      publicKey: pubKey ?? Buffer.from(clientKeyPair.publicKey),
    });
  }

  it("publicKey mismatch -> invalid_payload", () => {
    const wrongKeyPair = makeKeyPair(0x99);
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    // Build with wrong publicKey (but valid signature from clientChannel)
    const sig = clientChannel.signState(state);
    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state,
      signature: sig,
      publicKey: Buffer.from(wrongKeyPair.publicKey), // wrong key
    });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("invalid_payload");
    expect(result.errorMessage).toContain("counterparty");
  });

  it("seqnoB changed by client -> stale_seqno", () => {
    const lastState: ChannelState = {
      balanceA: INIT_BALANCE_A - PRICE,
      balanceB: PRICE,
      seqnoA: 1,
      seqnoB: 0,
    };
    // Client bumps seqnoB (not allowed)
    const badState: ChannelState = {
      balanceA: INIT_BALANCE_A - PRICE * 2n,
      balanceB: PRICE * 2n,
      seqnoA: 2,
      seqnoB: 1, // changed!
    };
    const sig = clientChannel.signState(badState);
    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state: badState,
      signature: sig,
      publicKey: Buffer.from(clientKeyPair.publicKey),
    });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      lastState,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBe("stale_seqno");
    expect(result.errorMessage).toContain("seqnoB");
  });

  it("commitSignature passthrough on valid payment", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const sig = clientChannel.signState(state);
    const commitSig = Buffer.alloc(64, 0xcc);

    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state,
      signature: sig,
      publicKey: Buffer.from(clientKeyPair.publicKey),
      commitSignature: commitSig,
    });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(true);
    expect(result.commitSignature).toBeTruthy();
    expect(Buffer.from(result.commitSignature!, "base64")).toEqual(commitSig);
  });

  it("closeSignature passthrough on valid payment", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const sig = clientChannel.signState(state);
    const closeSig = Buffer.alloc(64, 0xde);

    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state,
      signature: sig,
      publicKey: Buffer.from(clientKeyPair.publicKey),
      closeSignature: closeSig,
    });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(true);
    expect(result.closeSignature).toBeTruthy();
    expect(Buffer.from(result.closeSignature!, "base64")).toEqual(closeSig);
  });

  it("channelExhausted flag when balanceA reaches 0", () => {
    // Pay the entire balance in one shot
    const exhaustState: ChannelState = {
      balanceA: 0n,
      balanceB: INIT_BALANCE_A,
      seqnoA: 1,
      seqnoB: 0,
    };
    const sig = clientChannel.signState(exhaustState);
    const header = buildPaymentSignature({
      channelAddress: CHANNEL_ADDRESS,
      channelId: CHANNEL_ID.toString(),
      state: exhaustState,
      signature: sig,
      publicKey: Buffer.from(clientKeyPair.publicKey),
    });

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE, // price is small, but full balance was paid — still valid
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(true);
    expect(result.channelExhausted).toBe(true);
  });

  it("channelExhausted not set when balance > 0", () => {
    const state = clientChannel.createPaymentState(INITIAL_STATE, PRICE);
    const header = buildValidHeader(state);

    const result = verifyPaymentSignature(
      header,
      serverChannel,
      null,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    expect(result.valid).toBe(true);
    expect(result.channelExhausted).toBeUndefined();
  });
});
