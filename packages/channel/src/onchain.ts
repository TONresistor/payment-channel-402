/**
 * pc402-channel -- OnchainChannel
 *
 * Manages the full on-chain lifecycle of a TON payment channel:
 * deploy, topUp, init, cooperativeClose, cooperativeCommit,
 * startUncooperativeClose, challengeQuarantinedState,
 * settleConditionals, finishUncooperativeClose.
 *
 * Uses the custom pc402 Tolk payment channel contract v2.
 */

import {
  type Address,
  beginCell,
  type Cell,
  contractAddress,
  type Sender,
  type StateInit,
  toNano,
} from "@ton/core";
import { type KeyPair, sign } from "@ton/crypto";
import type { TonClient } from "@ton/ton";
import {
  PC402ErrorCode,
  TAG_CHALLENGE_QUARANTINE,
  TAG_CLOSE as TAG_COOPERATIVE_CLOSE,
  TAG_COMMIT as TAG_COOPERATIVE_COMMIT,
  TAG_INIT,
  TAG_SETTLE_CONDITIONALS,
  TAG_START_UNCOOPERATIVE_CLOSE,
  TAG_STATE,
  ValidationError,
} from "pc402-core";
import { type ChannelInitConfig, createChannelStateInit } from "./contract.js";

// On-chain operation codes (v2 — from messages.tolk)
const OP_TOP_UP = 0x593e3893;
const OP_INIT_CHANNEL = 0x79ae99b5;
const OP_COOPERATIVE_CLOSE = 0xd2b1eeeb;
const OP_COOPERATIVE_COMMIT = 0x076bfdf1;
const OP_START_UNCOOPERATIVE_CLOSE = 0x8175e15d;
const OP_CHALLENGE_QUARANTINE = 0x9a77c0db;
const OP_SETTLE_CONDITIONALS = 0x56c39b4c;
const OP_FINISH_UNCOOPERATIVE_CLOSE = 0x25432a91; // pc402

// Gas allowances (measured from mainnet E2E v2 transactions)
// Surplus is refunded by the contract's sendExcess() / reserveToncoinsOnBalance pattern.
// GAS_DEPLOY must cover storageFee (0.01) + forward fees (~0.002) for reopen after close.
const GAS_DEPLOY = toNano("0.02"); // covers storageFee + fwd_fee on reopen from zero balance
const GAS_STANDARD = toNano("0.008"); // measured: 0.004 max contract compute
const GAS_CLOSE = toNano("0.008"); // measured: 0.006 max (close sends 2 outbound msgs)

// Re-export tags for external use
// Re-export opcodes for external use
export {
  OP_CHALLENGE_QUARANTINE,
  OP_COOPERATIVE_CLOSE,
  OP_COOPERATIVE_COMMIT,
  OP_FINISH_UNCOOPERATIVE_CLOSE,
  OP_INIT_CHANNEL,
  OP_SETTLE_CONDITIONALS,
  OP_START_UNCOOPERATIVE_CLOSE,
  OP_TOP_UP,
  TAG_CHALLENGE_QUARANTINE,
  TAG_COOPERATIVE_CLOSE,
  TAG_COOPERATIVE_COMMIT,
  TAG_INIT,
  TAG_SETTLE_CONDITIONALS,
  TAG_START_UNCOOPERATIVE_CLOSE,
  TAG_STATE,
};

/**
 * Configuration options for constructing an {@link OnchainChannel} instance.
 */
export interface OnchainChannelOptions {
  /** TonClient instance used to send messages and call get-methods. */
  client: TonClient;
  /** Ed25519 key pair of this party (A or B). */
  myKeyPair: KeyPair;
  /** Ed25519 public key of the counterparty (32 bytes). */
  counterpartyPublicKey: Buffer;
  /** true if this party is A, false if B. */
  isA: boolean;
  /** Unique channel identifier (uint128, must be positive). */
  channelId: bigint;
  /** TON address of this party. */
  myAddress: Address;
  /** TON address of the counterparty. */
  counterpartyAddress: Address;
  /** A's initial deposit in nanotons. */
  initBalanceA: bigint;
  /** B's initial deposit in nanotons. */
  initBalanceB: bigint;
  /** Optional on-chain closing parameters. Defaults are applied when omitted. */
  closingConfig?: {
    /** Quarantine window in seconds (default 0). */
    quarantineDuration?: number;
    /** Fine deducted from the misbehaving party in nanotons (default 0). */
    misbehaviorFine?: bigint;
    /** Duration for conditional close resolution in seconds (default 0). */
    conditionalCloseDuration?: number;
  };
}

/**
 * Build a SignedSemiChannel cell (v2 layout).
 *
 * Layout:
 *   signature(512 bits)
 *   + ref cell: tag_state(32) + channelId(128) + seqno(64) + sentCoins(Coins) + conditionalsHash(256=0)
 *
 * The signature covers the hash of the body cell (not the outer cell).
 *
 * @param channelId  - Unique channel identifier (uint128)
 * @param seqno      - Monotonic sequence number of the signing party (uint64)
 * @param sentCoins  - Cumulative amount sent by the signing party in nanotons
 * @param keyPair    - Ed25519 key pair of the signing party
 * @returns          A Cell containing the 512-bit signature and a ref to the body cell
 */
export function buildSignedSemiChannel(
  channelId: bigint,
  seqno: bigint,
  sentCoins: bigint,
  keyPair: KeyPair,
): Cell {
  const body = beginCell()
    .storeUint(TAG_STATE, 32)
    .storeUint(channelId, 128)
    .storeUint(seqno, 64)
    .storeCoins(sentCoins)
    .storeUint(0n, 256) // conditionalsHash = 0
    .endCell();

  const sig = sign(body.hash(), keyPair.secretKey);

  return beginCell()
    .storeBuffer(Buffer.from(sig), 64) // 512 bits
    .storeRef(body)
    .endCell();
}

/**
 * Manages the full on-chain lifecycle of a TON payment channel.
 *
 * Wraps the pc402 smart contract v2 and exposes typed methods for every
 * supported operation: deploy, top-up, init, cooperative close/commit,
 * and the full uncooperative close sequence.
 */
export class OnchainChannel {
  private readonly client: TonClient;
  private readonly myKeyPair: KeyPair;
  private readonly counterpartyPublicKey: Buffer;
  private readonly isA: boolean;
  private readonly channelId: bigint;
  private readonly myAddress: Address;
  private readonly counterpartyAddress: Address;
  private readonly initBalanceA: bigint;
  private readonly initBalanceB: bigint;
  private readonly stateInit: StateInit;
  private readonly channelAddress: Address;
  private readonly closingConfig: {
    quarantineDuration: number;
    misbehaviorFine: bigint;
    conditionalCloseDuration: number;
  };

  /**
   * Create an OnchainChannel instance.
   *
   * Validates key lengths and channelId, then computes the deterministic
   * contract address from the stateInit (code + data).
   *
   * @param options - Channel configuration; see {@link OnchainChannelOptions}
   * @throws {ValidationError} If channelId is not positive or a public key is not 32 bytes
   */
  constructor(options: OnchainChannelOptions) {
    if (options.channelId <= 0n)
      throw new ValidationError("channelId must be positive", PC402ErrorCode.INVALID_CHANNEL_ID);
    if (options.myKeyPair.publicKey.length !== 32)
      throw new ValidationError("myKeyPair.publicKey must be 32 bytes", PC402ErrorCode.INVALID_KEY);
    if (options.counterpartyPublicKey.length !== 32)
      throw new ValidationError(
        "counterpartyPublicKey must be 32 bytes",
        PC402ErrorCode.INVALID_KEY,
      );

    this.client = options.client;
    this.myKeyPair = options.myKeyPair;
    this.counterpartyPublicKey = options.counterpartyPublicKey;
    this.isA = options.isA;
    this.channelId = options.channelId;
    this.myAddress = options.myAddress;
    this.counterpartyAddress = options.counterpartyAddress;
    this.initBalanceA = options.initBalanceA;
    this.initBalanceB = options.initBalanceB;

    this.closingConfig = {
      quarantineDuration: options.closingConfig?.quarantineDuration ?? 0,
      misbehaviorFine: options.closingConfig?.misbehaviorFine ?? 0n,
      conditionalCloseDuration: options.closingConfig?.conditionalCloseDuration ?? 0,
    };

    const publicKeyA = options.isA ? options.myKeyPair.publicKey : options.counterpartyPublicKey;
    const publicKeyB = options.isA ? options.counterpartyPublicKey : options.myKeyPair.publicKey;
    const addressA = options.isA ? options.myAddress : options.counterpartyAddress;
    const addressB = options.isA ? options.counterpartyAddress : options.myAddress;

    const initConfig: ChannelInitConfig = {
      publicKeyA,
      publicKeyB,
      channelId: this.channelId,
      addressA,
      addressB,
      quarantineDuration: this.closingConfig.quarantineDuration,
      misbehaviorFine: this.closingConfig.misbehaviorFine,
      conditionalCloseDuration: this.closingConfig.conditionalCloseDuration,
    };

    this.stateInit = createChannelStateInit(initConfig);
    this.channelAddress = contractAddress(0, this.stateInit);
  }

  /**
   * Get the computed address of the payment channel contract.
   *
   * The address is deterministic and derived from the stateInit (code + data).
   *
   * @returns The channel's TON contract address
   */
  getAddress(): Address {
    return this.channelAddress;
  }

  /**
   * Get the channel ID.
   *
   * @returns The uint128 channel identifier passed at construction
   */
  getChannelId(): bigint {
    return this.channelId;
  }

  /**
   * Get whether this instance represents party A.
   *
   * @returns true if this party is A, false if B
   */
  getIsA(): boolean {
    return this.isA;
  }

  /**
   * Deploy AND top up the channel in a single transaction (for one party).
   *
   * Sends one message with:
   *   - stateInit (deploys the contract)
   *   - body: topUp(isA, amount) (funds it immediately)
   *   - value: amount + gas
   *
   * The contract processes stateInit first (deploy), then recv_internal
   * with the topUp body. The other party calls topUp() separately.
   *
   * Message body: op(32) + isA(1 signed bit) + amount(Coins)
   *
   * @param via    - Sender abstraction used to submit the message
   * @param isA    - true if the caller is party A, false if party B
   * @param amount - Amount to deposit in nanotons (must be positive)
   * @returns      Resolves when the message is submitted
   * @throws {ValidationError} If amount is not positive
   */
  async deployAndTopUp(via: Sender, isA: boolean, amount: bigint): Promise<void> {
    if (amount <= 0n)
      throw new ValidationError("amount must be positive", PC402ErrorCode.INVALID_AMOUNT);
    const body = beginCell().storeUint(OP_TOP_UP, 32).storeBit(isA).storeCoins(amount).endCell();

    await via.send({
      to: this.channelAddress,
      value: amount + GAS_DEPLOY,
      init: this.stateInit,
      body,
      bounce: false,
    });
  }

  /**
   * Top up the channel with additional funds.
   *
   * Sender must match addrA (if isA=true) or addrB (if isA=false).
   * The contract validates this and bounces the message on mismatch.
   *
   * Message body: op(32) + isA(1 signed bit) + amount(Coins)
   *
   * @param via    - Sender abstraction used to submit the message
   * @param isA    - true if the caller is party A, false if party B
   * @param amount - Amount to deposit in nanotons (must be positive)
   * @returns      Resolves when the message is submitted
   * @throws {ValidationError} If amount is not positive
   */
  async topUp(via: Sender, isA: boolean, amount: bigint): Promise<void> {
    if (amount <= 0n)
      throw new ValidationError("amount must be positive", PC402ErrorCode.INVALID_AMOUNT);
    const body = beginCell().storeUint(OP_TOP_UP, 32).storeBit(isA).storeCoins(amount).endCell();

    await via.send({
      to: this.channelAddress,
      value: amount + GAS_STANDARD,
      body,
      bounce: true,
    });
  }

  /**
   * Sign the init payload.
   *
   * Returns a 64-byte Ed25519 signature over:
   *   tag_init(32) + channelId(128) + balanceA(Coins) + balanceB(Coins)
   *
   * @param balanceA - A's initial balance to commit in nanotons
   * @param balanceB - B's initial balance to commit in nanotons
   * @param keyPair  - Ed25519 key pair of the signing party (A or B)
   * @returns        64-byte Ed25519 signature buffer
   */
  signInit(balanceA: bigint, balanceB: bigint, keyPair: KeyPair): Buffer {
    const payloadCell = beginCell()
      .storeUint(TAG_INIT, 32)
      .storeUint(this.channelId, 128)
      .storeCoins(balanceA)
      .storeCoins(balanceB)
      .endCell();

    return Buffer.from(sign(payloadCell.hash(), keyPair.secretKey));
  }

  /**
   * Initialize the payment channel (transition from UNINITED to OPEN).
   *
   * Message body:
   *   op(32) + isA(1 bit) + signature(512 bits)
   *   + tag_init(32) + channelId(128) + balanceA(Coins) + balanceB(Coins)
   *
   * The contract computes msg.hash() after reading isA and sig,
   * covering: tag_init + channelId + balanceA + balanceB.
   * Only ONE signature is needed (from either A or B).
   *
   * @param via      - Sender abstraction used to submit the message
   * @param balanceA - A's committed initial balance in nanotons
   * @param balanceB - B's committed initial balance in nanotons
   * @returns        Resolves when the message is submitted
   */
  async init(via: Sender, balanceA: bigint, balanceB: bigint): Promise<void> {
    const signature = this.signInit(balanceA, balanceB, this.myKeyPair);

    const body = beginCell()
      .storeUint(OP_INIT_CHANNEL, 32)
      .storeBit(this.isA)
      .storeBuffer(signature, 64)
      .storeUint(TAG_INIT, 32)
      .storeUint(this.channelId, 128)
      .storeCoins(balanceA)
      .storeCoins(balanceB)
      .endCell();

    await via.send({
      to: this.channelAddress,
      value: GAS_STANDARD,
      body,
      bounce: true,
    });
  }

  // ---------------------------------------------------------------------------
  // cooperativeClose (opcode 0xd2b1eeeb)
  // ---------------------------------------------------------------------------

  /**
   * Sign the cooperative close payload.
   *
   * Returns a 64-byte Ed25519 signature over:
   *   tag_close(32) + channelId(128) + sentA(Coins) + sentB(Coins)
   *
   * The contract computes msg.hash() after reading sigA and sigB refs,
   * covering the data above.
   *
   * @param sentA   - Total amount sent by party A in nanotons (must be non-negative)
   * @param sentB   - Total amount sent by party B in nanotons (must be non-negative)
   * @param keyPair - Ed25519 key pair of the signing party
   * @returns       64-byte Ed25519 signature buffer
   * @throws {ValidationError} If sentA or sentB is negative
   */
  signClose(
    seqnoA: bigint,
    seqnoB: bigint,
    sentA: bigint,
    sentB: bigint,
    keyPair: KeyPair,
  ): Buffer {
    if (sentA < 0n || sentB < 0n)
      throw new ValidationError(
        "sentA and sentB must be non-negative",
        PC402ErrorCode.INVALID_AMOUNT,
      );
    const payloadCell = beginCell()
      .storeUint(TAG_COOPERATIVE_CLOSE, 32)
      .storeUint(this.channelId, 128)
      .storeUint(seqnoA, 64)
      .storeUint(seqnoB, 64)
      .storeCoins(sentA)
      .storeCoins(sentB)
      .endCell();

    return Buffer.from(sign(payloadCell.hash(), keyPair.secretKey));
  }

  /**
   * Cooperative close of the payment channel.
   *
   * Both parties must have signed the same (sentA, sentB) values. The contract
   * verifies both signatures and distributes funds accordingly before destroying itself.
   *
   * Message body:
   *   op(32) + ref[sigA(512 bits)] + ref[sigB(512 bits)]
   *   + tag_close(32) + channelId(128) + sentA(Coins) + sentB(Coins)
   *
   * @param via        - Sender abstraction used to submit the message
   * @param sentA      - Total cumulative amount sent by A in nanotons
   * @param sentB      - Total cumulative amount sent by B in nanotons
   * @param signatureA - 64-byte Ed25519 signature from party A
   * @param signatureB - 64-byte Ed25519 signature from party B
   * @returns          Resolves when the message is submitted
   */
  async cooperativeClose(
    via: Sender,
    seqnoA: bigint,
    seqnoB: bigint,
    sentA: bigint,
    sentB: bigint,
    signatureA: Buffer,
    signatureB: Buffer,
  ): Promise<void> {
    const sigACell = beginCell().storeBuffer(signatureA, 64).endCell();
    const sigBCell = beginCell().storeBuffer(signatureB, 64).endCell();

    const body = beginCell()
      .storeUint(OP_COOPERATIVE_CLOSE, 32)
      .storeRef(sigACell)
      .storeRef(sigBCell)
      .storeUint(TAG_COOPERATIVE_CLOSE, 32)
      .storeUint(this.channelId, 128)
      .storeUint(seqnoA, 64)
      .storeUint(seqnoB, 64)
      .storeCoins(sentA)
      .storeCoins(sentB)
      .endCell();

    await via.send({
      to: this.channelAddress,
      value: GAS_CLOSE,
      body,
      bounce: true,
    });
  }

  // ---------------------------------------------------------------------------
  // cooperativeCommit (opcode 0x076bfdf1)
  // ---------------------------------------------------------------------------

  /**
   * Sign the cooperative commit payload.
   *
   * Returns a 64-byte Ed25519 signature over:
   *   tag_commit(32) + channelId(128) + seqnoA(64) + seqnoB(64)
   *   + sentA(Coins) + sentB(Coins) + withdrawA(Coins) + withdrawB(Coins)
   *
   * @param seqnoA    - A's new committed sequence number (uint64)
   * @param seqnoB    - B's new committed sequence number (uint64)
   * @param sentA     - Total cumulative amount sent by A in nanotons
   * @param sentB     - Total cumulative amount sent by B in nanotons
   * @param keyPair   - Ed25519 key pair of the signing party
   * @param withdrawA - Amount A wishes to withdraw now in nanotons (default 0)
   * @param withdrawB - Amount B wishes to withdraw now in nanotons (default 0)
   * @returns         64-byte Ed25519 signature buffer
   */
  signCommit(
    seqnoA: bigint,
    seqnoB: bigint,
    sentA: bigint,
    sentB: bigint,
    keyPair: KeyPair,
    withdrawA: bigint = 0n,
    withdrawB: bigint = 0n,
  ): Buffer {
    const payloadCell = beginCell()
      .storeUint(TAG_COOPERATIVE_COMMIT, 32)
      .storeUint(this.channelId, 128)
      .storeUint(seqnoA, 64)
      .storeUint(seqnoB, 64)
      .storeCoins(sentA)
      .storeCoins(sentB)
      .storeCoins(withdrawA)
      .storeCoins(withdrawB)
      .endCell();

    return Buffer.from(sign(payloadCell.hash(), keyPair.secretKey));
  }

  /**
   * Cooperative commit — advance committed seqnos without closing.
   *
   * Moves the on-chain committed seqnos forward so both parties can safely
   * forget older states. Can also trigger partial withdrawals when
   * withdrawA or withdrawB is greater than zero.
   *
   * Message body:
   *   op(32) + ref[sigA(512)] + ref[sigB(512)]
   *   + tag_commit(32) + channelId(128) + seqnoA(64) + seqnoB(64)
   *   + sentA(Coins) + sentB(Coins) + withdrawA(Coins) + withdrawB(Coins)
   *
   * @param via        - Sender abstraction used to submit the message
   * @param seqnoA     - A's new committed sequence number (uint64)
   * @param seqnoB     - B's new committed sequence number (uint64)
   * @param sentA      - Total cumulative amount sent by A in nanotons
   * @param sentB      - Total cumulative amount sent by B in nanotons
   * @param signatureA - 64-byte Ed25519 signature from party A
   * @param signatureB - 64-byte Ed25519 signature from party B
   * @param withdrawA  - Amount to send back to A now in nanotons (default 0)
   * @param withdrawB  - Amount to send back to B now in nanotons (default 0)
   * @returns          Resolves when the message is submitted
   */
  async cooperativeCommit(
    via: Sender,
    seqnoA: bigint,
    seqnoB: bigint,
    sentA: bigint,
    sentB: bigint,
    signatureA: Buffer,
    signatureB: Buffer,
    withdrawA: bigint = 0n,
    withdrawB: bigint = 0n,
  ): Promise<void> {
    const sigACell = beginCell().storeBuffer(signatureA, 64).endCell();
    const sigBCell = beginCell().storeBuffer(signatureB, 64).endCell();

    const body = beginCell()
      .storeUint(OP_COOPERATIVE_COMMIT, 32)
      .storeRef(sigACell)
      .storeRef(sigBCell)
      .storeUint(TAG_COOPERATIVE_COMMIT, 32)
      .storeUint(this.channelId, 128)
      .storeUint(seqnoA, 64)
      .storeUint(seqnoB, 64)
      .storeCoins(sentA)
      .storeCoins(sentB)
      .storeCoins(withdrawA)
      .storeCoins(withdrawB)
      .endCell();

    await via.send({
      to: this.channelAddress,
      value: GAS_CLOSE,
      body,
      bounce: true,
    });
  }

  // ---------------------------------------------------------------------------
  // startUncooperativeClose (opcode 0x8175e15d)
  // ---------------------------------------------------------------------------

  /**
   * Sign the outer message for startUncooperativeClose.
   *
   * Returns a 64-byte Ed25519 signature over:
   *   tag(32) + channelId(128) + schA(ref) + schB(ref)
   *
   * The contract computes msg.hash() after reading signedByA and outerSig,
   * covering the data above.
   *
   * @param schA    - SignedSemiChannel cell for party A (built with {@link buildSignedSemiChannel})
   * @param schB    - SignedSemiChannel cell for party B
   * @param keyPair - Ed25519 key pair of the initiating party
   * @returns       64-byte Ed25519 signature buffer
   */
  signStartUncoopClose(schA: Cell, schB: Cell, keyPair: KeyPair): Buffer {
    const payloadCell = beginCell()
      .storeUint(TAG_START_UNCOOPERATIVE_CLOSE, 32)
      .storeUint(this.channelId, 128)
      .storeRef(schA)
      .storeRef(schB)
      .endCell();

    return Buffer.from(sign(payloadCell.hash(), keyPair.secretKey));
  }

  /**
   * Start an uncooperative close of the channel.
   *
   * Submits the latest known state on-chain and begins the quarantine period.
   * The counterparty may challenge with a newer state via {@link challengeQuarantinedState}.
   *
   * Message body:
   *   op(32) + signedByA(1 bit) + outerSig(512)
   *   + tag(32) + channelId(128) + ref[schA] + ref[schB]
   *
   * @param via          - Sender abstraction used to submit the message
   * @param signedByA    - true if the message is signed by party A, false if by party B
   * @param signatureMsg - 64-byte outer signature (from {@link signStartUncoopClose})
   * @param schA         - SignedSemiChannel cell for party A
   * @param schB         - SignedSemiChannel cell for party B
   * @returns            Resolves when the message is submitted
   */
  async startUncooperativeClose(
    via: Sender,
    signedByA: boolean,
    signatureMsg: Buffer,
    schA: Cell,
    schB: Cell,
  ): Promise<void> {
    const body = beginCell()
      .storeUint(OP_START_UNCOOPERATIVE_CLOSE, 32)
      .storeBit(signedByA)
      .storeBuffer(signatureMsg, 64)
      .storeUint(TAG_START_UNCOOPERATIVE_CLOSE, 32)
      .storeUint(this.channelId, 128)
      .storeRef(schA)
      .storeRef(schB)
      .endCell();

    await via.send({
      to: this.channelAddress,
      value: GAS_CLOSE,
      body,
      bounce: true,
    });
  }

  // ---------------------------------------------------------------------------
  // challengeQuarantinedState (opcode 0x9a77c0db)
  // ---------------------------------------------------------------------------

  /**
   * Sign the outer message for challengeQuarantinedState.
   *
   * Returns a 64-byte Ed25519 signature over:
   *   tag(32) + channelId(128) + schA(ref) + schB(ref)
   *
   * @param schA    - SignedSemiChannel cell for party A with the newer state
   * @param schB    - SignedSemiChannel cell for party B with the newer state
   * @param keyPair - Ed25519 key pair of the challenging party
   * @returns       64-byte Ed25519 signature buffer
   */
  signChallenge(schA: Cell, schB: Cell, keyPair: KeyPair): Buffer {
    const payloadCell = beginCell()
      .storeUint(TAG_CHALLENGE_QUARANTINE, 32)
      .storeUint(this.channelId, 128)
      .storeRef(schA)
      .storeRef(schB)
      .endCell();

    return Buffer.from(sign(payloadCell.hash(), keyPair.secretKey));
  }

  /**
   * Challenge a quarantined state with a newer one.
   *
   * Must be called during the quarantine period after {@link startUncooperativeClose}.
   * If the challenger's seqnos are strictly higher, the contract replaces the
   * quarantined state and optionally penalizes the misbehaving party.
   *
   * Message body:
   *   op(32) + challengedByA(1 bit) + outerSig(512)
   *   + tag(32) + channelId(128) + ref[schA] + ref[schB]
   *
   * @param via            - Sender abstraction used to submit the message
   * @param challengedByA  - true if the challenger is party A, false if party B
   * @param signatureMsg   - 64-byte outer signature (from {@link signChallenge})
   * @param schA           - SignedSemiChannel cell for party A with the newer state
   * @param schB           - SignedSemiChannel cell for party B with the newer state
   * @returns              Resolves when the message is submitted
   */
  async challengeQuarantinedState(
    via: Sender,
    challengedByA: boolean,
    signatureMsg: Buffer,
    schA: Cell,
    schB: Cell,
  ): Promise<void> {
    const body = beginCell()
      .storeUint(OP_CHALLENGE_QUARANTINE, 32)
      .storeBit(challengedByA)
      .storeBuffer(signatureMsg, 64)
      .storeUint(TAG_CHALLENGE_QUARANTINE, 32)
      .storeUint(this.channelId, 128)
      .storeRef(schA)
      .storeRef(schB)
      .endCell();

    await via.send({
      to: this.channelAddress,
      value: GAS_CLOSE,
      body,
      bounce: true,
    });
  }

  // ---------------------------------------------------------------------------
  // settleConditionals (opcode 0x56c39b4c)
  // ---------------------------------------------------------------------------

  /**
   * Sign the settleConditionals payload.
   *
   * Returns a 64-byte Ed25519 signature over:
   *   tag(32) + channelId(128) + conditionalsCell(ref)
   *
   * The contract computes msg.hash() after reading isFromA and sig.
   *
   * @param conditionalsCell - Cell containing the conditional payment dictionaries
   * @param keyPair          - Ed25519 key pair of the settling party
   * @returns                64-byte Ed25519 signature buffer
   */
  signSettle(conditionalsCell: Cell, keyPair: KeyPair): Buffer {
    const payloadCell = beginCell()
      .storeUint(TAG_SETTLE_CONDITIONALS, 32)
      .storeUint(this.channelId, 128)
      .storeRef(conditionalsCell)
      .endCell();

    return Buffer.from(sign(payloadCell.hash(), keyPair.secretKey));
  }

  /**
   * Settle conditional payments.
   *
   * Called during the conditional close period after uncooperative close.
   * Resolves any pending conditional payments encoded in the conditionalsCell.
   *
   * Message body:
   *   op(32) + isFromA(1 bit) + sig(512)
   *   + tag(32) + channelId(128) + conditionalsCell(ref)
   *
   * @param via              - Sender abstraction used to submit the message
   * @param isFromA          - true if the caller is party A, false if party B
   * @param signature        - 64-byte Ed25519 signature (from {@link signSettle})
   * @param conditionalsCell - Cell containing the conditional payment dictionaries
   * @returns                Resolves when the message is submitted
   */
  async settleConditionals(
    via: Sender,
    isFromA: boolean,
    signature: Buffer,
    conditionalsCell: Cell,
  ): Promise<void> {
    const body = beginCell()
      .storeUint(OP_SETTLE_CONDITIONALS, 32)
      .storeBit(isFromA)
      .storeBuffer(signature, 64)
      .storeUint(TAG_SETTLE_CONDITIONALS, 32)
      .storeUint(this.channelId, 128)
      .storeRef(conditionalsCell)
      .endCell();

    await via.send({
      to: this.channelAddress,
      value: GAS_CLOSE,
      body,
      bounce: true,
    });
  }

  // ---------------------------------------------------------------------------
  // finishUncooperativeClose (opcode 0x25432a91)
  // ---------------------------------------------------------------------------

  /**
   * Finish an uncooperative close after the quarantine timeout.
   *
   * Can be sent by anyone after the quarantine and conditional close periods
   * have both expired. The contract distributes remaining funds to A and B
   * based on the last accepted quarantined state and destroys itself.
   *
   * Message body: op(32) -- just the opcode, no payload.
   *
   * @param via - Sender abstraction used to submit the message
   * @returns   Resolves when the message is submitted
   */
  async finishUncooperativeClose(via: Sender): Promise<void> {
    const body = beginCell().storeUint(OP_FINISH_UNCOOPERATIVE_CLOSE, 32).endCell();

    await via.send({
      to: this.channelAddress,
      value: GAS_CLOSE,
      body,
      bounce: true,
    });
  }

  // ---------------------------------------------------------------------------
  // getOnchainState -- read contract state via get-method
  // ---------------------------------------------------------------------------

  /**
   * Read the on-chain channel state by calling the get_channel_data get-method.
   *
   * v2 get_channel_data returns 8 stack items:
   *   (state, [calcA, calcB, depositA, depositB, withdrawnA, withdrawnB],
   *    [keyA, keyB], channelId, closureConfig,
   *    [commitedSeqnoA, commitedSeqnoB], quarantine?, [storageFee, addrA, addrB])
   *
   * @returns An object with the current channel state snapshot:
   *   - `state`      — numeric contract state (0=uninited, 1=open, 2=quarantine)
   *   - `balanceA`   — A's current available balance in nanotons (calcA)
   *   - `balanceB`   — B's current available balance in nanotons (calcB)
   *   - `channelId`  — uint128 channel identifier
   *   - `seqnoA`     — A's last committed sequence number
   *   - `seqnoB`     — B's last committed sequence number
   *   - `withdrawnA` — total amount already withdrawn by A in nanotons
   *   - `withdrawnB` — total amount already withdrawn by B in nanotons
   */
  async getOnchainState(): Promise<{
    state: number;
    balanceA: bigint;
    balanceB: bigint;
    channelId: bigint;
    seqnoA: number;
    seqnoB: number;
    withdrawnA: bigint;
    withdrawnB: bigint;
  }> {
    const result = await this.client.runMethod(this.channelAddress, "get_channel_data");

    // [0] int — channel state
    const state = result.stack.readNumber();

    // [1] tuple — [calcA(), calcB(), depositA, depositB, withdrawnA, withdrawnB]
    // Note: pop() is used instead of readBigNumber() because nested tuple items
    // from JSON-RPC lack type metadata that readBigNumber() requires.
    const balanceTuple = result.stack.readTuple();
    const balanceA = BigInt(balanceTuple.pop() as unknown as bigint); // calcA()
    const balanceB = BigInt(balanceTuple.pop() as unknown as bigint); // calcB()
    balanceTuple.pop(); // depositA -- skip
    balanceTuple.pop(); // depositB -- skip
    const withdrawnA = BigInt(balanceTuple.pop() as unknown as bigint); // withdrawnA
    const withdrawnB = BigInt(balanceTuple.pop() as unknown as bigint); // withdrawnB

    // [2] tuple — [keyA, keyB] -- skip
    result.stack.readTuple();

    // [3] int — channelId
    const channelId = result.stack.readBigNumber();

    // [4] tuple — closureConfig -- skip
    result.stack.readTuple();

    // [5] tuple — [commitedSeqnoA, commitedSeqnoB]
    const seqnoTuple = result.stack.readTuple();
    const seqnoA = Number(seqnoTuple.pop() as unknown as bigint);
    const seqnoB = Number(seqnoTuple.pop() as unknown as bigint);

    // [6] cell? — quarantine -- skip
    result.stack.readCellOpt();

    // [7] tuple — [storageFee, addrA, addrB] -- skip
    result.stack.readTuple();

    return { state, balanceA, balanceB, channelId, seqnoA, seqnoB, withdrawnA, withdrawnB };
  }
}
