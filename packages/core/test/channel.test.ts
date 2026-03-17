import { keyPairFromSeed } from "@ton/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PaymentChannel } from "../src/channel.js";
import type { ChannelConfig, ChannelState } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers — deterministic key pairs for testing
// ---------------------------------------------------------------------------

function makeKeyPair(seedByte: number) {
  const seed = Buffer.alloc(32, seedByte);
  return keyPairFromSeed(seed);
}

function makeChannelPair() {
  const keyA = makeKeyPair(0xaa);
  const keyB = makeKeyPair(0xbb);
  const channelId = 123456789n;
  const initBalanceA = 1_000_000_000n; // 1 TON
  const initBalanceB = 0n;

  const configA: ChannelConfig = {
    channelId,
    isA: true,
    myKeyPair: keyA,
    hisPublicKey: keyB.publicKey,
    initBalanceA,
    initBalanceB,
  };

  const configB: ChannelConfig = {
    channelId,
    isA: false,
    myKeyPair: keyB,
    hisPublicKey: keyA.publicKey,
    initBalanceA,
    initBalanceB,
  };

  const channelA = new PaymentChannel(configA);
  const channelB = new PaymentChannel(configB);

  return { channelA, channelB, keyA, keyB };
}

/**
 * A channel where both parties have deposits.
 */
function makeBidirectionalChannelPair() {
  const keyA = makeKeyPair(0xaa);
  const keyB = makeKeyPair(0xbb);
  const channelId = 987654321n;
  const initBalanceA = 500_000_000n;
  const initBalanceB = 500_000_000n;

  const configA: ChannelConfig = {
    channelId,
    isA: true,
    myKeyPair: keyA,
    hisPublicKey: keyB.publicKey,
    initBalanceA,
    initBalanceB,
  };

  const configB: ChannelConfig = {
    channelId,
    isA: false,
    myKeyPair: keyB,
    hisPublicKey: keyA.publicKey,
    initBalanceA,
    initBalanceB,
  };

  return {
    channelA: new PaymentChannel(configA),
    channelB: new PaymentChannel(configB),
  };
}

/**
 * Initial state: balanceX = initBalanceX (no payments yet).
 *
 * In the payment channel model, balanceA/B represent the current distribution
 * of funds. Conservation: balanceA + balanceB = initBalanceA + initBalanceB.
 * When A pays B: balanceA decreases, balanceB increases by the same amount.
 */
const INITIAL_STATE: ChannelState = {
  balanceA: 1_000_000_000n,
  balanceB: 0n,
  seqnoA: 0,
  seqnoB: 0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PaymentChannel", () => {
  // -----------------------------------------------------------------------
  // Sign / Verify round-trip
  // -----------------------------------------------------------------------

  describe("sign and verify round-trip", () => {
    it("A signs, B verifies (A->B)", () => {
      const { channelA, channelB } = makeChannelPair();

      // A makes a payment to B: A's balance decreases, B's increases
      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);
      expect(newState.balanceA).toBe(900_000_000n);
      expect(newState.balanceB).toBe(100_000_000n); // B receives

      const signature = channelA.signState(newState);
      expect(channelB.verifyState(newState, signature)).toBe(true);
    });

    it("B signs, A verifies (B->A)", () => {
      const { channelA, channelB } = makeBidirectionalChannelPair();

      const initialBidir: ChannelState = {
        balanceA: 500_000_000n,
        balanceB: 500_000_000n,
        seqnoA: 0,
        seqnoB: 0,
      };

      // B makes a payment to A
      const newState = channelB.createPaymentState(initialBidir, 100_000_000n);
      expect(newState.balanceA).toBe(600_000_000n); // A receives 100M
      expect(newState.balanceB).toBe(400_000_000n); // B sent 100M

      const signature = channelB.signState(newState);
      expect(channelA.verifyState(newState, signature)).toBe(true);
    });

    it("should reject signature from wrong key", () => {
      const { channelA, channelB } = makeChannelPair();
      // Create a third party with a different key
      const keyC = makeKeyPair(0xcc);

      const configC: ChannelConfig = {
        channelId: 123456789n,
        isA: true,
        myKeyPair: keyC,
        hisPublicKey: channelB.config.myKeyPair.publicKey,
        initBalanceA: 1_000_000_000n,
        initBalanceB: 0n,
      };
      const channelC = new PaymentChannel(configC);

      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);

      // C signs pretending to be A
      const badSignature = channelC.signState(newState);

      // B should reject C's signature (B expects A's key)
      expect(channelB.verifyState(newState, badSignature)).toBe(false);
    });

    it("should reject tampered state (balance changed)", () => {
      const { channelA, channelB } = makeChannelPair();

      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);
      const signature = channelA.signState(newState);

      // Tamper: change balanceA after signing
      const tamperedState: ChannelState = {
        ...newState,
        balanceA: newState.balanceA + 1n,
      };

      expect(channelB.verifyState(tamperedState, signature)).toBe(false);
    });

    it("should reject tampered seqno", () => {
      const { channelA, channelB } = makeChannelPair();

      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);
      const signature = channelA.signState(newState);

      const tamperedState: ChannelState = {
        ...newState,
        seqnoA: newState.seqnoA + 1,
      };

      expect(channelB.verifyState(tamperedState, signature)).toBe(false);
    });

    // Note: "should reject tampered balanceB" is intentionally absent in v2.
    // In v2, A signs only its own individual body (sentA = initBalanceA - balanceA).
    // Tampering balanceB does not change A's body hash, so A's signature remains
    // valid. This is correct by design — each party signs only their own state.
  });

  // -----------------------------------------------------------------------
  // signClose / verifyClose
  // -----------------------------------------------------------------------

  describe("signClose and verifyClose", () => {
    it("A signs close, B verifies", () => {
      const { channelA, channelB } = makeChannelPair();
      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);

      const closeSig = channelA.signClose(newState);
      expect(channelB.verifyClose(newState, closeSig)).toBe(true);
    });

    it("B signs close, A verifies", () => {
      const { channelA, channelB } = makeChannelPair();
      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);

      const closeSig = channelB.signClose(newState);
      expect(channelA.verifyClose(newState, closeSig)).toBe(true);
    });

    it("close signature should not validate as state signature", () => {
      const { channelA, channelB } = makeChannelPair();
      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);

      const closeSig = channelA.signClose(newState);
      // Close sig uses TAG_CLOSE, regular verify uses TAG_STATE — must not match
      expect(channelB.verifyState(newState, closeSig)).toBe(false);
    });

    it("state signature should not validate as close signature", () => {
      const { channelA, channelB } = makeChannelPair();
      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);

      const stateSig = channelA.signState(newState);
      expect(channelB.verifyClose(newState, stateSig)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // createPaymentState
  // -----------------------------------------------------------------------

  describe("createPaymentState", () => {
    it("should increment seqnoA when A pays", () => {
      const { channelA } = makeChannelPair();
      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);

      expect(newState.seqnoA).toBe(1);
      expect(newState.seqnoB).toBe(0); // unchanged
    });

    it("should transfer from payer to receiver when A pays", () => {
      const { channelA } = makeChannelPair();
      const payment = 100_000_000n;
      const newState = channelA.createPaymentState(INITIAL_STATE, payment);

      expect(newState.balanceA).toBe(INITIAL_STATE.balanceA - payment);
      expect(newState.balanceB).toBe(INITIAL_STATE.balanceB + payment); // B receives
    });

    it("should increment seqnoB when B pays", () => {
      const { channelB } = makeBidirectionalChannelPair();
      const state: ChannelState = {
        balanceA: 500_000_000n,
        balanceB: 500_000_000n,
        seqnoA: 5,
        seqnoB: 3,
      };
      const newState = channelB.createPaymentState(state, 50_000_000n);

      expect(newState.seqnoA).toBe(5); // unchanged
      expect(newState.seqnoB).toBe(4);
      expect(newState.balanceA).toBe(550_000_000n); // A receives 50M
      expect(newState.balanceB).toBe(450_000_000n); // B paid 50M
    });

    it("should throw on insufficient balance", () => {
      const { channelA } = makeChannelPair();
      expect(() => channelA.createPaymentState(INITIAL_STATE, 2_000_000_000n)).toThrow(
        "Insufficient balance",
      );
    });

    it("should throw on zero or negative amount", () => {
      const { channelA } = makeChannelPair();
      expect(() => channelA.createPaymentState(INITIAL_STATE, 0n)).toThrow(
        "Payment amount must be positive",
      );
      expect(() => channelA.createPaymentState(INITIAL_STATE, -1n)).toThrow(
        "Payment amount must be positive",
      );
    });

    it("should handle multiple sequential payments with sign/verify", () => {
      const { channelA, channelB } = makeChannelPair();

      let state = INITIAL_STATE;

      // A pays B three times, 100M each
      for (let i = 0; i < 3; i++) {
        state = channelA.createPaymentState(state, 100_000_000n);
        const sig = channelA.signState(state);
        expect(channelB.verifyState(state, sig)).toBe(true);
      }

      expect(state.seqnoA).toBe(3);
      expect(state.balanceA).toBe(700_000_000n); // 1000M - 3*100M
      expect(state.balanceB).toBe(300_000_000n); // 0 + 3*100M (B received)
    });

    it("should allow paying down to zero", () => {
      const { channelA, channelB } = makeChannelPair();

      const newState = channelA.createPaymentState(INITIAL_STATE, 1_000_000_000n);
      expect(newState.balanceA).toBe(0n);
      expect(newState.balanceB).toBe(1_000_000_000n); // B gets everything

      const sig = channelA.signState(newState);
      expect(channelB.verifyState(newState, sig)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getMyBalance
  // -----------------------------------------------------------------------

  describe("getMyBalance", () => {
    it("should return actual balance for A (initBalanceA for initial state)", () => {
      const { channelA } = makeChannelPair();
      // Initial: A has 1 TON
      expect(channelA.getMyBalance(INITIAL_STATE)).toBe(1_000_000_000n);
    });

    it("should return actual balance for B (0 for initial state with no deposit)", () => {
      const { channelB } = makeChannelPair();
      // Initial: B has 0
      expect(channelB.getMyBalance(INITIAL_STATE)).toBe(0n);
    });

    it("should reflect payments correctly", () => {
      const { channelA, channelB } = makeChannelPair();
      const newState = channelA.createPaymentState(INITIAL_STATE, 100_000_000n);

      // After A pays 100M to B:
      // balanceA = 900M, balanceB = 100M
      expect(channelA.getMyBalance(newState)).toBe(900_000_000n);
      expect(channelB.getMyBalance(newState)).toBe(100_000_000n);
    });

    it("should conserve total balance", () => {
      const { channelA, channelB } = makeChannelPair();
      const total = channelA.config.initBalanceA + channelA.config.initBalanceB;

      let state = INITIAL_STATE;
      for (let i = 0; i < 5; i++) {
        state = channelA.createPaymentState(state, 50_000_000n);
        const actualA = channelA.getMyBalance(state);
        const actualB = channelB.getMyBalance(state);
        expect(actualA + actualB).toBe(total);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Config immutability
  // -----------------------------------------------------------------------

  describe("config", () => {
    it("should be frozen / read-only", () => {
      const { channelA } = makeChannelPair();
      expect(Object.isFrozen(channelA.config)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Bidirectional payments
  // -----------------------------------------------------------------------

  describe("bidirectional payments", () => {
    // Uses makeChannelPair: initBalanceA = 1 TON, initBalanceB = 0
    // Aliases for clarity
    let pcA: PaymentChannel;
    let pcB: PaymentChannel;
    const initialState = INITIAL_STATE;

    beforeEach(() => {
      const pair = makeChannelPair();
      pcA = pair.channelA;
      pcB = pair.channelB;
    });

    it("A pays B: balanceB should increase", () => {
      // After A pays 0.3 TON
      const state = pcA.createPaymentState(initialState, 300_000_000n);
      expect(state.balanceA).toBe(700_000_000n); // 1.0 - 0.3
      expect(state.balanceB).toBe(300_000_000n); // 0.0 + 0.3
      expect(state.balanceA + state.balanceB).toBe(1_000_000_000n); // conservation
    });

    it("B can pay A from received funds (initBalanceB=0)", () => {
      // A pays B 0.3
      const state1 = pcA.createPaymentState(initialState, 300_000_000n);
      // B pays A 0.1 from the 0.3 received
      const state2 = pcB.createPaymentState(state1, 100_000_000n);
      expect(state2.balanceA).toBe(800_000_000n); // 0.7 + 0.1
      expect(state2.balanceB).toBe(200_000_000n); // 0.3 - 0.1
      expect(state2.balanceA + state2.balanceB).toBe(1_000_000_000n); // conservation
      expect(state2.seqnoA).toBe(1);
      expect(state2.seqnoB).toBe(1);
    });

    it("B cannot pay more than received", () => {
      const state1 = pcA.createPaymentState(initialState, 300_000_000n);
      // B tries to pay 400M but only has 300M
      expect(() => pcB.createPaymentState(state1, 400_000_000n)).toThrow("Insufficient balance");
    });

    it("sign/verify works for bidirectional flow", () => {
      // A pays B
      const state1 = pcA.createPaymentState(initialState, 300_000_000n);
      const sigA = pcA.signState(state1);
      expect(pcB.verifyState(state1, sigA)).toBe(true);

      // B pays A
      const state2 = pcB.createPaymentState(state1, 100_000_000n);
      const sigB = pcB.signState(state2);
      expect(pcA.verifyState(state2, sigB)).toBe(true);
    });

    it("getMyBalance reflects actual holdings", () => {
      const state1 = pcA.createPaymentState(initialState, 300_000_000n);
      expect(pcA.getMyBalance(state1)).toBe(700_000_000n);
      expect(pcB.getMyBalance(state1)).toBe(300_000_000n);

      const state2 = pcB.createPaymentState(state1, 100_000_000n);
      expect(pcA.getMyBalance(state2)).toBe(800_000_000n);
      expect(pcB.getMyBalance(state2)).toBe(200_000_000n);
    });
  });
});
