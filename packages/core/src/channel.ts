/**
 * pc402-core — PaymentChannel
 *
 * Implements off-chain state signing and verification for v2 TON payment channels.
 *
 * v2 Signature model:
 *   Each party signs their OWN individual body (no combined cell).
 *
 *   signState (party X):  sign hash of X's body
 *     body = TAG_STATE(32) + channelId(128) + seqnoX(64) + sentX(coins) + condHash(256=0)
 *
 *   verifyState (verify counterparty's sig):  verify hash of THEIR body
 *
 *   signClose / verifyClose: both parties sign the SAME cooperative close body
 *     body = TAG_CLOSE(32) + channelId(128) + sentA(coins) + sentB(coins)
 */

import { beginCell, type Cell } from "@ton/core";
import { sign, signVerify } from "@ton/crypto";
import {
  balanceToSentCoins,
  buildSemiChannelBodyWithHeader,
  TAG_CLOSE,
  TAG_COMMIT,
  TAG_STATE,
} from "./cell.js";
import { ChannelError, PC402ErrorCode, ValidationError } from "./errors.js";
import type { ChannelConfig, ChannelState } from "./types.js";

/**
 * Off-chain payment channel logic for the pc402 protocol.
 *
 * Handles state signing, signature verification, and balance transitions
 * for one party of a bidirectional TON payment channel.
 *
 * @example
 * ```typescript
 * const channel = new PaymentChannel({
 *   channelId: 1n,
 *   isA: true,
 *   myKeyPair: keyPairA,
 *   hisPublicKey: keyPairB.publicKey,
 *   initBalanceA: toNano("1"),
 *   initBalanceB: 0n,
 * });
 * const state = { balanceA: toNano("0.9"), balanceB: toNano("0.1"), seqnoA: 1, seqnoB: 0 };
 * const sig = channel.signState(state);
 * ```
 */
export class PaymentChannel {
  /** Frozen channel configuration passed at construction. */
  readonly config: Readonly<ChannelConfig>;

  /**
   * Create a PaymentChannel instance for one party.
   *
   * @param config - Channel configuration including keys, channelId, and initial balances
   */
  constructor(config: ChannelConfig) {
    this.config = Object.freeze({ ...config });
  }

  // ---------------------------------------------------------------------------
  // Core: sign & verify
  // ---------------------------------------------------------------------------

  /**
   * Sign a state from this party's point of view.
   *
   * Builds this party's individual body and signs its hash with `myKeyPair`.
   * The resulting signature can be submitted to the contract
   * as part of a SignedSemichannel: sig(512 bits inline) + ref(body cell).
   *
   * Body layout: TAG_STATE(32) + channelId(128) + seqno(64) + sentCoins(Coins) + condHash(256=0)
   *
   * @param state - Current channel state (balances + sequence numbers)
   * @returns 64-byte Ed25519 signature buffer
   */
  signState(state: ChannelState): Buffer {
    const cell = this._buildStateCell(state, this.config.isA, TAG_STATE);
    return Buffer.from(sign(cell.hash(), this.config.myKeyPair.secretKey));
  }

  /**
   * Verify the counterparty's signature on a state.
   *
   * Reconstructs the counterparty's individual body and verifies
   * their Ed25519 signature using `hisPublicKey`.
   *
   * @param state     - Channel state to verify the signature against
   * @param signature - 64-byte Ed25519 signature from the counterparty
   * @returns true if the signature is valid, false otherwise
   */
  verifyState(state: ChannelState, signature: Buffer): boolean {
    const cell = this._buildStateCell(state, !this.config.isA, TAG_STATE);
    return signVerify(cell.hash(), signature, this.config.hisPublicKey);
  }

  /**
   * Sign a cooperative close message.
   *
   * Both parties sign the same body derived from `state`:
   *   TAG_CLOSE(32) + channelId(128) + sentA(Coins) + sentB(Coins)
   *
   * Both signatures must be submitted together in the cooperativeClose on-chain message.
   *
   * @param state - Final channel state (balances + sequence numbers)
   * @returns 64-byte Ed25519 signature buffer
   */
  signClose(state: ChannelState): Buffer {
    const cell = this._buildStateCell(state, this.config.isA, TAG_CLOSE);
    return Buffer.from(sign(cell.hash(), this.config.myKeyPair.secretKey));
  }

  /**
   * Verify the counterparty's cooperative close signature.
   *
   * Both parties sign the same close body, so the verification is symmetric.
   * Uses `hisPublicKey` to verify the counterparty's 64-byte signature.
   *
   * @param state     - Final channel state used to reconstruct the signed body
   * @param signature - 64-byte Ed25519 signature from the counterparty
   * @returns true if the signature is valid, false otherwise
   */
  verifyClose(state: ChannelState, signature: Buffer): boolean {
    const cell = this._buildStateCell(state, !this.config.isA, TAG_CLOSE);
    return signVerify(cell.hash(), signature, this.config.hisPublicKey);
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /**
   * Create the next state after this party pays `amount` to the counterparty.
   *
   * Enforces balance conservation: balanceA + balanceB must remain equal to
   * initBalanceA + initBalanceB. The paying party's seqno is incremented by 1.
   *
   * When A pays B: balanceA -= amount, balanceB += amount, seqnoA++.
   * When B pays A: balanceB -= amount, balanceA += amount, seqnoB++.
   *
   * @param currentState - The current accepted channel state
   * @param amount       - Amount to pay in nanotons (must be positive and <= payer's balance)
   * @returns New channel state reflecting the payment
   * @throws {ValidationError} If amount is not positive
   * @throws {ChannelError}    If amount exceeds this party's current balance
   */
  createPaymentState(currentState: ChannelState, amount: bigint): ChannelState {
    if (amount <= 0n) {
      throw new ValidationError("Payment amount must be positive", PC402ErrorCode.INVALID_AMOUNT);
    }

    const myBalance = this.config.isA ? currentState.balanceA : currentState.balanceB;

    if (amount > myBalance) {
      throw new ChannelError(
        `Insufficient balance: have ${myBalance}, need ${amount}`,
        PC402ErrorCode.INSUFFICIENT_BALANCE,
      );
    }

    if (this.config.isA) {
      return {
        balanceA: currentState.balanceA - amount,
        balanceB: currentState.balanceB + amount, // B receives
        seqnoA: currentState.seqnoA + 1,
        seqnoB: currentState.seqnoB,
      };
    } else {
      return {
        balanceA: currentState.balanceA + amount, // A receives
        balanceB: currentState.balanceB - amount,
        seqnoA: currentState.seqnoA,
        seqnoB: currentState.seqnoB + 1,
      };
    }
  }

  /**
   * Get this party's current balance from a channel state.
   *
   * Returns `balanceA` if `config.isA` is true, `balanceB` otherwise.
   *
   * @param state - The channel state to read from
   * @returns This party's balance in nanotons
   */
  getMyBalance(state: ChannelState): bigint {
    return this.config.isA ? state.balanceA : state.balanceB;
  }

  // ---------------------------------------------------------------------------
  // Commit signing (for HTTP 402 commit protocol)
  // ---------------------------------------------------------------------------

  /**
   * Sign a cooperative commit payload.
   *
   * Used by the client to co-sign a commit request from the server.
   * The commit payload has the same structure as the on-chain cooperativeCommit message:
   *   TAG_COMMIT(32) + channelId(128) + seqnoA(64) + seqnoB(64) + sentA + sentB + withdrawA + withdrawB
   *
   * @param seqnoA    - Committed sequence number for A
   * @param seqnoB    - Committed sequence number for B
   * @param sentA     - Total sent by A in nanotons
   * @param sentB     - Total sent by B in nanotons
   * @param withdrawA - Amount to withdraw for A in nanotons
   * @param withdrawB - Amount to withdraw for B in nanotons
   * @returns 64-byte Ed25519 signature buffer
   */
  signCommit(
    seqnoA: bigint,
    seqnoB: bigint,
    sentA: bigint,
    sentB: bigint,
    withdrawA: bigint = 0n,
    withdrawB: bigint = 0n,
  ): Buffer {
    const payloadCell = beginCell()
      .storeUint(TAG_COMMIT, 32)
      .storeUint(this.config.channelId, 128)
      .storeUint(seqnoA, 64)
      .storeUint(seqnoB, 64)
      .storeCoins(sentA)
      .storeCoins(sentB)
      .storeCoins(withdrawA)
      .storeCoins(withdrawB)
      .endCell();

    return Buffer.from(sign(payloadCell.hash(), this.config.myKeyPair.secretKey));
  }

  /**
   * Verify a commit signature from the counterparty.
   *
   * @param seqnoA    - Committed sequence number for A
   * @param seqnoB    - Committed sequence number for B
   * @param sentA     - Total sent by A in nanotons
   * @param sentB     - Total sent by B in nanotons
   * @param signature - 64-byte Ed25519 signature to verify
   * @param withdrawA - Amount to withdraw for A in nanotons
   * @param withdrawB - Amount to withdraw for B in nanotons
   * @returns true if the signature is valid
   */
  verifyCommit(
    seqnoA: bigint,
    seqnoB: bigint,
    sentA: bigint,
    sentB: bigint,
    signature: Buffer,
    withdrawA: bigint = 0n,
    withdrawB: bigint = 0n,
  ): boolean {
    const payloadCell = beginCell()
      .storeUint(TAG_COMMIT, 32)
      .storeUint(this.config.channelId, 128)
      .storeUint(seqnoA, 64)
      .storeUint(seqnoB, 64)
      .storeCoins(sentA)
      .storeCoins(sentB)
      .storeCoins(withdrawA)
      .storeCoins(withdrawB)
      .endCell();

    return signVerify(payloadCell.hash(), signature, this.config.hisPublicKey);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the cell whose hash will be signed.
   *
   * @param state  - the channel state (balances + seqnos)
   * @param fromA  - true = build from A's data; false = build from B's data
   *                 (ignored for TAG_CLOSE: both parties sign the same body)
   * @param tag    - TAG_STATE or TAG_CLOSE
   *
   * TAG_STATE: individual per-party body
   *   tag(32) + channelId(128) + seqno(64) + sent(coins) + condHash(256=0)
   *
   * TAG_CLOSE: cooperative close body (same for both parties)
   *   tag(32) + channelId(128) + sentA(coins) + sentB(coins)
   */
  private _buildStateCell(state: ChannelState, fromA: boolean, tag: number): Cell {
    const { channelId, initBalanceA, initBalanceB } = this.config;

    const sentA = balanceToSentCoins(initBalanceA, state.balanceA);
    const sentB = balanceToSentCoins(initBalanceB, state.balanceB);

    if (tag === TAG_CLOSE) {
      // Cooperative close: both parties sign the same body containing seqnos + sentA + sentB
      return beginCell()
        .storeUint(TAG_CLOSE, 32)
        .storeUint(channelId, 128)
        .storeUint(state.seqnoA, 64)
        .storeUint(state.seqnoB, 64)
        .storeCoins(sentA)
        .storeCoins(sentB)
        .endCell();
    }

    // TAG_STATE: each party signs their own individual body
    const seqno = fromA ? state.seqnoA : state.seqnoB;
    const sent = fromA ? sentA : sentB;
    return buildSemiChannelBodyWithHeader(channelId, seqno, sent, tag);
  }
}
