/**
 * pc402-channel — Contract bytecode and stateInit builder
 *
 * Uses the custom pc402 Tolk payment channel contract v2 (payment-channel.tolk).
 * The data cell layout matches pc402-contract/contracts/storage.tolk.
 */

import { type Address, beginCell, Cell, type StateInit } from "@ton/core";

/**
 * Base64-encoded compiled BOC of the pc402 payment channel smart contract v2.
 * Source: `pc402-contract/build/payment-channel.json` — `codeBoc64` field.
 * @internal
 */
const PAYMENT_CHANNEL_CODE_BOC64 =
  "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";

/**
 * Parsed Cell containing the compiled bytecode of the pc402 payment channel contract v2.
 *
 * Used as the `code` field in the stateInit when deploying a new channel contract.
 * Embed directly — do not re-parse on every call.
 */
export const PAYMENT_CHANNEL_CODE: Cell = Cell.fromBase64(PAYMENT_CHANNEL_CODE_BOC64);

/**
 * Configuration required to build the initial data cell for a payment channel contract.
 *
 * All fields are written into the contract's persistent storage at deploy time.
 * Changing any field produces a different contract address.
 */
export interface ChannelInitConfig {
  /** A's Ed25519 public key (32 bytes) */
  publicKeyA: Buffer;
  /** B's Ed25519 public key (32 bytes) */
  publicKeyB: Buffer;
  /** Unique channel identifier (uint128) */
  channelId: bigint;
  /** A's address */
  addressA: Address;
  /** B's address */
  addressB: Address;
  /** Quarantine duration in seconds (default 3*24*3600) */
  quarantineDuration?: number;
  /** Misbehavior fine in nanotons (default 0) */
  misbehaviorFine?: bigint;
  /** Conditional close duration in seconds (default 24*3600) */
  conditionalCloseDuration?: number;
  /** Storage fee in nanotons (default 10000000 = 0.01 TON) */
  storageFee?: bigint;
}

/**
 * Build the initial data Cell for the payment channel contract v2.
 *
 * Layout from storage.tolk:
 *   inited(1 bit signed = 0)
 *   ^Balance ref: depositA depositB withdrawnA withdrawnB sentA sentB (6 coins)
 *   keyA(uint256) keyB(uint256) channelId(uint128)
 *   ^ClosureConfig ref: quarantineDuration(uint32) fine(coins) closeDuration(uint32)
 *   commitedSeqnoA(uint64=0) commitedSeqnoB(uint64=0)
 *   quarantine(Maybe ref = 0 bit)
 *   ^PaymentConfig ref: storageFee(coins) addressA addressB
 */
function buildChannelDataCell(config: ChannelInitConfig): Cell {
  const quarantineDuration = config.quarantineDuration ?? 3 * 24 * 3600;
  const misbehaviorFine = config.misbehaviorFine ?? 0n;
  const conditionalCloseDuration = config.conditionalCloseDuration ?? 24 * 3600;
  const storageFee = config.storageFee ?? 10_000_000n;

  // Balance ref (6 coin fields, all zero at init)
  const balanceRef = beginCell()
    .storeCoins(0n) // depositA
    .storeCoins(0n) // depositB
    .storeCoins(0n) // withdrawnA
    .storeCoins(0n) // withdrawnB
    .storeCoins(0n) // sentA
    .storeCoins(0n) // sentB
    .endCell();

  // ClosureConfig ref
  const closureConfigRef = beginCell()
    .storeUint(quarantineDuration, 32)
    .storeCoins(misbehaviorFine)
    .storeUint(conditionalCloseDuration, 32)
    .endCell();

  // PaymentConfig ref
  const paymentConfigRef = beginCell()
    .storeCoins(storageFee)
    .storeAddress(config.addressA)
    .storeAddress(config.addressB)
    .endCell();

  return beginCell()
    .storeInt(0, 1) // inited = false (1 bit signed)
    .storeRef(balanceRef) // ^Balance
    .storeBuffer(config.publicKeyA, 32) // keyA (uint256)
    .storeBuffer(config.publicKeyB, 32) // keyB (uint256)
    .storeUint(config.channelId, 128) // channelId (uint128)
    .storeRef(closureConfigRef) // ^ClosureConfig
    .storeUint(0n, 64) // commitedSeqnoA (uint64)
    .storeUint(0n, 64) // commitedSeqnoB (uint64)
    .storeUint(0, 1) // quarantine = Maybe null (0 bit)
    .storeRef(paymentConfigRef) // ^PaymentConfig
    .endCell();
}

/**
 * Create the stateInit (code + data) for a payment channel contract v2.
 *
 * The stateInit uniquely determines the contract address. Passing the same
 * `config` always produces the same address (deterministic deployment).
 *
 * @param config - Channel initialization configuration; see {@link ChannelInitConfig}
 * @returns {@link StateInit} containing the contract code and initial data cell
 */
export function createChannelStateInit(config: ChannelInitConfig): StateInit {
  return {
    code: PAYMENT_CHANNEL_CODE,
    data: buildChannelDataCell(config),
  };
}
