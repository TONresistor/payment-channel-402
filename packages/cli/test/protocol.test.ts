import { keyPairFromSeed } from "@ton/crypto";
import { buildPaymentRequired, buildPaymentResponse, decodeHeader, encodeHeader } from "pc402-core";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// detectType — same logic as the CLI command (src/commands/protocol.ts)
// ---------------------------------------------------------------------------

function detectType(obj: Record<string, unknown>): string {
  if (typeof obj.success === "boolean") return "PAYMENT-RESPONSE";
  if (typeof obj.x402Version === "number" && typeof obj.scheme === "string")
    return "PAYMENT-SIGNATURE";
  if (typeof obj.scheme === "string") return "PAYMENT-REQUIRED";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("protocol encode/decode", () => {
  it("roundtrip: encode then decode returns original object", () => {
    const obj = { foo: "bar", num: 42, nested: { a: true } };
    const encoded = encodeHeader(obj);
    const decoded = decodeHeader<typeof obj>(encoded);
    expect(decoded).toEqual(obj);
  });

  it("decode invalid base64 returns null", () => {
    expect(decodeHeader("!!!not-base64!!!")).toBeNull();
  });

  it("decode valid base64 but invalid JSON returns null", () => {
    const notJson = Buffer.from("not json {{{", "utf-8").toString("base64");
    expect(decodeHeader(notJson)).toBeNull();
  });

  it("roundtrip with bigint-stringified fields", () => {
    const obj = { amount: "1000000000", seqno: 5 };
    const encoded = encodeHeader(obj);
    const decoded = decodeHeader<typeof obj>(encoded);
    expect(decoded).toEqual(obj);
  });
});

describe("detectType", () => {
  it("identifies PAYMENT-REQUIRED (has scheme, no success)", () => {
    expect(detectType({ scheme: "pc402", network: "ton:-239", amount: "100" })).toBe(
      "PAYMENT-REQUIRED",
    );
  });

  it("identifies PAYMENT-SIGNATURE (has x402Version + scheme)", () => {
    expect(detectType({ x402Version: 2, scheme: "pc402", payload: {} })).toBe("PAYMENT-SIGNATURE");
  });

  it("identifies PAYMENT-RESPONSE (has success boolean)", () => {
    expect(detectType({ success: true, counterSignature: "abc" })).toBe("PAYMENT-RESPONSE");
    expect(detectType({ success: false, error: "insufficient_payment" })).toBe("PAYMENT-RESPONSE");
  });

  it("returns unknown for unrecognized shape", () => {
    expect(detectType({ random: "data" })).toBe("unknown");
  });
});

describe("encode/decode with real pc402 headers", () => {
  const serverKP = keyPairFromSeed(Buffer.alloc(32, 2));

  it("roundtrip buildPaymentRequired", () => {
    const header = buildPaymentRequired({
      price: 10_000_000n,
      serverPublicKey: serverKP.publicKey,
      serverAddress: "EQServer_Address_00000000000000000000000000000000000",
      channelAddress: "EQChannel_Address_0000000000000000000000000000000000",
      channelId: 42n,
      initBalanceA: 1_000_000_000n,
      initBalanceB: 0n,
    });

    const decoded = decodeHeader<Record<string, unknown>>(header);
    expect(decoded).not.toBeNull();
    expect(decoded!.scheme).toBe("pc402");
    expect(decoded!.amount).toBe("10000000");
    expect(detectType(decoded!)).toBe("PAYMENT-REQUIRED");
  });

  it("roundtrip buildPaymentResponse", () => {
    const header = buildPaymentResponse({
      counterSignature: Buffer.alloc(64, 0xab),
      network: "ton:-239",
    });

    const decoded = decodeHeader<Record<string, unknown>>(header);
    expect(decoded).not.toBeNull();
    expect(decoded!.success).toBe(true);
    expect(decoded!.network).toBe("ton:-239");
    expect(detectType(decoded!)).toBe("PAYMENT-RESPONSE");
  });
});
