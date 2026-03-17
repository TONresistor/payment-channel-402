// pc402-core — barrel export

// Cell builder
export {
  balanceToSentCoins,
  buildSemiChannelBody,
  buildSemiChannelBodyWithHeader,
  TAG_CLOSE,
  TAG_STATE,
} from "./cell.js";
// Payment channel
export { PaymentChannel } from "./channel.js";
// Errors
export {
  ChannelError,
  PC402Error,
  PC402ErrorCode,
  ProtocolError,
  SignatureError,
  ValidationError,
} from "./errors.js";
export type { VerifyPaymentResult } from "./protocol.js";
// Protocol helpers (HTTP 402 header encoding/decoding, building/parsing, verification)
export {
  buildPaymentRequired,
  buildPaymentResponse,
  buildPaymentSignature,
  decodeHeader,
  encodeHeader,
  parsePaymentRequired,
  parsePaymentResponse,
  parsePaymentSignature,
  verifyPaymentSignature,
} from "./protocol.js";
// State manager
export { StateManager } from "./state.js";
export { FileStorage } from "./storage/file.js";
// Storage implementations
export { MemoryStorage } from "./storage/memory.js";
// Types
export type {
  ChannelConfig,
  ChannelState,
  PC402CommitRequest,
  PC402PaymentPayload,
  PC402PaymentRequirements,
  PC402PaymentResponse,
  PC402PaymentSignature,
  StateStorage,
  VerifyErrorCode,
} from "./types.js";
