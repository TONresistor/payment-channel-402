import { balanceToSentCoins } from "pc402-core";
import { describe, expect, it } from "vitest";

describe("balanceToSentCoins", () => {
  it("A pays B: initA=1TON, balA=0.9TON -> sentA=0.1TON", () => {
    const initA = 1_000_000_000n;
    const balA = 900_000_000n;
    expect(balanceToSentCoins(initA, balA)).toBe(100_000_000n);
  });

  it("B receives: initB=0, balB=0.1TON -> sentB=0 (not negative)", () => {
    const initB = 0n;
    const balB = 100_000_000n;
    expect(balanceToSentCoins(initB, balB)).toBe(0n);
  });

  it("both sides active", () => {
    // A started with 1 TON, spent 0.3 TON
    const sentA = balanceToSentCoins(1_000_000_000n, 700_000_000n);
    expect(sentA).toBe(300_000_000n);

    // B started with 0.5 TON, spent 0.1 TON
    const sentB = balanceToSentCoins(500_000_000n, 400_000_000n);
    expect(sentB).toBe(100_000_000n);
  });

  it("edge: full balance spent: initA=1TON, balA=0 -> sentA=1TON", () => {
    expect(balanceToSentCoins(1_000_000_000n, 0n)).toBe(1_000_000_000n);
  });

  it("edge: no payments made: sentA=0, sentB=0", () => {
    expect(balanceToSentCoins(1_000_000_000n, 1_000_000_000n)).toBe(0n);
    expect(balanceToSentCoins(0n, 0n)).toBe(0n);
  });

  it("edge: balance exceeds init (bidirectional receive) -> sentCoins=0", () => {
    // B started with 0, received 500_000_000 from A
    expect(balanceToSentCoins(0n, 500_000_000n)).toBe(0n);
  });
});
