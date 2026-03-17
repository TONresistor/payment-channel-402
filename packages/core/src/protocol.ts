/**
 * pc402-core — HTTP 402 protocol helpers
 *
 * Provides encoding/decoding, building/parsing, and verification of
 * all three pc402 HTTP headers:
 *
 *   PAYMENT-REQUIRED   (server -> client, 402 response)
 *   PAYMENT-SIGNATURE  (client -> server, retry request)
 *   PAYMENT-RESPONSE   (server -> client, 200 response)
 *
 * These functions are framework-agnostic and can be used directly by
 * any HTTP server or client implementation.
 */

import type { PaymentChannel } from "./channel.js";
import type {
  ChannelState,
  PC402PaymentPayload,
  PC402PaymentRequirements,
  PC402PaymentResponse,
  PC402PaymentSignature,
  VerifyErrorCode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Header encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary object to a base64 string for use in an HTTP header.
 *
 * Serialization pipeline: JSON.stringify -> UTF-8 bytes -> base64.
 *
 * @param obj - Any JSON-serializable value
 * @returns Base64-encoded string suitable for use as an HTTP header value
 */
export function encodeHeader(obj: unknown): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json, "utf-8").toString("base64");
}

/**
 * Decode a base64 HTTP header value back to a typed object.
 *
 * Deserialization pipeline: base64 -> UTF-8 bytes -> JSON.parse.
 * Returns null on any decoding or parsing failure; callers should treat null
 * as an `"invalid_payload"` error condition.
 *
 * @param header - Base64-encoded HTTP header value
 * @returns Parsed object of type T, or null if decoding/parsing fails
 */
export function decodeHeader<T>(header: string): T | null {
  try {
    const json = Buffer.from(header, "base64").toString("utf-8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payment Required (server -> client, 402)
// ---------------------------------------------------------------------------

/**
 * Build the `PAYMENT-REQUIRED` header value (base64-encoded JSON).
 *
 * Sent by the server in a 402 response to tell the client the price,
 * channel address, and configuration needed to open a channel and pay.
 *
 * @param opts.price           - Price per request in nanotons
 * @param opts.channelAddress  - On-chain contract address of the payment channel
 * @param opts.channelId       - Unique channel identifier (uint128)
 * @param opts.serverPublicKey - Server's Ed25519 public key (32 bytes)
 * @param opts.initBalanceA    - Client's initial deposit in nanotons
 * @param opts.initBalanceB    - Server's initial deposit in nanotons (default 0)
 * @param opts.asset           - Asset identifier (default "TON")
 * @param opts.network         - CAIP-2 network identifier (default "ton:-239")
 * @returns Base64-encoded JSON string for the `PAYMENT-REQUIRED` HTTP header
 */
export function buildPaymentRequired(opts: {
  price: bigint;
  channelAddress: string;
  channelId: bigint;
  serverPublicKey: Buffer;
  initBalanceA: bigint;
  initBalanceB?: bigint;
  asset?: string;
  network?: string;
}): string {
  const requirements: PC402PaymentRequirements = {
    scheme: "pc402",
    network: opts.network ?? "ton:-239",
    asset: opts.asset ?? "TON",
    amount: opts.price.toString(),
    channelAddress: opts.channelAddress,
    channelId: opts.channelId.toString(),
    extra: {
      initBalanceA: opts.initBalanceA.toString(),
      initBalanceB: (opts.initBalanceB ?? 0n).toString(),
      publicKeyB: Buffer.from(opts.serverPublicKey).toString("hex"),
    },
  };
  return encodeHeader(requirements);
}

/**
 * Parse the `PAYMENT-REQUIRED` header value.
 *
 * @param header - Raw base64-encoded `PAYMENT-REQUIRED` header value
 * @returns Parsed {@link PC402PaymentRequirements}, or null if the header is missing, malformed, or not a pc402 scheme
 */
export function parsePaymentRequired(header: string): PC402PaymentRequirements | null {
  const parsed = decodeHeader<PC402PaymentRequirements>(header);
  if (!parsed || parsed.scheme !== "pc402") return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Payment Signature (client -> server)
// ---------------------------------------------------------------------------

/**
 * Build the `PAYMENT-SIGNATURE` header value (base64-encoded JSON).
 *
 * Sent by the client in a retry request as proof of payment. Contains the new
 * channel state and the client's Ed25519 signature over that state.
 *
 * @param opts.channelAddress - On-chain contract address of the payment channel
 * @param opts.channelId      - Channel identifier as a decimal string
 * @param opts.state          - New channel state after deducting the payment
 * @param opts.signature      - Client's 64-byte Ed25519 signature over the state
 * @param opts.publicKey      - Client's Ed25519 public key (32 bytes)
 * @param opts.initBalanceA   - Client's initial deposit in nanotons (optional, for channel discovery)
 * @param opts.initBalanceB   - Server's initial deposit in nanotons (optional, for channel discovery)
 * @returns Base64-encoded JSON string for the `PAYMENT-SIGNATURE` HTTP header
 */
export function buildPaymentSignature(opts: {
  channelAddress: string;
  channelId: string;
  state: ChannelState;
  signature: Buffer;
  publicKey: Buffer;
  initBalanceA?: bigint;
  initBalanceB?: bigint;
  /** Client's commit co-signature (response to a commitRequest from the server) */
  commitSignature?: Buffer;
}): string {
  const payload: PC402PaymentPayload = {
    channelAddress: opts.channelAddress,
    channelId: opts.channelId,
    state: {
      balanceA: opts.state.balanceA.toString(),
      balanceB: opts.state.balanceB.toString(),
      seqnoA: opts.state.seqnoA,
      seqnoB: opts.state.seqnoB,
    },
    signature: Buffer.from(opts.signature).toString("base64"),
    publicKey: Buffer.from(opts.publicKey).toString("hex"),
    ...(opts.initBalanceA !== undefined && { initBalanceA: opts.initBalanceA.toString() }),
    ...(opts.initBalanceB !== undefined && { initBalanceB: opts.initBalanceB.toString() }),
    ...(opts.commitSignature && {
      commitSignature: Buffer.from(opts.commitSignature).toString("base64"),
    }),
  };

  const envelope: PC402PaymentSignature = {
    x402Version: 2,
    scheme: "pc402",
    payload,
  };

  return encodeHeader(envelope);
}

/**
 * Parse the `PAYMENT-SIGNATURE` header value.
 *
 * Validates the envelope structure (x402Version=2, scheme="pc402") before returning the payload.
 *
 * @param header - Raw base64-encoded `PAYMENT-SIGNATURE` header value
 * @returns Object containing the {@link PC402PaymentPayload}, or null if the header is malformed or invalid
 */
export function parsePaymentSignature(header: string): { payload: PC402PaymentPayload } | null {
  const envelope = decodeHeader<PC402PaymentSignature>(header);
  if (
    envelope === null ||
    envelope.x402Version !== 2 ||
    envelope.scheme !== "pc402" ||
    !envelope.payload
  ) {
    return null;
  }
  return { payload: envelope.payload };
}

// ---------------------------------------------------------------------------
// Payment Response (server -> client, 200)
// ---------------------------------------------------------------------------

/**
 * Build the `PAYMENT-RESPONSE` header value (base64-encoded JSON).
 *
 * Sent by the server in a 200 OK response after accepting payment.
 * Carries the server's counter-signature so the client can prove mutual agreement.
 *
 * @param opts.counterSignature - Server's 64-byte Ed25519 counter-signature over the accepted state
 * @param opts.network          - CAIP-2 network identifier (default "ton:-239")
 * @returns Base64-encoded JSON string for the `PAYMENT-RESPONSE` HTTP header
 */
export function buildPaymentResponse(opts: {
  counterSignature: Buffer;
  network?: string;
  commitRequest?: {
    seqnoA: number;
    seqnoB: number;
    sentA: bigint;
    sentB: bigint;
    withdrawA: bigint;
    withdrawB: bigint;
    serverSignature: Buffer;
  };
}): string {
  const response: PC402PaymentResponse = {
    success: true,
    counterSignature: Buffer.from(opts.counterSignature).toString("base64"),
    network: opts.network ?? "ton:-239",
    ...(opts.commitRequest && {
      commitRequest: {
        seqnoA: opts.commitRequest.seqnoA,
        seqnoB: opts.commitRequest.seqnoB,
        sentA: opts.commitRequest.sentA.toString(),
        sentB: opts.commitRequest.sentB.toString(),
        withdrawA: opts.commitRequest.withdrawA.toString(),
        withdrawB: opts.commitRequest.withdrawB.toString(),
        serverSignature: Buffer.from(opts.commitRequest.serverSignature).toString("base64"),
      },
    }),
  };
  return encodeHeader(response);
}

/**
 * Parse the `PAYMENT-RESPONSE` header value.
 *
 * @param header - Raw base64-encoded `PAYMENT-RESPONSE` header value
 * @returns Parsed {@link PC402PaymentResponse}, or null if the header is missing or malformed
 */
export function parsePaymentResponse(header: string): PC402PaymentResponse | null {
  const parsed = decodeHeader<PC402PaymentResponse>(header);
  if (!parsed || typeof parsed.success !== "boolean") return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// Full payment verification
// ---------------------------------------------------------------------------

/**
 * Result returned by {@link verifyPaymentSignature}.
 *
 * On success: `valid=true`, `state` and `paidAmount` are set.
 * On failure: `valid=false`, `error` and `errorMessage` describe the reason.
 */
export interface VerifyPaymentResult {
  /** Whether the payment signature passed all checks. */
  valid: boolean;
  /** Machine-readable error code when `valid` is false. */
  error?: VerifyErrorCode;
  /** Human-readable description of the failure reason. */
  errorMessage?: string;
  /** Verified new channel state (only set when `valid` is true). */
  state?: ChannelState;
  /** Amount actually paid in nanotons (only set when `valid` is true). */
  paidAmount?: bigint;
}

/**
 * Parse and verify a PAYMENT-SIGNATURE header in one call.
 *
 * Checks (in order):
 *  1. Parse the header -> "invalid_payload" if malformed
 *  2. channelAddress + channelId match -> "unknown_channel"
 *  3. Decode signature (base64 -> 64-byte Buffer) and publicKey (hex -> 32-byte Buffer) -> "invalid_payload"
 *  4. Reconstruct ChannelState from wire strings
 *  5. Balance conservation: balanceA + balanceB == initTotal -> "balance_mismatch"
 *  6. Ed25519 signature verification via PaymentChannel.verifyState() -> "invalid_signature"
 *  7. seqnoA > lastSeqnoA (strict monotonic) -> "stale_seqno"
 *  8. Amount paid (lastBalanceA - newBalanceA) >= price -> "insufficient_payment"
 *
 * @param header                 - Raw base64-encoded `PAYMENT-SIGNATURE` header value
 * @param channel                - {@link PaymentChannel} instance configured with `isA=false` (server side)
 * @param lastState              - Last accepted channel state, or null if this is the first payment
 * @param price                  - Required payment amount in nanotons for this request
 * @param expectedChannelAddress - The server's expected on-chain channel address
 * @param expectedChannelId      - The server's expected channel ID as a decimal string
 * @returns {@link VerifyPaymentResult} with `valid=true` and the new state on success,
 *   or `valid=false` with an error code and message on failure
 */
export function verifyPaymentSignature(
  header: string,
  channel: PaymentChannel,
  lastState: ChannelState | null,
  price: bigint,
  expectedChannelAddress: string,
  expectedChannelId: string,
): VerifyPaymentResult {
  // ------------------------------------------------------------------
  // 1. Parse header
  // ------------------------------------------------------------------
  const parsed = parsePaymentSignature(header);
  if (!parsed) {
    return {
      valid: false,
      error: "invalid_payload",
      errorMessage: "PAYMENT-SIGNATURE header is malformed or not a valid pc402 envelope",
    };
  }

  const { payload } = parsed;

  // ------------------------------------------------------------------
  // 2. Channel identity check
  // ------------------------------------------------------------------
  if (
    payload.channelAddress !== expectedChannelAddress ||
    payload.channelId !== expectedChannelId
  ) {
    return {
      valid: false,
      error: "unknown_channel",
      errorMessage: `Expected channelAddress=${expectedChannelAddress} channelId=${expectedChannelId}, got ${payload.channelAddress}/${payload.channelId}`,
    };
  }

  // ------------------------------------------------------------------
  // 3. Decode binary fields
  // ------------------------------------------------------------------
  let signatureBuffer: Buffer;
  let publicKeyBuffer: Buffer;

  try {
    signatureBuffer = Buffer.from(payload.signature, "base64");
    if (signatureBuffer.length !== 64) {
      throw new Error(`signature must be 64 bytes, got ${signatureBuffer.length}`);
    }

    publicKeyBuffer = Buffer.from(payload.publicKey, "hex");
    if (publicKeyBuffer.length !== 32) {
      throw new Error(`publicKey must be 32 bytes, got ${publicKeyBuffer.length}`);
    }
  } catch (e) {
    return {
      valid: false,
      error: "invalid_payload",
      errorMessage: e instanceof Error ? e.message : "failed to decode signature or publicKey",
    };
  }

  // ------------------------------------------------------------------
  // 4. Reconstruct ChannelState (string -> bigint)
  // ------------------------------------------------------------------
  let newState: ChannelState;
  try {
    newState = {
      balanceA: BigInt(payload.state.balanceA),
      balanceB: BigInt(payload.state.balanceB),
      seqnoA: payload.state.seqnoA,
      seqnoB: payload.state.seqnoB,
    };
    if (newState.balanceA < 0n || newState.balanceB < 0n) {
      throw new Error("balances must be non-negative");
    }
    if (!Number.isInteger(newState.seqnoA) || !Number.isInteger(newState.seqnoB)) {
      throw new Error("seqnos must be integers");
    }
  } catch (e) {
    return {
      valid: false,
      error: "invalid_payload",
      errorMessage: e instanceof Error ? e.message : "failed to parse state",
    };
  }

  // ------------------------------------------------------------------
  // 5. Balance conservation: balanceA + balanceB must equal initTotal
  // ------------------------------------------------------------------
  const initTotal = channel.config.initBalanceA + channel.config.initBalanceB;
  const newTotal = newState.balanceA + newState.balanceB;
  if (newTotal !== initTotal) {
    return {
      valid: false,
      error: "balance_mismatch",
      errorMessage:
        `Balance conservation violated: ` +
        `balanceA(${newState.balanceA}) + balanceB(${newState.balanceB}) = ${newTotal}, ` +
        `expected ${initTotal} (initA=${channel.config.initBalanceA} + initB=${channel.config.initBalanceB})`,
    };
  }

  // ------------------------------------------------------------------
  // 6. Ed25519 signature verification
  // ------------------------------------------------------------------
  const sigValid = channel.verifyState(newState, signatureBuffer);
  if (!sigValid) {
    return {
      valid: false,
      error: "invalid_signature",
      errorMessage: "Ed25519 signature verification failed",
    };
  }

  // ------------------------------------------------------------------
  // 7. Seqno must be strictly greater than last accepted
  // ------------------------------------------------------------------
  if (lastState !== null && newState.seqnoA <= lastState.seqnoA) {
    return {
      valid: false,
      error: "stale_seqno",
      errorMessage: `seqnoA must be > ${lastState.seqnoA}, got ${newState.seqnoA}`,
    };
  }

  // ------------------------------------------------------------------
  // 8. Payment amount must be >= price
  // ------------------------------------------------------------------
  const prevBalanceA = lastState !== null ? lastState.balanceA : channel.config.initBalanceA;
  const paid = prevBalanceA - newState.balanceA;

  if (paid < price) {
    return {
      valid: false,
      error: "insufficient_payment",
      errorMessage: `paid ${paid} nanotons but price is ${price}`,
    };
  }

  return {
    valid: true,
    state: newState,
    paidAmount: paid,
  };
}
