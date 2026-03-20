/**
 * pc402-core — High-level helpers
 *
 * Convenience functions built on top of the core protocol primitives.
 * Framework-agnostic and usable by both client and server implementations.
 */

import type { KeyPair } from "@ton/crypto";
import { parsePaymentSignature } from "./protocol.js";
import type {
  ChannelConfig,
  ChannelState,
  PC402CloseRequest,
  PC402PaymentRequirements,
} from "./types.js";

/**
 * Extract channel identity and client public key from a PAYMENT-SIGNATURE header.
 *
 * Useful on the server side for channel lookup before constructing a full PaymentChannel.
 *
 * @param header - Raw base64-encoded `PAYMENT-SIGNATURE` header value
 * @returns Object with channelAddress, channelId, and publicKey, or null if the header is malformed
 */
export function resolveChannelFromPayload(header: string): {
  channelAddress: string;
  channelId: string;
  publicKey: string;
} | null {
  const parsed = parsePaymentSignature(header);
  if (!parsed) return null;
  const { payload } = parsed;
  return {
    channelAddress: payload.channelAddress,
    channelId: payload.channelId,
    publicKey: payload.publicKey,
  };
}

/**
 * Build a {@link ChannelConfig} for the client side from a parsed PAYMENT-REQUIRED header.
 *
 * Returns null if the requirements do not include a `channel` field (discovery mode).
 *
 * @param requirements - Parsed PC402PaymentRequirements (must include `channel`)
 * @param myKeyPair    - Client's Ed25519 key pair
 * @param myAddress    - Client's TON wallet address (accepted for API consistency, not stored in config)
 * @returns Object with channelConfig ready to pass to PaymentChannel, or null in discovery mode
 */
export function channelConfigFromRequirements(
  requirements: PC402PaymentRequirements,
  myKeyPair: KeyPair,
): { channelConfig: ChannelConfig } | null {
  if (!requirements.channel) return null;

  const channelConfig: ChannelConfig = {
    channelId: BigInt(requirements.channel.channelId),
    isA: true, // client is always party A
    myKeyPair,
    hisPublicKey: Buffer.from(requirements.payee.publicKey, "hex"),
    initBalanceA: BigInt(requirements.channel.initBalanceA),
    initBalanceB: BigInt(requirements.channel.initBalanceB),
  };

  return { channelConfig };
}

/**
 * Convert cumulative sentCoins back to a balance.
 *
 * Inverse of `balanceToSentCoins`: `balance = initBalance - sent`.
 * Returns 0n if sent exceeds initBalance (should not happen with valid data).
 *
 * @param initBalance - Initial deposit in nanotons
 * @param sent        - Cumulative amount sent in nanotons
 * @returns Current balance in nanotons
 */
export function sentToBalance(initBalance: bigint, sent: bigint): bigint {
  const balance = initBalance - sent;
  return balance < 0n ? 0n : balance;
}

/**
 * Reconstruct a {@link ChannelState} from a {@link PC402CloseRequest}.
 *
 * Useful on the client side to verify the server's close signature:
 * the client needs a ChannelState to call `PaymentChannel.verifyClose()`.
 *
 * @param closeRequest   - The close request from the server's PAYMENT-RESPONSE
 * @param initBalanceA   - A's initial deposit in nanotons
 * @param initBalanceB   - B's initial deposit in nanotons
 * @param lastState      - The last accepted off-chain state (for seqnos)
 * @returns ChannelState suitable for `verifyClose`
 */
export function stateFromCloseRequest(
  closeRequest: PC402CloseRequest,
  initBalanceA: bigint,
  initBalanceB: bigint,
  lastState: ChannelState,
): ChannelState {
  return {
    balanceA: sentToBalance(initBalanceA, BigInt(closeRequest.sentA)),
    balanceB: sentToBalance(initBalanceB, BigInt(closeRequest.sentB)),
    seqnoA: lastState.seqnoA,
    seqnoB: lastState.seqnoB,
  };
}
