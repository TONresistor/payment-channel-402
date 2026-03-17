import { describe, expect, it } from "vitest";
import {
  balanceToSentCoins,
  buildSemiChannelBody,
  buildSemiChannelBodyWithHeader,
  TAG_CLOSE,
  TAG_STATE,
} from "../src/cell.js";

describe("cell.ts", () => {
  // -------------------------------------------------------------------------
  // buildSemiChannelBody
  // -------------------------------------------------------------------------

  describe("buildSemiChannelBody", () => {
    it("should build a cell with seqno, coins, and conditionalsHash=0", () => {
      const body = buildSemiChannelBody(42, 1000000000n);
      const slice = body.beginParse();

      // seqno: uint64
      expect(slice.loadUint(64)).toBe(42);

      // sentCoins: Coins (VarUInteger 16)
      expect(slice.loadCoins()).toBe(1000000000n);

      // conditionalsHash: uint256 = 0 (v2 — replaces the old 1-bit hasConditionals)
      expect(slice.loadUintBig(256)).toBe(0n);

      // Should be empty now
      expect(slice.remainingBits).toBe(0);
      expect(slice.remainingRefs).toBe(0);
    });

    it("should handle zero sentCoins", () => {
      const body = buildSemiChannelBody(0, 0n);
      const slice = body.beginParse();

      expect(slice.loadUint(64)).toBe(0);
      expect(slice.loadCoins()).toBe(0n);
      expect(slice.loadUintBig(256)).toBe(0n);
    });

    it("should handle large sentCoins", () => {
      const large = 999_999_999_999_999_999n; // ~1 billion TON
      const body = buildSemiChannelBody(1, large);
      const slice = body.beginParse();

      expect(slice.loadUint(64)).toBe(1);
      expect(slice.loadCoins()).toBe(large);
      expect(slice.loadUintBig(256)).toBe(0n);
    });
  });

  // -------------------------------------------------------------------------
  // buildSemiChannelBodyWithHeader
  // -------------------------------------------------------------------------

  describe("buildSemiChannelBodyWithHeader", () => {
    it("should build a cell with correct TAG_STATE (0x50433453)", () => {
      const cell = buildSemiChannelBodyWithHeader(12345n, 1, 100n);
      const slice = cell.beginParse();

      expect(slice.loadUint(32)).toBe(TAG_STATE);
    });

    it("should have correct channelId (uint128)", () => {
      const channelId = 0xdeadbeefcafe1234n;
      const cell = buildSemiChannelBodyWithHeader(channelId, 1, 100n);
      const slice = cell.beginParse();

      slice.loadUint(32); // skip tag
      expect(slice.loadUintBig(128)).toBe(channelId);
    });

    it("should store seqno(uint64), sentCoins, and conditionalsHash=0", () => {
      const cell = buildSemiChannelBodyWithHeader(1n, 5, 500n);
      const slice = cell.beginParse();

      slice.loadUint(32); // tag
      slice.loadUintBig(128); // channelId

      expect(slice.loadUint(64)).toBe(5); // seqno
      expect(slice.loadCoins()).toBe(500n); // sentCoins
      expect(slice.loadUintBig(256)).toBe(0n); // conditionalsHash = 0
    });

    it("should use TAG_CLOSE when specified", () => {
      const cell = buildSemiChannelBodyWithHeader(1n, 1, 0n, TAG_CLOSE);
      const slice = cell.beginParse();

      expect(slice.loadUint(32)).toBe(TAG_CLOSE);
    });

    it("should produce deterministic hashes", () => {
      const build = () => buildSemiChannelBodyWithHeader(999n, 10, 1000n);

      const hash1 = build().hash();
      const hash2 = build().hash();
      expect(Buffer.from(hash1).equals(Buffer.from(hash2))).toBe(true);
    });

    it("should produce different hashes for different seqnos", () => {
      const cell1 = buildSemiChannelBodyWithHeader(1n, 1, 100n);
      const cell2 = buildSemiChannelBodyWithHeader(1n, 2, 100n);
      expect(Buffer.from(cell1.hash()).equals(Buffer.from(cell2.hash()))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // balanceToSentCoins
  // -------------------------------------------------------------------------

  describe("balanceToSentCoins", () => {
    it("should compute sentCoins = initBalance - currentBalance", () => {
      expect(balanceToSentCoins(1_000_000_000n, 900_000_000n)).toBe(100_000_000n);
    });

    it("should return 0 when no payment made", () => {
      expect(balanceToSentCoins(1_000_000_000n, 1_000_000_000n)).toBe(0n);
    });

    it("should return full amount when balance is 0", () => {
      expect(balanceToSentCoins(1_000_000_000n, 0n)).toBe(1_000_000_000n);
    });

    it("should return 0n when currentBalance exceeds initBalance (received funds)", () => {
      // This happens when a party has received more than they sent
      expect(balanceToSentCoins(100n, 200n)).toBe(0n);
      expect(balanceToSentCoins(0n, 300_000_000n)).toBe(0n);
    });
  });
});
