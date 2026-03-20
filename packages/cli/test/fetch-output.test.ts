import { describe, expect, it } from "vitest";

/**
 * Tests for the fetch --json output format.
 * We replicate the output formatting logic from src/commands/fetch.ts
 * to validate the JSON structure without needing real HTTP calls.
 */

function formatJsonOutput(opts: {
  status: number;
  body: string;
  paid: boolean;
  paymentResponseHeader?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    status: opts.status,
    body: opts.body,
    paid: opts.paid,
  };
  if (opts.paid && opts.paymentResponseHeader) {
    out["headers"] = { "payment-response": opts.paymentResponseHeader };
  }
  return out;
}

function formatErrorJson(err: Error | string): Record<string, unknown> {
  return { error: err instanceof Error ? err.message : String(err) };
}

describe("fetch --json output format", () => {
  it("success without payment", () => {
    const out = formatJsonOutput({
      status: 200,
      body: "hello",
      paid: false,
    });
    expect(out).toEqual({ status: 200, body: "hello", paid: false });
    expect(out).not.toHaveProperty("headers");
  });

  it("success with payment includes headers", () => {
    const out = formatJsonOutput({
      status: 200,
      body: '{"data":true}',
      paid: true,
      paymentResponseHeader: "eyJzdWNjZXNzIjp0cnVlfQ==",
    });
    expect(out).toEqual({
      status: 200,
      body: '{"data":true}',
      paid: true,
      headers: { "payment-response": "eyJzdWNjZXNzIjp0cnVlfQ==" },
    });
  });

  it("paid=true but no paymentResponseHeader omits headers", () => {
    const out = formatJsonOutput({
      status: 200,
      body: "ok",
      paid: true,
    });
    expect(out).toEqual({ status: 200, body: "ok", paid: true });
    expect(out).not.toHaveProperty("headers");
  });

  it("non-200 status preserved", () => {
    const out = formatJsonOutput({
      status: 402,
      body: "Payment Required",
      paid: false,
    });
    expect(out.status).toBe(402);
    expect(out.paid).toBe(false);
  });
});

describe("fetch --json error output", () => {
  it("Error object extracts message", () => {
    const out = formatErrorJson(new Error("connection refused"));
    expect(out).toEqual({ error: "connection refused" });
  });

  it("string error is passed through", () => {
    const out = formatErrorJson("timeout");
    expect(out).toEqual({ error: "timeout" });
  });
});
