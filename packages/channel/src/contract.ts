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
  "te6ccgECJwEACDEAART/APSkE/S88sgLAQIBIAIDAgFIBAUACvJsMfAIAgLMBgcCASAlJgIBIAgJAD/emPkMEIaVj3dd1JmPgCcADBCAO1/vjdSXgC8EIH+XhAIBIAoLAgEgEhMCASAMDQIBIA4PAAU8AeAA0Qg+HHtRNDSAAH4YdQB0PoAAfhi+gAB+GP6AAH4ZPoAAfhl+gAB+Gb6ADD4Z9P/Afho0/8B+GnTfwH4atQB0NMf+gDXCx9vA/hrIcIAn9M/Afhs0z8B+G30BAH4bt4BwgGU1AH4b974cIADdPhRyPhC+gL4Q/oC+ET6AvhF+gL4RvoC+Ef6AsnI+EtvEM8LH/hLbxH6AvhLbxLPCx/J+EHIygASzPhIzwv/+EnPC//4Ss8Lf8whwgCf+EzPCz/4Tc8LP/hOAfQA3gHCAZT4T88UlPhQzxbiye1UgAvU+E/Q+gAx+kj6SDD4QvhHoPhGofhEofhD+Eag+Eeh+EWhIcEAk6BwAd4gwQCSoHDeIYIID0JAuZOgcAHeIIIID0JAuZKgcN4gwgCOHPhKcsjPhQgV+lJY+gKCEN3ciLrPC4rLf8lY+wCSMDHiIMIAkVvjDXD4YXD4YnCAQEQA8+EqBAILIz4UIFPpSWPoCghDd3Ii6zwuKy3/JAfsAACb4Y3D4ZHD4ZXD4ZnD4Z234bvACAgEgFBUCASAYGQDVHLwAfhB8uCC1AHQAdQB0CH5AfhIVEFV+RDy4IP4SRAj+RDy4ITTHwGCEIJD6aO68uCH+EoB038CuvLgh/oA+gAwAfhm+Gf4QvhHoPhGofhEocL/8uCF+EP4RqD4R6H4RaHC//LghvgA8AOAB9xy8AH4QfLgeNQB0AHUAdAh+QH4SFRBVfkQ8uB5+EkQI/kQ8uB60x8BghBKOQysuvLgf/hKAdN/Arry4H/TP9M/+Ewju/Lge/hNIrvy4Hz6APoA+gD6ADAD+GYB+Gf4RCGg+GT4RSKg+GX4QvhHoPhGofhEocL/8uB9+EOAWAfj4RqD4R6H4RaHC//LgfiDCACLCALGOUfhP0PoAMfpI+kgwIsIAjhv4SsjPhQgTzlAD+gKCEKMvCzzPC4rLf8lz+wCSbCHiIcIAjhr4SsjPhQgSzlj6AoIQoy8LPM8List/yXP7AJFb4pFb4iH4bCD4bfhObpFb4w74APACFwAw+E7Q0z/6ADHT/zHXCz8DuQK8sZNt+G7eAGEA4MI1xjXTNAg+QFABPkQ8vTTHwGCEFBDNFO6UiDy9PhKAdN/AroS8vTTP/oA1wv/gBJ0bBLTHwLQ0wMx+kgwIYIQWT44k7rjAjAgghB5rpm1uuMCMiGCENKx7uu6kzHwBOAhghAHa/3xupMx8AXgIYIQgXXhXbrjAiGCEJp3wNu6gGhscHQH+MXLwAQHSAPoAMPhP0PoA+kj6SDAklzAkxwXy4G+XMSTHBfLgb+IClfhCoPhilfhDoPhj4vhC+Eeg+Eah+ESh+EP4RqD4R6H4RaGgIaBQA7vy4HDwAvhC+Eeg+Eah+EShEqD4Q/hGoPhHofhFoaBy+wLIz4UIzoIQ1TJ2288Ljh4AxjBy8AH4QfLQZNIAgwjXGCD5AfhI+EkQJeMEQzD5EPLgZ9MfAYIQSB68RLry4Gj4SgHTfwK68uBo+gD6ADD4QiK7+EMiu7Dy4GYB+GL4Y/hP0PoAMPhC+EOgoL7y4GZ/+GHwAgH8MXHwAfhB8uCM+E5u8uCT0gCDCNcYIPkB+Ej4SSVZ4wRBMPkQ8uCN0x8BghCMYjaSuvLgkvhKAdN/Arry4JLUAdAB10zQ+EgSgQCOgQCS8Ab4SRSBAI+BAJLwBvhMJbvy4JD4TSO78uCRBMjLP1AD+gIUy/8Tyz9Y+gLL//gjHwLs4wIhghBWw5tMuuMCMIIQJUMqkbqOW3LwAfhObvLQq/hO0NM/+gDT/zHTP/oA0/8x0x/SANcKAPhLbxAToPhLbxKg+CO78uCqBPhmAfhns44U+EtvEQKW+EZYoPhmlvhHWKD4Z+KRMeIBpPhspPht8APghA/y8CAhAAzJgQCC+wAAGM8LH8oAz4HJ+G7wAgH+MXHwAfhObvLQltIAgwjXGCD5AfhI+EklWeMEQTD5EPLgmdMfAYIQuKITebry4J34SgHTfwK68uCd1AHQAddM0PhIEoEAmoEAnfAG+EkUgQCbgQCd8Ab4TtDTP/oAMdP/MdM/+gAx0/8x0x/XCgD4S28QEqD4I7zy4JcpuvLQmCIC/jFx8AH4Tm7y0KDSAIMI1xgg+QH4SPhJJVnjBEEw+RDy4KLTHwGCEBRYiqu68uCk+EoB038CuvLgpNdM+E7Q0z/6ANP/0z/6ANP/0x/SANcKAPhLbxAjoCD4I7vy4KD4S28SoPgjvPLgoVR2epNbUzTeK/kAWLry4KMK0PQFiuYjJABaUmK8UkK8sfLgnATIyz9QA/oCFMv/E8s/WPoCy//4I88LH8oAf88KAMn4bvACAEKAIPSWb6UxII4RAfoA7R6LCAHaEZMcoAuRMOKRMeKzwwAAXjAKk2wicJc1NRYUcFBE4gbIyz9QBfoCE8v/yz9QBPoCEsv/EssfygDKAMn4bvACAKm8f+OXgA/CfofQB9JH0kGEEA0Mr2oex8IXwj0HwjUPwiUPwh/CNQfCPQ/CLQ/CF8IfwifCK3g3wkfCS3gXwlfCX8Jnwmt4F8JyTDt4GII4gbIqAhmEAJG9DKuXgA/CDgAEi4cHwnN0i48HwnaGmfmP0AGOn/mOmfmP0AGOn/mOuFj/wlt4gQ0HwR3kkYOXB8JbeIUHwlt4lQfBHeSLnwOk";

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
