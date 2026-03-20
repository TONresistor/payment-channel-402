/**
 * pc402-fetch — Client-side on-chain operations
 *
 * Lightweight helpers that send on-chain messages to a KNOWN channel address.
 * Does not require the full OnchainChannel constructor (which needs addressB).
 * The client only needs: channelAddress, channelId, keyPair, TonClient.
 */

import { Address, beginCell, toNano } from "@ton/core";
import { type KeyPair, sign } from "@ton/crypto";
import { TonClient, WalletContractV4 } from "@ton/ton";

// Opcodes and tags from pc402-channel (duplicated to avoid hard dep on constructor)
const OP_TOP_UP = 0x593e3893;
const OP_INIT_CHANNEL = 0x79ae99b5;
const TAG_INIT = 0x481ebc44;

const GAS_STANDARD = toNano("0.008");

/** On-chain state returned by get_channel_data. */
export interface OnchainState {
  /** 0=uninited, 1=open, 2=quarantine */
  state: number;
  balanceA: bigint;
  balanceB: bigint;
  channelId: bigint;
  seqnoA: number;
  seqnoB: number;
  withdrawnA: bigint;
  withdrawnB: bigint;
}

/**
 * Create a wallet Sender from a key pair and TonClient.
 * Uses WalletContractV4 (standard TON wallet).
 */
export function createSender(client: TonClient, keyPair: KeyPair) {
  const wallet = client.open(
    WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey }),
  );
  return {
    sender: wallet.sender(keyPair.secretKey),
    address: wallet.address,
  };
}

/**
 * Top up a payment channel (send TON to the contract).
 * The contract validates that the sender matches addressA.
 */
export async function topUpChannel(
  client: TonClient,
  keyPair: KeyPair,
  channelAddress: string,
  amount: bigint,
): Promise<void> {
  const { sender } = createSender(client, keyPair);
  const addr = Address.parse(channelAddress);
  const body = beginCell()
    .storeUint(OP_TOP_UP, 32)
    .storeBit(true) // isA = true (client is always A)
    .storeCoins(amount)
    .endCell();

  await sender.send({
    to: addr,
    value: amount + GAS_STANDARD,
    body,
    bounce: true,
  });
}

/**
 * Initialize a payment channel (transition from UNINITED to OPEN).
 * Only ONE signature is needed (client signs as party A).
 */
export async function initChannel(
  client: TonClient,
  keyPair: KeyPair,
  channelAddress: string,
  channelId: bigint,
  balanceA: bigint,
  balanceB: bigint,
): Promise<void> {
  const { sender } = createSender(client, keyPair);
  const addr = Address.parse(channelAddress);

  // Sign the init payload
  const payloadCell = beginCell()
    .storeUint(TAG_INIT, 32)
    .storeUint(channelId, 128)
    .storeCoins(balanceA)
    .storeCoins(balanceB)
    .endCell();
  const signature = sign(payloadCell.hash(), keyPair.secretKey);

  // Build init message body
  const body = beginCell()
    .storeUint(OP_INIT_CHANNEL, 32)
    .storeBit(true) // isA = true
    .storeBuffer(Buffer.from(signature), 64)
    .storeUint(TAG_INIT, 32)
    .storeUint(channelId, 128)
    .storeCoins(balanceA)
    .storeCoins(balanceB)
    .endCell();

  await sender.send({
    to: addr,
    value: GAS_STANDARD,
    body,
    bounce: true,
  });
}

/**
 * Read on-chain channel state via get_channel_data get-method.
 * Works with any channel address — no constructor params needed.
 */
export async function getOnchainState(
  client: TonClient,
  channelAddress: string,
): Promise<OnchainState> {
  const addr = Address.parse(channelAddress);
  const result = await client.runMethod(addr, "get_channel_data");

  const state = result.stack.readNumber();

  const balanceTuple = result.stack.readTuple();
  const balanceA = BigInt(balanceTuple.pop() as unknown as bigint);
  const balanceB = BigInt(balanceTuple.pop() as unknown as bigint);
  balanceTuple.pop(); // depositA
  balanceTuple.pop(); // depositB
  const withdrawnA = BigInt(balanceTuple.pop() as unknown as bigint);
  const withdrawnB = BigInt(balanceTuple.pop() as unknown as bigint);

  result.stack.readTuple(); // keys
  const channelId = result.stack.readBigNumber();
  result.stack.readTuple(); // closureConfig

  const seqnoTuple = result.stack.readTuple();
  const seqnoA = Number(seqnoTuple.pop() as unknown as bigint);
  const seqnoB = Number(seqnoTuple.pop() as unknown as bigint);

  return { state, balanceA, balanceB, channelId, seqnoA, seqnoB, withdrawnA, withdrawnB };
}

/**
 * Get the wallet address derived from a key pair (WalletContractV4).
 */
export function getWalletAddress(keyPair: KeyPair): Address {
  return WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey }).address;
}

/**
 * Get wallet TON balance.
 */
export async function getWalletBalance(client: TonClient, keyPair: KeyPair): Promise<bigint> {
  const addr = getWalletAddress(keyPair);
  return client.getBalance(addr);
}
