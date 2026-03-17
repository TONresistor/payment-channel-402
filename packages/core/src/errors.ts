/**
 * pc402-core — Custom error hierarchy
 *
 * All SDK errors extend PC402Error with a discriminant `code` field.
 * Use `instanceof` to narrow: `if (err instanceof SignatureError) { ... }`
 */

/** Error codes for programmatic error handling. */
export enum PC402ErrorCode {
  // Signature
  INVALID_SIGNATURE = "INVALID_SIGNATURE",
  SIGNATURE_VERIFICATION_FAILED = "SIGNATURE_VERIFICATION_FAILED",

  // Channel state
  CHANNEL_NOT_OPEN = "CHANNEL_NOT_OPEN",
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  SEQNO_REGRESSION = "SEQNO_REGRESSION",

  // Protocol (HTTP 402)
  INVALID_HEADER = "INVALID_HEADER",
  MISSING_FIELD = "MISSING_FIELD",
  PAYMENT_TOO_LOW = "PAYMENT_TOO_LOW",
  PAYMENT_STALE = "PAYMENT_STALE",
  IDENTITY_MISMATCH = "IDENTITY_MISMATCH",

  // Input validation
  INVALID_AMOUNT = "INVALID_AMOUNT",
  INVALID_KEY = "INVALID_KEY",
  INVALID_CHANNEL_ID = "INVALID_CHANNEL_ID",
  INVALID_BUFFER_LENGTH = "INVALID_BUFFER_LENGTH",
}

/** Base error class for all pc402 SDK errors. */
export class PC402Error extends Error {
  constructor(
    message: string,
    public readonly code: PC402ErrorCode,
  ) {
    super(message);
    this.name = "PC402Error";
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/** Thrown when an Ed25519 signature is invalid or verification fails. */
export class SignatureError extends PC402Error {
  override readonly name = "SignatureError";
}

/** Thrown when a channel operation fails (wrong state, insufficient balance, etc). */
export class ChannelError extends PC402Error {
  override readonly name = "ChannelError";
}

/** Thrown when HTTP 402 protocol encoding/decoding or verification fails. */
export class ProtocolError extends PC402Error {
  override readonly name = "ProtocolError";
}

/** Thrown when input parameters fail validation before any operation. */
export class ValidationError extends PC402Error {
  override readonly name = "ValidationError";
}
