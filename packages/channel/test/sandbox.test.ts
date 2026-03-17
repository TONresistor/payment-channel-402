/**
 * Sandbox tests for getOnchainState() parsing.
 *
 * Deploys the actual payment-channel.tolk bytecode in @ton/sandbox,
 * runs get_channel_data, and verifies the SDK parses the TVM stack correctly.
 */

import {
  type Address,
  beginCell,
  contractAddress,
  type StateInit,
  type TupleReader,
  toNano,
} from "@ton/core";
import { type KeyPair, keyPairFromSeed, sign } from "@ton/crypto";
import { Blockchain, type SandboxContract, type TreasuryContract } from "@ton/sandbox";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChannelStateInit } from "../src/contract.js";

// Opcodes and tags from the v2 contract
const OP_TOP_UP = 0x593e3893;
const OP_INIT_CHANNEL = 0x79ae99b5;
const OP_COOPERATIVE_COMMIT = 0x076bfdf1;
const TAG_INIT = 0x481ebc44;
const TAG_COOPERATIVE_COMMIT = 0x4a390cac;

function getExitCode(transactions: any[], to: Address): number | undefined {
  for (const tx of transactions) {
    if (tx.inMessage?.info?.dest?.equals?.(to)) {
      const desc = tx.description;
      if (desc.type === "generic" && desc.computePhase?.type === "vm") {
        return desc.computePhase.exitCode;
      }
    }
  }
  return undefined;
}

/**
 * Parse get_channel_data result for v2 contract.
 *
 * v2 stack layout:
 *   [0] int  — channel state
 *   [1] tuple — [calcA, calcB, depositA, depositB, withdrawnA, withdrawnB]
 *   [2] tuple — [keyA, keyB]
 *   [3] int  — channelId
 *   [4] tuple — closureConfig
 *   [5] tuple — [commitedSeqnoA, commitedSeqnoB]
 *   [6] cell? — quarantine
 *   [7] tuple — [storageFee, addrA, addrB]
 */
function parseChannelData(stack: TupleReader) {
  const state = stack.readNumber(); // [0] int

  const balanceTuple = stack.readTuple(); // [1] tuple [calcA, calcB, depositA, depositB, withdrawnA, withdrawnB]
  const balanceA = balanceTuple.readBigNumber(); // calcA
  const balanceB = balanceTuple.readBigNumber(); // calcB
  balanceTuple.readBigNumber(); // depositA -- skip
  balanceTuple.readBigNumber(); // depositB -- skip
  const withdrawnA = balanceTuple.readBigNumber(); // withdrawnA
  const withdrawnB = balanceTuple.readBigNumber(); // withdrawnB

  stack.readTuple(); // [2] tuple [keyA, keyB] -- skip
  const channelId = stack.readBigNumber(); // [3] int
  stack.readTuple(); // [4] tuple closureConfig -- skip

  const seqnoTuple = stack.readTuple(); // [5] tuple [seqA, seqB]
  const seqnoA = seqnoTuple.readNumber();
  const seqnoB = seqnoTuple.readNumber();

  stack.readCellOpt(); // [6] cell? quarantine -- skip
  stack.readTuple(); // [7] tuple [storageFee, addrA, addrB] -- skip

  return { state, balanceA, balanceB, channelId, seqnoA, seqnoB, withdrawnA, withdrawnB };
}

describe("sandbox: get_channel_data parsing", () => {
  let blockchain: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let walletA: SandboxContract<TreasuryContract>;
  let walletB: SandboxContract<TreasuryContract>;
  let keyPairA: KeyPair;
  let keyPairB: KeyPair;
  let channelId: bigint;
  let channelAddress: Address;
  let stateInit: StateInit;

  beforeAll(async () => {
    keyPairA = keyPairFromSeed(Buffer.alloc(32, 1));
    keyPairB = keyPairFromSeed(Buffer.alloc(32, 2));
  });

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury("deployer");
    walletA = await blockchain.treasury("walletA");
    walletB = await blockchain.treasury("walletB");
    channelId = 42n;

    stateInit = createChannelStateInit({
      publicKeyA: keyPairA.publicKey,
      publicKeyB: keyPairB.publicKey,
      channelId,
      addressA: walletA.address,
      addressB: walletB.address,
    });
    channelAddress = contractAddress(0, stateInit);
  });

  /**
   * Deploy the channel via walletA (isA=true) and then send init.
   * v2 topUp body: op(32) + isA(1 bit) + amount(Coins)
   * The contract verifies sender == addressA when isA=true.
   */
  async function deployAndInit(depositA: bigint) {
    // Deploy + TopUp from walletA (sender must match addressA for isA=true)
    const topUpBody = beginCell()
      .storeUint(OP_TOP_UP, 32)
      .storeBit(true) // isA = true
      .storeCoins(depositA)
      .endCell();

    const deployResult = await walletA.send({
      to: channelAddress,
      value: depositA + toNano("0.05"),
      init: stateInit,
      body: topUpBody,
      bounce: false,
    });
    expect(getExitCode(deployResult.transactions, channelAddress)).toBe(0);

    // Init (signed by A)
    const initPayload = beginCell()
      .storeUint(TAG_INIT, 32)
      .storeUint(channelId, 128)
      .storeCoins(depositA)
      .storeCoins(0n)
      .endCell();

    const sigInit = sign(initPayload.hash(), keyPairA.secretKey);

    const initBody = beginCell()
      .storeUint(OP_INIT_CHANNEL, 32)
      .storeBit(true) // is_A
      .storeBuffer(Buffer.from(sigInit), 64)
      .storeUint(TAG_INIT, 32)
      .storeUint(channelId, 128)
      .storeCoins(depositA)
      .storeCoins(0n)
      .endCell();

    const initResult = await walletA.send({
      to: channelAddress,
      value: toNano("0.01"),
      body: initBody,
    });
    expect(getExitCode(initResult.transactions, channelAddress)).toBe(0);
  }

  it("should parse UNINITED state (before init)", async () => {
    // Deploy only (no init) — topUp from walletA
    const topUpBody = beginCell()
      .storeUint(OP_TOP_UP, 32)
      .storeBit(true) // isA = true
      .storeCoins(toNano("1"))
      .endCell();

    await walletA.send({
      to: channelAddress,
      value: toNano("1.05"),
      init: stateInit,
      body: topUpBody,
      bounce: false,
    });

    const result = await blockchain.runGetMethod(channelAddress, "get_channel_data", []);
    expect(result.exitCode).toBe(0);

    const parsed = parseChannelData(result.stackReader);
    expect(parsed.state).toBe(0); // UNINITED
    expect(parsed.balanceA).toBe(toNano("1"));
    expect(parsed.balanceB).toBe(0n);
    expect(parsed.channelId).toBe(42n);
    expect(parsed.seqnoA).toBe(0);
    expect(parsed.seqnoB).toBe(0);
    expect(parsed.withdrawnA).toBe(0n);
    expect(parsed.withdrawnB).toBe(0n);
  });

  it("should parse OPEN state (after init)", async () => {
    const depositA = toNano("1");
    await deployAndInit(depositA);

    const result = await blockchain.runGetMethod(channelAddress, "get_channel_data", []);
    expect(result.exitCode).toBe(0);

    const parsed = parseChannelData(result.stackReader);
    expect(parsed.state).toBe(1); // OPEN
    expect(parsed.balanceA).toBe(depositA);
    expect(parsed.balanceB).toBe(0n);
    expect(parsed.channelId).toBe(42n);
    expect(parsed.seqnoA).toBe(0);
    expect(parsed.seqnoB).toBe(0);
    expect(parsed.withdrawnA).toBe(0n);
    expect(parsed.withdrawnB).toBe(0n);
  });

  it("should parse state after cooperativeCommit", async () => {
    const depositA = toNano("1");
    await deployAndInit(depositA);

    // CooperativeCommit with seqno 1/1 — seqnos are uint64 in v2
    const seqA = 1n;
    const seqB = 1n;
    const sentA = 0n;
    const sentB = 0n;
    const withdrawA = 0n;
    const withdrawB = 0n;

    const commitPayload = beginCell()
      .storeUint(TAG_COOPERATIVE_COMMIT, 32)
      .storeUint(channelId, 128)
      .storeUint(seqA, 64)
      .storeUint(seqB, 64)
      .storeCoins(sentA)
      .storeCoins(sentB)
      .storeCoins(withdrawA)
      .storeCoins(withdrawB)
      .endCell();

    const sigA = sign(commitPayload.hash(), keyPairA.secretKey);
    const sigB = sign(commitPayload.hash(), keyPairB.secretKey);

    const sigACell = beginCell().storeBuffer(Buffer.from(sigA), 64).endCell();
    const sigBCell = beginCell().storeBuffer(Buffer.from(sigB), 64).endCell();

    const commitBody = beginCell()
      .storeUint(OP_COOPERATIVE_COMMIT, 32)
      .storeRef(sigACell)
      .storeRef(sigBCell)
      .storeUint(TAG_COOPERATIVE_COMMIT, 32)
      .storeUint(channelId, 128)
      .storeUint(seqA, 64)
      .storeUint(seqB, 64)
      .storeCoins(sentA)
      .storeCoins(sentB)
      .storeCoins(withdrawA)
      .storeCoins(withdrawB)
      .endCell();

    const commitResult = await deployer.send({
      to: channelAddress,
      value: toNano("0.01"),
      body: commitBody,
    });
    expect(getExitCode(commitResult.transactions, channelAddress)).toBe(0);

    const result = await blockchain.runGetMethod(channelAddress, "get_channel_data", []);
    expect(result.exitCode).toBe(0);

    const parsed = parseChannelData(result.stackReader);
    expect(parsed.state).toBe(1); // still OPEN
    expect(parsed.channelId).toBe(42n);
    expect(parsed.seqnoA).toBe(1);
    expect(parsed.seqnoB).toBe(1);
    expect(parsed.withdrawnA).toBe(0n);
    expect(parsed.withdrawnB).toBe(0n);
  });
});
