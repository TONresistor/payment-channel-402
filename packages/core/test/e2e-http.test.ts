/**
 * pc402-core — E2E HTTP test
 *
 * Proves the full HTTP 402 payment flow using ONLY pc402-core protocol helpers.
 * No pc402/server or pc402/client packages — just Express + core functions.
 *
 * Flow:
 *   1. Client sends GET /resource
 *   2. Server returns 402 + PAYMENT-REQUIRED header (built with buildPaymentRequired)
 *   3. Client parses the 402, builds a payment state, signs it, builds PAYMENT-SIGNATURE
 *   4. Client retries with PAYMENT-SIGNATURE header
 *   5. Server parses + verifies with verifyPaymentSignature
 *   6. Server counter-signs, returns 200 + PAYMENT-RESPONSE header
 *   7. Client parses PAYMENT-RESPONSE and verifies counter-signature
 */

import type { Server } from "node:http";
import type { KeyPair } from "@ton/crypto";
import { keyPairFromSeed } from "@ton/crypto";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaymentChannel } from "../src/channel.js";
import {
  buildPaymentRequired,
  buildPaymentResponse,
  buildPaymentSignature,
  parsePaymentRequired,
  parsePaymentResponse,
  verifyPaymentSignature,
} from "../src/protocol.js";
import type { ChannelState } from "../src/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_ADDRESS = "EQAe2eProtocolTestAddress0000000";
const SERVER_ADDRESS = "EQServerE2eWalletAddress00000000000";
const CHANNEL_ID = 200_000n;
const INIT_BALANCE_A = 1_000_000_000n; // 1 TON
const INIT_BALANCE_B = 0n;
const PRICE = 10_000_000n; // 0.01 TON

function makeKeyPair(seed: number): KeyPair {
  return keyPairFromSeed(Buffer.alloc(32, seed));
}

const clientKeyPair = makeKeyPair(0xcc);
const serverKeyPair = makeKeyPair(0xdd);

// ---------------------------------------------------------------------------
// Server: minimal Express app using ONLY core protocol helpers
// ---------------------------------------------------------------------------

interface TestServer {
  baseUrl: string;
  server: Server;
  lastAcceptedState: ChannelState | null;
}

async function startServer(): Promise<TestServer> {
  const ctx: TestServer = {
    baseUrl: "",
    server: null as unknown as Server,
    lastAcceptedState: null,
  };

  const serverChannel = new PaymentChannel({
    channelId: CHANNEL_ID,
    isA: false,
    myKeyPair: serverKeyPair,
    hisPublicKey: Buffer.from(clientKeyPair.publicKey),
    initBalanceA: INIT_BALANCE_A,
    initBalanceB: INIT_BALANCE_B,
  });

  const app = express();

  app.get("/resource", (req, res) => {
    const rawHeader = req.headers["payment-signature"] as string | undefined;

    // No payment header -> 402
    if (!rawHeader) {
      const paymentRequiredHeader = buildPaymentRequired({
        price: PRICE,
        serverPublicKey: Buffer.from(serverKeyPair.publicKey),
        serverAddress: SERVER_ADDRESS,
        channelAddress: CHANNEL_ADDRESS,
        channelId: CHANNEL_ID,
        initBalanceA: INIT_BALANCE_A,
        initBalanceB: INIT_BALANCE_B,
      });

      res.setHeader("payment-required", paymentRequiredHeader);
      res.status(402).json({
        error: "payment_required",
        message: "This resource requires a pc402 payment",
      });
      return;
    }

    // Verify payment
    const result = verifyPaymentSignature(
      rawHeader,
      serverChannel,
      ctx.lastAcceptedState,
      PRICE,
      CHANNEL_ADDRESS,
      CHANNEL_ID.toString(),
    );

    if (!result.valid) {
      res.status(402).json({
        error: result.error,
        message: result.errorMessage,
      });
      return;
    }

    // Accept payment: persist state
    ctx.lastAcceptedState = result.state!;

    // Counter-sign and respond
    const counterSig = serverChannel.signState(result.state!);
    const paymentResponseHeader = buildPaymentResponse({
      counterSignature: counterSig,
    });

    res.setHeader("payment-response", paymentResponseHeader);
    res.json({ data: "secret content" });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      ctx.baseUrl = `http://127.0.0.1:${addr.port}`;
      ctx.server = server;
      resolve(ctx);
    });
  });
}

function stopServer(ts: TestServer): Promise<void> {
  return new Promise((resolve, reject) => {
    ts.server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// Client helper: manual 402 flow using only core protocol helpers
// ---------------------------------------------------------------------------

async function pc402Request(
  url: string,
  clientChannel: PaymentChannel,
  currentState: ChannelState,
): Promise<{
  response: Response;
  newState: ChannelState;
}> {
  // Step 1: Initial request
  const res1 = await fetch(url);

  if (res1.status !== 402) {
    return { response: res1, newState: currentState };
  }

  // Step 2: Parse 402
  const rawRequired = res1.headers.get("payment-required");
  if (!rawRequired) {
    throw new Error("402 without PAYMENT-REQUIRED header");
  }

  const requirements = parsePaymentRequired(rawRequired);
  if (!requirements) {
    throw new Error("Failed to parse PAYMENT-REQUIRED header");
  }

  const price = BigInt(requirements.amount);

  // Step 3: Build payment state
  const newState = clientChannel.createPaymentState(currentState, price);
  const signature = clientChannel.signState(newState);

  if (!requirements.channel) {
    throw new Error("Server did not include channel info in PAYMENT-REQUIRED");
  }

  // Step 4: Build PAYMENT-SIGNATURE header
  const paymentSigHeader = buildPaymentSignature({
    channelAddress: requirements.channel.address,
    channelId: requirements.channel.channelId,
    state: newState,
    signature,
    publicKey: Buffer.from(clientChannel.config.myKeyPair.publicKey),
  });

  // Step 5: Retry with payment
  const res2 = await fetch(url, {
    headers: { "payment-signature": paymentSigHeader },
  });

  return { response: res2, newState };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E HTTP: full c402 flow using only pc402-core protocol helpers", () => {
  let ts: TestServer;

  const clientChannel = new PaymentChannel({
    channelId: CHANNEL_ID,
    isA: true,
    myKeyPair: clientKeyPair,
    hisPublicKey: Buffer.from(serverKeyPair.publicKey),
    initBalanceA: INIT_BALANCE_A,
    initBalanceB: INIT_BALANCE_B,
  });

  beforeAll(async () => {
    ts = await startServer();
  });

  afterAll(async () => {
    await stopServer(ts);
  });

  it("1. GET without payment -> 402 with valid PAYMENT-REQUIRED", async () => {
    const res = await fetch(`${ts.baseUrl}/resource`);
    expect(res.status).toBe(402);

    const rawHeader = res.headers.get("payment-required");
    expect(rawHeader).toBeTruthy();

    const requirements = parsePaymentRequired(rawHeader!);
    expect(requirements).not.toBeNull();
    expect(requirements?.scheme).toBe("pc402");
    expect(requirements?.amount).toBe(PRICE.toString());
    expect(requirements?.payee.address).toBe(SERVER_ADDRESS);
    expect(requirements?.channel?.address).toBe(CHANNEL_ADDRESS);
    expect(requirements?.channel?.channelId).toBe(CHANNEL_ID.toString());
  });

  it("2. Full flow: GET -> 402 -> sign -> retry -> 200 + PAYMENT-RESPONSE", async () => {
    const initialState: ChannelState = {
      balanceA: INIT_BALANCE_A,
      balanceB: INIT_BALANCE_B,
      seqnoA: 0,
      seqnoB: 0,
    };

    const { response, newState } = await pc402Request(
      `${ts.baseUrl}/resource`,
      clientChannel,
      initialState,
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as { data: string };
    expect(body.data).toBe("secret content");

    // Verify PAYMENT-RESPONSE header
    const rawResponse = response.headers.get("payment-response");
    expect(rawResponse).toBeTruthy();

    const paymentResponse = parsePaymentResponse(rawResponse!);
    expect(paymentResponse).not.toBeNull();
    expect(paymentResponse!.success).toBe(true);
    if (!paymentResponse || !paymentResponse.success) return;

    // Verify the counter-signature
    const counterSigBuf = Buffer.from(paymentResponse.counterSignature, "base64");
    const isValid = clientChannel.verifyState(newState, counterSigBuf);
    expect(isValid).toBe(true);
  });

  it("3. Multiple sequential requests all succeed", async () => {
    // Use a fresh server to have clean state
    const freshTs = await startServer();

    try {
      let currentState: ChannelState = {
        balanceA: INIT_BALANCE_A,
        balanceB: INIT_BALANCE_B,
        seqnoA: 0,
        seqnoB: 0,
      };

      for (let i = 0; i < 5; i++) {
        const { response, newState } = await pc402Request(
          `${freshTs.baseUrl}/resource`,
          clientChannel,
          currentState,
        );

        expect(response.status).toBe(200);
        const body = (await response.json()) as { data: string };
        expect(body.data).toBe("secret content");

        currentState = newState;
      }

      // After 5 requests, balanceA should be reduced by 5 * PRICE
      expect(currentState.seqnoA).toBe(5);
      expect(currentState.balanceA).toBe(INIT_BALANCE_A - 5n * PRICE);
      expect(currentState.balanceB).toBe(5n * PRICE);
    } finally {
      await stopServer(freshTs);
    }
  });

  it("4. Invalid signature is rejected", async () => {
    const freshTs = await startServer();

    try {
      const state: ChannelState = {
        balanceA: INIT_BALANCE_A - PRICE,
        balanceB: PRICE,
        seqnoA: 1,
        seqnoB: 0,
      };

      // Build a header with a bad signature (64 zero bytes)
      const badHeader = buildPaymentSignature({
        channelAddress: CHANNEL_ADDRESS,
        channelId: CHANNEL_ID.toString(),
        state,
        signature: Buffer.alloc(64, 0),
        publicKey: Buffer.from(clientKeyPair.publicKey),
      });

      const res = await fetch(`${freshTs.baseUrl}/resource`, {
        headers: { "payment-signature": badHeader },
      });

      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_signature");
    } finally {
      await stopServer(freshTs);
    }
  });

  it("5. Insufficient payment is rejected", async () => {
    const freshTs = await startServer();

    try {
      // Pay only 1 nanoton when price is 10_000_000
      const underpayState: ChannelState = {
        balanceA: INIT_BALANCE_A - 1n,
        balanceB: 1n,
        seqnoA: 1,
        seqnoB: 0,
      };

      const sig = clientChannel.signState(underpayState);
      const header = buildPaymentSignature({
        channelAddress: CHANNEL_ADDRESS,
        channelId: CHANNEL_ID.toString(),
        state: underpayState,
        signature: sig,
        publicKey: Buffer.from(clientKeyPair.publicKey),
      });

      const res = await fetch(`${freshTs.baseUrl}/resource`, {
        headers: { "payment-signature": header },
      });

      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("insufficient_payment");
    } finally {
      await stopServer(freshTs);
    }
  });
});
