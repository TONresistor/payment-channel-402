import { Address, beginCell, type Cell } from "@ton/core";
import { type KeyPair, keyPairFromSeed, signVerify } from "@ton/crypto";
import { describe, expect, it } from "vitest";
import { createChannelStateInit } from "../src/contract.js";
import {
  buildSignedSemiChannel,
  OnchainChannel,
  OP_CHALLENGE_QUARANTINE,
  OP_COOPERATIVE_COMMIT,
  OP_FINISH_UNCOOPERATIVE_CLOSE,
  OP_SETTLE_CONDITIONALS,
  OP_START_UNCOOPERATIVE_CLOSE,
  TAG_CHALLENGE_QUARANTINE,
  TAG_COOPERATIVE_COMMIT,
  TAG_SETTLE_CONDITIONALS,
  TAG_START_UNCOOPERATIVE_CLOSE,
  TAG_STATE,
} from "../src/onchain.js";

// ---------------------------------------------------------------------------
// Helpers -- deterministic key pairs and addresses for testing
// ---------------------------------------------------------------------------

function makeKeyPair(seedByte: number): KeyPair {
  const seed = Buffer.alloc(32, seedByte);
  return keyPairFromSeed(seed);
}

const keyPairA = makeKeyPair(0xaa);
const keyPairB = makeKeyPair(0xbb);

// Build valid addresses from raw 32-byte hashes
const addressA = new Address(0, Buffer.alloc(32, 0xaa));
const addressB = new Address(0, Buffer.alloc(32, 0xbb));

const CHANNEL_ID = 123456789n;

/**
 * Build a minimal OnchainChannel for testing.
 * We pass a null-ish client since we only test message construction,
 * not on-chain calls.
 */
function makeChannel(): OnchainChannel {
  return new OnchainChannel({
    client: {} as any, // not used in message construction tests
    myKeyPair: keyPairA,
    counterpartyPublicKey: keyPairB.publicKey,
    isA: true,
    channelId: CHANNEL_ID,
    myAddress: addressA,
    counterpartyAddress: addressB,
    initBalanceA: 1_000_000_000n,
    initBalanceB: 0n,
  });
}

// ---------------------------------------------------------------------------
// Capture sender -- records what was sent
// ---------------------------------------------------------------------------

interface SentMessage {
  to: Address;
  value: bigint;
  body?: Cell;
  bounce?: boolean;
}

function captureSender(): { sender: any; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const sender = {
    send: async (msg: any) => {
      sent.push(msg);
    },
  };
  return { sender, sent };
}

// ===========================================================================
// cooperativeCommit
// ===========================================================================

describe("cooperativeCommit", () => {
  it("should produce a message with the correct opcode (0x076bfdf1)", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const sigA = ch.signCommit(10n, 20n, 0n, 0n, keyPairA);
    const sigB = ch.signCommit(10n, 20n, 0n, 0n, keyPairB);

    await ch.cooperativeCommit(sender, 10n, 20n, 0n, 0n, sigA, sigB);

    expect(sent).toHaveLength(1);
    const body = sent[0].body!;
    const slice = body.beginParse();

    expect(slice.loadUint(32)).toBe(OP_COOPERATIVE_COMMIT);
  });

  it("should store signatures as refs (512 bits each)", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const sigA = ch.signCommit(1n, 2n, 0n, 0n, keyPairA);
    const sigB = ch.signCommit(1n, 2n, 0n, 0n, keyPairB);

    await ch.cooperativeCommit(sender, 1n, 2n, 0n, 0n, sigA, sigB);

    const body = sent[0].body!;
    const slice = body.beginParse();

    slice.loadUint(32); // op

    // Two refs for signatures
    expect(slice.remainingRefs).toBeGreaterThanOrEqual(2);

    const sigARef = slice.loadRef().beginParse();
    expect(sigARef.remainingBits).toBe(512);
    const sigABuf = sigARef.loadBuffer(64);
    expect(sigABuf).toEqual(sigA);

    const sigBRef = slice.loadRef().beginParse();
    expect(sigBRef.remainingBits).toBe(512);
    const sigBBuf = sigBRef.loadBuffer(64);
    expect(sigBBuf).toEqual(sigB);
  });

  it("should include tag_commit + channelId + seqnoA + seqnoB + sentA + sentB + withdrawA + withdrawB after refs", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const sigA = ch.signCommit(5n, 10n, 0n, 0n, keyPairA);
    const sigB = ch.signCommit(5n, 10n, 0n, 0n, keyPairB);

    await ch.cooperativeCommit(sender, 5n, 10n, 0n, 0n, sigA, sigB);

    const body = sent[0].body!;
    const slice = body.beginParse();

    slice.loadUint(32); // op
    slice.loadRef(); // sigA ref
    slice.loadRef(); // sigB ref

    expect(slice.loadUint(32)).toBe(TAG_COOPERATIVE_COMMIT);
    expect(slice.loadUintBig(128)).toBe(CHANNEL_ID);
    expect(slice.loadUintBig(64)).toBe(5n); // seqnoA
    expect(slice.loadUintBig(64)).toBe(10n); // seqnoB
    // sentA and sentB
    expect(slice.loadCoins()).toBe(0n);
    expect(slice.loadCoins()).toBe(0n);
    // Default withdrawals = 0
    expect(slice.loadCoins()).toBe(0n);
    expect(slice.loadCoins()).toBe(0n);
  });

  it("should include non-zero withdrawal amounts when provided", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const withdrawA = 500_000_000n;
    const withdrawB = 300_000_000n;

    const sigA = ch.signCommit(5n, 10n, 0n, 0n, keyPairA, withdrawA, withdrawB);
    const sigB = ch.signCommit(5n, 10n, 0n, 0n, keyPairB, withdrawA, withdrawB);

    await ch.cooperativeCommit(sender, 5n, 10n, 0n, 0n, sigA, sigB, withdrawA, withdrawB);

    const body = sent[0].body!;
    const slice = body.beginParse();

    slice.loadUint(32); // op
    slice.loadRef(); // sigA ref
    slice.loadRef(); // sigB ref

    expect(slice.loadUint(32)).toBe(TAG_COOPERATIVE_COMMIT);
    expect(slice.loadUintBig(128)).toBe(CHANNEL_ID);
    expect(slice.loadUintBig(64)).toBe(5n); // seqnoA
    expect(slice.loadUintBig(64)).toBe(10n); // seqnoB
    // sentA and sentB (both 0n)
    expect(slice.loadCoins()).toBe(0n);
    expect(slice.loadCoins()).toBe(0n);
    expect(slice.loadCoins()).toBe(withdrawA);
    expect(slice.loadCoins()).toBe(withdrawB);
  });
});

// ===========================================================================
// signCommit
// ===========================================================================

describe("signCommit", () => {
  it("should return a 64-byte buffer", () => {
    const ch = makeChannel();
    const sig = ch.signCommit(1n, 2n, 0n, 0n, keyPairA);

    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64);
  });

  it("should produce a verifiable Ed25519 signature (default withdrawals = 0)", () => {
    const ch = makeChannel();
    const sig = ch.signCommit(3n, 7n, 0n, 0n, keyPairA);

    // Reconstruct the payload that was signed
    const payloadCell = beginCell()
      .storeUint(TAG_COOPERATIVE_COMMIT, 32)
      .storeUint(CHANNEL_ID, 128)
      .storeUint(3n, 64)
      .storeUint(7n, 64)
      .storeCoins(0n) // sentA
      .storeCoins(0n) // sentB
      .storeCoins(0n) // withdrawA
      .storeCoins(0n) // withdrawB
      .endCell();

    const ok = signVerify(payloadCell.hash(), sig, keyPairA.publicKey);
    expect(ok).toBe(true);
  });

  it("should produce a verifiable signature with non-zero withdrawals", () => {
    const ch = makeChannel();
    const withdrawA = 1_000_000_000n;
    const withdrawB = 500_000_000n;
    const sig = ch.signCommit(3n, 7n, 0n, 0n, keyPairA, withdrawA, withdrawB);

    const payloadCell = beginCell()
      .storeUint(TAG_COOPERATIVE_COMMIT, 32)
      .storeUint(CHANNEL_ID, 128)
      .storeUint(3n, 64)
      .storeUint(7n, 64)
      .storeCoins(0n) // sentA
      .storeCoins(0n) // sentB
      .storeCoins(withdrawA)
      .storeCoins(withdrawB)
      .endCell();

    const ok = signVerify(payloadCell.hash(), sig, keyPairA.publicKey);
    expect(ok).toBe(true);
  });

  it("should fail verification with wrong public key", () => {
    const ch = makeChannel();
    const sig = ch.signCommit(1n, 1n, 0n, 0n, keyPairA);

    const payloadCell = beginCell()
      .storeUint(TAG_COOPERATIVE_COMMIT, 32)
      .storeUint(CHANNEL_ID, 128)
      .storeUint(1n, 64)
      .storeUint(1n, 64)
      .storeCoins(0n)
      .storeCoins(0n)
      .storeCoins(0n)
      .storeCoins(0n)
      .endCell();

    const ok = signVerify(payloadCell.hash(), sig, keyPairB.publicKey);
    expect(ok).toBe(false);
  });

  it("should produce different signatures for different seqnos", () => {
    const ch = makeChannel();
    const sig1 = ch.signCommit(1n, 1n, 0n, 0n, keyPairA);
    const sig2 = ch.signCommit(2n, 1n, 0n, 0n, keyPairA);
    const sig3 = ch.signCommit(1n, 2n, 0n, 0n, keyPairA);

    expect(sig1.equals(sig2)).toBe(false);
    expect(sig1.equals(sig3)).toBe(false);
    expect(sig2.equals(sig3)).toBe(false);
  });

  it("should produce different signatures with different withdrawal amounts", () => {
    const ch = makeChannel();
    const sig1 = ch.signCommit(1n, 1n, 0n, 0n, keyPairA, 0n, 0n);
    const sig2 = ch.signCommit(1n, 1n, 0n, 0n, keyPairA, 100n, 0n);
    const sig3 = ch.signCommit(1n, 1n, 0n, 0n, keyPairA, 0n, 100n);

    expect(sig1.equals(sig2)).toBe(false);
    expect(sig1.equals(sig3)).toBe(false);
    expect(sig2.equals(sig3)).toBe(false);
  });
});

// ===========================================================================
// startUncooperativeClose
// ===========================================================================

describe("startUncooperativeClose", () => {
  it("should produce a message with the correct opcode (0x8175e15d)", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const dummySig = Buffer.alloc(64, 0x11);
    const schA = beginCell().storeUint(0, 8).endCell();
    const schB = beginCell().storeUint(0, 8).endCell();

    await ch.startUncooperativeClose(sender, true, dummySig, schA, schB);

    expect(sent).toHaveLength(1);
    const body = sent[0].body!;
    const slice = body.beginParse();

    expect(slice.loadUint(32)).toBe(OP_START_UNCOOPERATIVE_CLOSE);
  });

  it("should store signedByA bit, signature (512 bits inline), tag, channelId, and refs", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const dummySig = Buffer.alloc(64, 0x22);
    const schA = beginCell().storeUint(0xaa, 8).endCell();
    const schB = beginCell().storeUint(0xbb, 8).endCell();

    await ch.startUncooperativeClose(sender, true, dummySig, schA, schB);

    const body = sent[0].body!;
    const slice = body.beginParse();

    slice.loadUint(32); // op

    // signedByA bit
    expect(slice.loadBit()).toBe(true);

    // signature inline: 512 bits = 64 bytes
    const sigBuf = slice.loadBuffer(64);
    expect(sigBuf).toEqual(dummySig);

    // tag
    expect(slice.loadUint(32)).toBe(TAG_START_UNCOOPERATIVE_CLOSE);

    // channelId
    expect(slice.loadUintBig(128)).toBe(CHANNEL_ID);

    // refs: schA and schB
    expect(slice.remainingRefs).toBe(2);
    const refA = slice.loadRef().beginParse();
    expect(refA.loadUint(8)).toBe(0xaa);
    const refB = slice.loadRef().beginParse();
    expect(refB.loadUint(8)).toBe(0xbb);
  });

  it("should set signedByA=false when B initiates", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const dummySig = Buffer.alloc(64, 0x33);
    const schA = beginCell().endCell();
    const schB = beginCell().endCell();

    await ch.startUncooperativeClose(sender, false, dummySig, schA, schB);

    const slice = sent[0].body?.beginParse();
    slice.loadUint(32); // op
    expect(slice.loadBit()).toBe(false); // signedByA = false
  });
});

// ===========================================================================
// challengeQuarantinedState
// ===========================================================================

describe("challengeQuarantinedState", () => {
  it("should produce a message with the correct opcode (0x9a77c0db)", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const dummySig = Buffer.alloc(64, 0x44);
    const schA = beginCell().endCell();
    const schB = beginCell().endCell();

    await ch.challengeQuarantinedState(sender, true, dummySig, schA, schB);

    expect(sent).toHaveLength(1);
    const slice = sent[0].body?.beginParse();
    expect(slice.loadUint(32)).toBe(OP_CHALLENGE_QUARANTINE);
  });

  it("should use TAG_CHALLENGE_QUARANTINE (0xb8a21379) not TAG_START_UNCOOPERATIVE_CLOSE", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const dummySig = Buffer.alloc(64, 0x55);
    const schA = beginCell().endCell();
    const schB = beginCell().endCell();

    await ch.challengeQuarantinedState(sender, false, dummySig, schA, schB);

    const slice = sent[0].body?.beginParse();
    slice.loadUint(32); // op
    slice.loadBit(); // challengedByA
    slice.loadBuffer(64); // signature

    expect(slice.loadUint(32)).toBe(TAG_CHALLENGE_QUARANTINE);
    expect(slice.loadUintBig(128)).toBe(CHANNEL_ID);
  });

  it("should store challengedByA bit and refs correctly", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const dummySig = Buffer.alloc(64, 0x66);
    const schA = beginCell().storeUint(0xde, 8).endCell();
    const schB = beginCell().storeUint(0xad, 8).endCell();

    await ch.challengeQuarantinedState(sender, true, dummySig, schA, schB);

    const slice = sent[0].body?.beginParse();
    slice.loadUint(32); // op
    expect(slice.loadBit()).toBe(true); // challengedByA
    slice.loadBuffer(64); // signature
    slice.loadUint(32); // tag
    slice.loadUintBig(128); // channelId

    expect(slice.remainingRefs).toBe(2);
    const refA = slice.loadRef().beginParse();
    expect(refA.loadUint(8)).toBe(0xde);
    const refB = slice.loadRef().beginParse();
    expect(refB.loadUint(8)).toBe(0xad);
  });
});

// ===========================================================================
// settleConditionals
// ===========================================================================

describe("settleConditionals", () => {
  it("should produce a message with the correct opcode (0x56c39b4c)", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const dummySig = Buffer.alloc(64, 0x77);
    // Empty HashmapE (just a 0 bit)
    const emptyDict = beginCell().storeBit(0).endCell();

    await ch.settleConditionals(sender, true, dummySig, emptyDict);

    expect(sent).toHaveLength(1);
    const slice = sent[0].body?.beginParse();
    expect(slice.loadUint(32)).toBe(OP_SETTLE_CONDITIONALS);
  });

  it("should store fromA bit, signature, tag, channelId, and conditionals", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    const dummySig = Buffer.alloc(64, 0x88);
    const emptyDict = beginCell().storeBit(0).endCell();

    await ch.settleConditionals(sender, false, dummySig, emptyDict);

    const slice = sent[0].body?.beginParse();

    slice.loadUint(32); // op
    expect(slice.loadBit()).toBe(false); // fromA
    const sigBuf = slice.loadBuffer(64);
    expect(sigBuf).toEqual(dummySig);

    expect(slice.loadUint(32)).toBe(TAG_SETTLE_CONDITIONALS);
    expect(slice.loadUintBig(128)).toBe(CHANNEL_ID);

    // Conditionals stored as ref in v2
    const condRef = slice.loadRef();
    expect(condRef.hash()).toEqual(emptyDict.hash());
  });
});

// ===========================================================================
// finishUncooperativeClose
// ===========================================================================

describe("finishUncooperativeClose", () => {
  it("should produce a message with just the opcode (0x25432a91)", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    await ch.finishUncooperativeClose(sender);

    expect(sent).toHaveLength(1);
    const body = sent[0].body!;
    const slice = body.beginParse();

    expect(slice.loadUint(32)).toBe(OP_FINISH_UNCOOPERATIVE_CLOSE);
    // Nothing else
    expect(slice.remainingBits).toBe(0);
    expect(slice.remainingRefs).toBe(0);
  });

  it("should send with bounce=true", async () => {
    const ch = makeChannel();
    const { sender, sent } = captureSender();

    await ch.finishUncooperativeClose(sender);

    expect(sent[0].bounce).toBe(true);
  });
});

// ===========================================================================
// buildSignedSemiChannel (v2 layout)
// ===========================================================================

describe("buildSignedSemiChannel", () => {
  it("should produce a cell with 512-bit signature inline and body ref", () => {
    const cell = buildSignedSemiChannel(
      CHANNEL_ID,
      5n, // seqno (bigint)
      1_000_000n, // sentCoins
      keyPairA,
    );

    const slice = cell.beginParse();

    // Signature inline: 512 bits = 64 bytes
    const sigBuf = slice.loadBuffer(64);
    expect(sigBuf.length).toBe(64);

    // Body in a single ref
    expect(slice.remainingRefs).toBe(1);
    const bodySlice = slice.loadRef().beginParse();

    // tag_state
    expect(bodySlice.loadUint(32)).toBe(TAG_STATE);
    // channelId
    expect(bodySlice.loadUintBig(128)).toBe(CHANNEL_ID);
    // seqno
    expect(bodySlice.loadUintBig(64)).toBe(5n);
    // sentCoins
    expect(bodySlice.loadCoins()).toBe(1_000_000n);
    // conditionalsHash = 0
    expect(bodySlice.loadUintBig(256)).toBe(0n);
  });

  it("should have a verifiable signature over the body ref hash", () => {
    const cell = buildSignedSemiChannel(CHANNEL_ID, 10n, 2_000_000n, keyPairA);

    const slice = cell.beginParse();
    const sigBuf = slice.loadBuffer(64);
    const bodyRef = slice.loadRef();

    // The signature is over the body cell's hash
    const ok = signVerify(bodyRef.hash(), sigBuf, keyPairA.publicKey);
    expect(ok).toBe(true);
  });

  it("should produce different output for different keys", () => {
    const cellA = buildSignedSemiChannel(CHANNEL_ID, 1n, 100n, keyPairA);
    const cellB = buildSignedSemiChannel(CHANNEL_ID, 1n, 100n, keyPairB);

    // The cells should differ (different signatures)
    expect(cellA.hash().equals(cellB.hash())).toBe(false);
  });

  it("should produce different output for different seqnos", () => {
    const cell1 = buildSignedSemiChannel(CHANNEL_ID, 1n, 100n, keyPairA);
    const cell2 = buildSignedSemiChannel(CHANNEL_ID, 2n, 100n, keyPairA);

    expect(cell1.hash().equals(cell2.hash())).toBe(false);
  });
});

// ===========================================================================
// Storage layout — v2 data cell
// ===========================================================================

describe("storage layout (v2 Balance ref)", () => {
  it("data cell should have Balance ref with 6 coin fields all zero", () => {
    const stateInit = createChannelStateInit({
      publicKeyA: keyPairA.publicKey,
      publicKeyB: keyPairB.publicKey,
      channelId: CHANNEL_ID,
      addressA,
      addressB,
    });

    const data = stateInit.data!;
    const slice = data.beginParse();

    // inited (1 bit signed)
    expect(slice.loadBit()).toBe(false);

    // ^Balance ref: depositA depositB withdrawnA withdrawnB sentA sentB
    const balanceRef = slice.loadRef().beginParse();
    expect(balanceRef.loadCoins()).toBe(0n); // depositA
    expect(balanceRef.loadCoins()).toBe(0n); // depositB
    expect(balanceRef.loadCoins()).toBe(0n); // withdrawnA
    expect(balanceRef.loadCoins()).toBe(0n); // withdrawnB
    expect(balanceRef.loadCoins()).toBe(0n); // sentA
    expect(balanceRef.loadCoins()).toBe(0n); // sentB

    // key_A (256 bits)
    slice.loadBuffer(32);
    // key_B (256 bits)
    slice.loadBuffer(32);
    // channel_id (128 bits)
    expect(slice.loadUintBig(128)).toBe(CHANNEL_ID);

    // ^ClosureConfig ref
    slice.loadRef();

    // committed_seqno_A (uint64)
    expect(slice.loadUintBig(64)).toBe(0n);
    // committed_seqno_B (uint64)
    expect(slice.loadUintBig(64)).toBe(0n);

    // quarantin (Maybe = 0)
    expect(slice.loadBit()).toBe(false);

    // ^PaymentConfig ref: storageFee(Coins) + addrA + addrB
    const paymentConfig = slice.loadRef().beginParse();
    expect(paymentConfig.loadCoins()).toBe(10_000_000n); // storageFee default (0.01 TON)
  });
});

// ===========================================================================
// isA symmetry — both sides must compute the same channel address
// ===========================================================================

describe("isA symmetry", () => {
  it("isA=true and isA=false with mirrored params should produce the same channel address", () => {
    const channelAsA = new OnchainChannel({
      client: {} as any,
      myKeyPair: keyPairA,
      counterpartyPublicKey: keyPairB.publicKey,
      isA: true,
      channelId: CHANNEL_ID,
      myAddress: addressA,
      counterpartyAddress: addressB,
      initBalanceA: 1_000_000_000n,
      initBalanceB: 0n,
    });

    const channelAsB = new OnchainChannel({
      client: {} as any,
      myKeyPair: keyPairB,
      counterpartyPublicKey: keyPairA.publicKey,
      isA: false,
      channelId: CHANNEL_ID,
      myAddress: addressB,
      counterpartyAddress: addressA,
      initBalanceA: 1_000_000_000n,
      initBalanceB: 0n,
    });

    expect(channelAsA.getAddress().equals(channelAsB.getAddress())).toBe(true);
    expect(channelAsA.getIsA()).toBe(true);
    expect(channelAsB.getIsA()).toBe(false);
  });
});

// ===========================================================================
// Gas values
// ===========================================================================

describe("gas values", () => {
  it("all new operations should use 0.008 TON gas (optimized)", async () => {
    const ch = makeChannel();
    const dummySig = Buffer.alloc(64, 0x00);

    // cooperativeCommit
    {
      const { sender, sent } = captureSender();
      await ch.cooperativeCommit(sender, 1n, 1n, 0n, 0n, dummySig, dummySig);
      expect(sent[0].value).toBe(8_000_000n);
    }

    // startUncooperativeClose
    {
      const { sender, sent } = captureSender();
      const emptyCell = beginCell().endCell();
      await ch.startUncooperativeClose(sender, true, dummySig, emptyCell, emptyCell);
      expect(sent[0].value).toBe(8_000_000n);
    }

    // challengeQuarantinedState
    {
      const { sender, sent } = captureSender();
      const emptyCell = beginCell().endCell();
      await ch.challengeQuarantinedState(sender, true, dummySig, emptyCell, emptyCell);
      expect(sent[0].value).toBe(8_000_000n);
    }

    // settleConditionals
    {
      const { sender, sent } = captureSender();
      const emptyDict = beginCell().storeBit(0).endCell();
      await ch.settleConditionals(sender, true, dummySig, emptyDict);
      expect(sent[0].value).toBe(8_000_000n);
    }

    // finishUncooperativeClose
    {
      const { sender, sent } = captureSender();
      await ch.finishUncooperativeClose(sender);
      expect(sent[0].value).toBe(8_000_000n);
    }
  });
});
