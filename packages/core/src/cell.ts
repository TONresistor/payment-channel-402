/**
 * pc402-core — Cell builder
 *
 * Builds the exact Cell layout expected by the v2 TON payment channel
 * smart contract (payment-channel.tolk).
 *
 * v2 layout — per-party SignedSemichannel (for uncooperative close):
 *   sig(512 bits inline) + ^(tag:32 + channelId:128 + seqno:64 + sent:Coins + conditionalsHash:256)
 *
 * v2 layout — cooperative close body (signed by both parties):
 *   TAG_COOPERATIVE_CLOSE(32) + channelId(128) + sentA(Coins) + sentB(Coins)
 */

import { beginCell, type Cell } from "@ton/core";

/**
 * 32-bit tag used in per-party SemiChannelBody cells (state updates, uncooperative close).
 * Value: `0x50433453` ("PC4S" — Payment Channel 402 State).
 */
export const TAG_STATE = 0x50433453;

/**
 * 32-bit tag used in cooperative close bodies (signed by both parties).
 * Matches `TAG_COOPERATIVE_CLOSE` in the v2 contract (`0x8243e9a3`).
 */
export const TAG_CLOSE = 0x8243e9a3;

/**
 * Build a raw SemiChannelBody cell (inner body without tag/channelId header).
 *
 * Layout: seqno(uint64) + sentCoins(Coins) + conditionalsHash(uint256=0)
 *
 * This is the inner ref used inside a full SignedSemichannel cell.
 * For the signable body that includes the tag and channelId header,
 * use {@link buildSemiChannelBodyWithHeader} instead.
 *
 * @param seqno     - Monotonic sequence number of the signing party (uint64)
 * @param sentCoins - Cumulative amount sent by the signing party in nanotons
 * @returns Cell containing the raw semichannel body
 */
export function buildSemiChannelBody(seqno: number, sentCoins: bigint): Cell {
  return beginCell()
    .storeUint(seqno, 64)
    .storeCoins(sentCoins)
    .storeUint(0n, 256) // conditionalsHash = 0 (no conditionals)
    .endCell();
}

/**
 * Build a full per-party body cell with tag/channelId header.
 *
 * This is the cell whose hash is signed by one party's Ed25519 key
 * in the uncooperative close path.
 *
 * Layout: tag(32) + channelId(128) + seqno(64) + sentCoins(Coins) + conditionalsHash(256=0)
 *
 * The SignedSemichannel submitted on-chain is: sig(512 bits inline) + ref(this cell).
 *
 * @param channelId - Unique channel identifier (uint128)
 * @param seqno     - Monotonic sequence number of the signing party (uint64)
 * @param sentCoins - Cumulative amount sent by the signing party in nanotons
 * @param tag       - 32-bit signature tag; defaults to {@link TAG_STATE}
 * @returns Cell containing the complete signable body
 */
export function buildSemiChannelBodyWithHeader(
  channelId: bigint,
  seqno: number,
  sentCoins: bigint,
  tag: number = TAG_STATE,
): Cell {
  return beginCell()
    .storeUint(tag, 32)
    .storeUint(channelId, 128)
    .storeUint(seqno, 64)
    .storeCoins(sentCoins)
    .storeUint(0n, 256) // conditionalsHash
    .endCell();
}

/**
 * Convert a balance pair to the cumulative sentCoins value.
 *
 * sentCoins = initBalance - currentBalance
 *
 * sentCoins is monotonically non-decreasing (total sent since channel open).
 * Returns 0n when currentBalance exceeds initBalance (net receiver, no sent coins).
 *
 * @param initBalance    - Initial deposit of the party in nanotons
 * @param currentBalance - Current balance of the party in nanotons
 * @returns Cumulative sent amount in nanotons (always >= 0n)
 */
export function balanceToSentCoins(initBalance: bigint, currentBalance: bigint): bigint {
  const sent = initBalance - currentBalance;
  if (sent < 0n) return 0n; // Balance exceeds init = received more than sent, net sentCoins = 0
  return sent;
}
