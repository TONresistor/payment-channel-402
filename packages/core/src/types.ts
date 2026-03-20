/**
 * pc402-core — Type definitions
 *
 * All interfaces and types for the pc402 payment channel protocol.
 * These match the public API specification in specs/pc402/api.md.
 */

import type { KeyPair } from "@ton/crypto";

// ---------------------------------------------------------------------------
// Channel identification and configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a {@link PaymentChannel} instance.
 *
 * Holds the channel identity, this party's key pair, the counterparty's public key,
 * and the initial balances used to compute sentCoins from current balances.
 */
export interface ChannelConfig {
  /** uint128 — unique channel identifier */
  channelId: bigint;
  /** true = payer (client / party A), false = payee (server / party B) */
  isA: boolean;
  /** Ed25519 keypair from @ton/crypto */
  myKeyPair: KeyPair;
  /** 32 bytes — counterparty's public key */
  hisPublicKey: Buffer;
  /** nanotons — A's initial deposit */
  initBalanceA: bigint;
  /** nanotons — B's initial deposit */
  initBalanceB: bigint;
}

// ---------------------------------------------------------------------------
// Off-chain state (balances + sequence numbers)
// ---------------------------------------------------------------------------

/**
 * Off-chain state of a payment channel.
 *
 * Represents the current fund distribution and sequence numbers for both parties.
 * The invariant `balanceA + balanceB == initBalanceA + initBalanceB` must always hold.
 */
export interface ChannelState {
  /** current balance of A in nanotons */
  balanceA: bigint;
  /** current balance of B in nanotons */
  balanceB: bigint;
  /** A's monotonic sequence number */
  seqnoA: number;
  /** B's monotonic sequence number */
  seqnoB: number;
}

// ---------------------------------------------------------------------------
// HTTP wire types
// ---------------------------------------------------------------------------

/**
 * Sent by the server in a 402 Payment Required response.
 *
 * Encoded as base64 JSON in the `PAYMENT-REQUIRED` HTTP header.
 * Tells the client the price, server identity, and optionally the channel
 * configuration needed to pay (if the server already knows this client's channel).
 */
export interface PC402PaymentRequirements {
  scheme: "pc402";
  /** CAIP-2, e.g. "ton:-239" */
  network: string;
  /** "TON" (native only for v1) */
  asset: string;
  /** price per request in nanotons (string for precision) */
  amount: string;

  /** Server identity — always present */
  payee: {
    /** hex-encoded 32-byte Ed25519 public key */
    publicKey: string;
    /** TON wallet address */
    address: string;
  };

  /** Channel info — present if server knows this client's channel */
  channel?: {
    /** smart contract address */
    address: string;
    /** uint128 as string */
    channelId: string;
    /** nanotons string — A's initial deposit */
    initBalanceA: string;
    /** nanotons string — B's initial deposit */
    initBalanceB: string;
  };

  /** Rejection context — set when the server includes an error in the 402 */
  error?: VerifyErrorCode;
  errorMessage?: string;
}

/**
 * Proof of payment sent by the client in a retry request.
 *
 * Contains the new channel state (balances + seqnos) and the client's Ed25519 signature
 * over that state, encoded in the `PAYMENT-SIGNATURE` HTTP header.
 */
export interface PC402PaymentPayload {
  channelAddress: string;
  channelId: string;
  state: {
    /** nanotons string */
    balanceA: string;
    /** nanotons string */
    balanceB: string;
    seqnoA: number;
    seqnoB: number;
  };
  /** base64-encoded Ed25519 signature (64 bytes) */
  signature: string;
  /** hex-encoded public key (32 bytes) */
  publicKey: string;
  /** nanotons string — A's initial deposit (optional, for dynamic channel discovery) */
  initBalanceA?: string;
  /** nanotons string — B's initial deposit (optional, for dynamic channel discovery) */
  initBalanceB?: string;
  /** base64-encoded Ed25519 commit co-signature from the client (optional, response to commitRequest) */
  commitSignature?: string;
  /** base64-encoded Ed25519 close co-signature from the client (optional, response to closeRequest) */
  closeSignature?: string;
}

/**
 * Full envelope for the `PAYMENT-SIGNATURE` HTTP header.
 *
 * Wraps the {@link PC402PaymentPayload} with protocol version and scheme discriminant.
 */
export interface PC402PaymentSignature {
  x402Version: 2;
  scheme: "pc402";
  payload: PC402PaymentPayload;
}

/**
 * Sent by the server in a 200 OK response after accepting payment (success variant),
 * or in a 402 error response (error variant).
 *
 * Encoded as base64 JSON in the `PAYMENT-RESPONSE` HTTP header.
 */
export type PC402PaymentResponse =
  | {
      /** Payment accepted. */
      success: true;
      /** Base64-encoded 64-byte Ed25519 counter-signature from the server. */
      counterSignature: string;
      /** CAIP-2 network identifier, e.g. "ton:-239". */
      network: string;
      /** Optional commit request — server asks client to co-sign a cooperativeCommit. */
      commitRequest?: PC402CommitRequest;
      /** Optional close request — server asks client to co-sign a cooperative close. */
      closeRequest?: PC402CloseRequest;
      /** Optional server-to-client payment (bidirectional). Contains a signed state from the server (party B). */
      serverPayment?: PC402ServerPayment;
    }
  | {
      /** Payment rejected. */
      success: false;
      /** Machine-readable error code. */
      error: VerifyErrorCode;
      /** Human-readable description. */
      errorMessage: string;
      /** CAIP-2 network identifier. */
      network: string;
    };

/**
 * Server's request for a cooperative close co-signature.
 *
 * Included in PAYMENT-RESPONSE when the server wants to close the channel cooperatively.
 * The client verifies the payload, co-signs if valid, and includes the signature
 * as `closeSignature` in the next PAYMENT-SIGNATURE.
 */
export interface PC402CloseRequest {
  /** Committed sequence number for party A */
  seqnoA: number;
  /** Committed sequence number for party B */
  seqnoB: number;
  /** Total amount sent by A in nanotons (string) */
  sentA: string;
  /** Total amount sent by B in nanotons (string) */
  sentB: string;
  /** Base64-encoded server's close signature (B side) */
  serverSignature: string;
}

/**
 * Server-to-client payment included in PAYMENT-RESPONSE (bidirectional flow).
 *
 * When the server (party B) wants to pay the client (party A), it includes
 * a signed state update in the response. The client verifies the signature
 * with `PaymentChannel.verifyState()` and adopts the new state.
 */
export interface PC402ServerPayment {
  /** New channel state after server's payment */
  state: {
    balanceA: string;
    balanceB: string;
    seqnoA: number;
    seqnoB: number;
  };
  /** Base64-encoded 64-byte Ed25519 signature from the server (party B) */
  signature: string;
}

/**
 * Server's request for a cooperative commit co-signature.
 *
 * Included in PAYMENT-RESPONSE when the server wants to withdraw accumulated funds.
 * The client verifies the payload, co-signs if valid, and includes the signature
 * as `commitSignature` in the next PAYMENT-SIGNATURE.
 */
export interface PC402CommitRequest {
  /** Committed sequence number for party A */
  seqnoA: number;
  /** Committed sequence number for party B */
  seqnoB: number;
  /** Total amount sent by A in nanotons (string) */
  sentA: string;
  /** Total amount sent by B in nanotons (string) */
  sentB: string;
  /** Amount to withdraw for A in nanotons (string, usually "0") */
  withdrawA: string;
  /** Amount to withdraw for B in nanotons (string) */
  withdrawB: string;
  /** Base64-encoded server's commit signature (B side) */
  serverSignature: string;
}

// ---------------------------------------------------------------------------
// Storage interface — pluggable persistence
// ---------------------------------------------------------------------------

/**
 * Pluggable key-value storage interface for persisting channel state.
 *
 * Any storage backend (in-memory, Redis, filesystem, etc.) can be used by implementing
 * this interface and passing it to {@link StateManager}.
 */
export interface StateStorage {
  /**
   * Retrieve a value by key.
   *
   * @param key - Storage key
   * @returns The stored string value, or null if not found
   */
  get(key: string): Promise<string | null>;

  /**
   * Store a value under a key, overwriting any previous value.
   *
   * @param key   - Storage key
   * @param value - String value to store
   */
  set(key: string, value: string): Promise<void>;

  /**
   * Delete a key-value pair from storage. No-op if the key does not exist.
   *
   * @param key - Storage key to remove
   */
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Discriminant error codes returned by {@link verifyPaymentSignature}.
 *
 * - `invalid_signature`   — Ed25519 signature verification failed
 * - `stale_seqno`         — seqnoA did not increase strictly from the last accepted state
 * - `insufficient_payment`— paid amount is less than the requested price
 * - `balance_mismatch`    — balanceA + balanceB != initBalanceA + initBalanceB
 * - `price_exceeds_max`   — requested price exceeds the client's configured maximum
 * - `unknown_channel`     — channelAddress or channelId does not match the server's channel
 * - `invalid_payload`     — header is malformed, missing fields, or has wrong binary lengths
 * - `channel_exhausted`   — client's balance is insufficient to pay the price
 */
export type VerifyErrorCode =
  | "invalid_signature"
  | "stale_seqno"
  | "insufficient_payment"
  | "balance_mismatch"
  | "price_exceeds_max"
  | "unknown_channel"
  | "invalid_payload"
  | "channel_exhausted";
