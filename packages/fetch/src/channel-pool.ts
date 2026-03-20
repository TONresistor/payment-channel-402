/**
 * pc402-fetch — ChannelPool
 *
 * Manages open payment channels (one per server channel address).
 * Persists channel configs and off-chain state via a pluggable StateStorage backend.
 */

import type { KeyPair } from "@ton/crypto";
import {
  type ChannelState,
  MemoryStorage,
  PaymentChannel,
  type PC402PaymentRequirements,
  type StateStorage,
} from "pc402-core";

/** Serializable channel configuration stored alongside state. */
interface ChannelConfig {
  channelId: string;
  channelAddress: string;
  serverPublicKey: string;
  initBalanceA: string;
  initBalanceB: string;
}

/** Result of getOrCreate — everything needed to sign a payment. */
export interface ChannelEntry {
  paymentChannel: PaymentChannel;
  state: ChannelState;
}

// Storage key helpers
const CONFIG_PREFIX = "pool:config:";
const STATE_PREFIX = "pool:state:";
const CHANNELS_KEY = "pool:channels";
const COMMIT_PREFIX = "pool:commit:";

function serializeState(s: ChannelState): string {
  return JSON.stringify({
    balanceA: s.balanceA.toString(),
    balanceB: s.balanceB.toString(),
    seqnoA: s.seqnoA,
    seqnoB: s.seqnoB,
  });
}

function deserializeState(raw: string): ChannelState {
  const obj = JSON.parse(raw);
  return {
    balanceA: BigInt(obj.balanceA),
    balanceB: BigInt(obj.balanceB),
    seqnoA: obj.seqnoA,
    seqnoB: obj.seqnoB,
  };
}

/**
 * Pool of open payment channels, keyed by on-chain channel address.
 *
 * Lazily creates PaymentChannel instances from stored configs or fresh
 * 402 requirements. All state is persisted via the provided StateStorage.
 */
export class ChannelPool {
  private readonly storage: StateStorage;
  private readonly keyPair: KeyPair;

  constructor(keyPair: KeyPair, storage?: StateStorage) {
    this.keyPair = keyPair;
    this.storage = storage ?? new MemoryStorage();
  }

  /**
   * Get an existing channel or create a new one from 402 requirements.
   *
   * For new channels, the initial state is derived from the 402 response:
   * balanceA = initBalanceA, balanceB = initBalanceB, seqnos = 0.
   */
  async getOrCreate(requirements: PC402PaymentRequirements): Promise<ChannelEntry> {
    const ch = requirements.channel;
    if (!ch) {
      throw new Error("Cannot get channel: requirements.channel is missing (discovery mode)");
    }
    const addr = ch.address;

    // Try restoring from storage
    const configRaw = await this.storage.get(CONFIG_PREFIX + addr);
    if (configRaw) {
      const config: ChannelConfig = JSON.parse(configRaw);
      const paymentChannel = this._buildPaymentChannel(config);

      const stateRaw = await this.storage.get(STATE_PREFIX + addr);
      const state: ChannelState = stateRaw
        ? deserializeState(stateRaw)
        : {
            balanceA: BigInt(config.initBalanceA),
            balanceB: BigInt(config.initBalanceB),
            seqnoA: 0,
            seqnoB: 0,
          };

      return { paymentChannel, state };
    }

    // New channel from 402 requirements (ch guard already at top of function)
    const config: ChannelConfig = {
      channelId: ch.channelId,
      channelAddress: ch.address,
      serverPublicKey: requirements.payee.publicKey,
      initBalanceA: ch.initBalanceA,
      initBalanceB: ch.initBalanceB,
    };

    await this._saveConfig(addr, config);

    const paymentChannel = this._buildPaymentChannel(config);
    const state: ChannelState = {
      balanceA: BigInt(config.initBalanceA),
      balanceB: BigInt(config.initBalanceB),
      seqnoA: 0,
      seqnoB: 0,
    };

    return { paymentChannel, state };
  }

  /** Persist updated channel state after a successful payment. */
  async saveState(channelAddress: string, state: ChannelState): Promise<void> {
    await this.storage.set(STATE_PREFIX + channelAddress, serializeState(state));
  }

  /** Get stored state for a channel, or null if none exists. */
  async getState(channelAddress: string): Promise<ChannelState | null> {
    const raw = await this.storage.get(STATE_PREFIX + channelAddress);
    return raw ? deserializeState(raw) : null;
  }

  /** List all known channel addresses. */
  async listChannels(): Promise<string[]> {
    const raw = await this.storage.get(CHANNELS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  /** Remove a channel and its state from storage. */
  async closeChannel(channelAddress: string): Promise<void> {
    await this.storage.delete(CONFIG_PREFIX + channelAddress);
    await this.storage.delete(STATE_PREFIX + channelAddress);
    await this.storage.delete(COMMIT_PREFIX + channelAddress);

    const channels = await this.listChannels();
    const filtered = channels.filter((a) => a !== channelAddress);
    await this.storage.set(CHANNELS_KEY, JSON.stringify(filtered));
  }

  /** Store a pending commit signature to include in the next payment. */
  async savePendingCommit(channelAddress: string, commitSignature: Buffer): Promise<void> {
    await this.storage.set(COMMIT_PREFIX + channelAddress, commitSignature.toString("base64"));
  }

  /** Retrieve and clear the pending commit signature for a channel. */
  async popPendingCommit(channelAddress: string): Promise<Buffer | null> {
    const raw = await this.storage.get(COMMIT_PREFIX + channelAddress);
    if (!raw) return null;
    await this.storage.delete(COMMIT_PREFIX + channelAddress);
    return Buffer.from(raw, "base64");
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _buildPaymentChannel(config: ChannelConfig): PaymentChannel {
    return new PaymentChannel({
      channelId: BigInt(config.channelId),
      isA: true, // fetch client is always party A (payer)
      myKeyPair: this.keyPair,
      hisPublicKey: Buffer.from(config.serverPublicKey, "hex"),
      initBalanceA: BigInt(config.initBalanceA),
      initBalanceB: BigInt(config.initBalanceB),
    });
  }

  private async _saveConfig(addr: string, config: ChannelConfig): Promise<void> {
    await this.storage.set(CONFIG_PREFIX + addr, JSON.stringify(config));

    const channels = await this.listChannels();
    if (!channels.includes(addr)) {
      channels.push(addr);
      await this.storage.set(CHANNELS_KEY, JSON.stringify(channels));
    }
  }
}
