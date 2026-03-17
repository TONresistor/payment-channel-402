/**
 * pc402-core — StateManager
 *
 * Manages off-chain channel state with pluggable storage backends.
 * State is serialized as JSON with bigint values as strings.
 */

import type { ChannelState, StateStorage } from "./types.js";

/** Internal JSON-safe representation of ChannelState */
interface SerializedState {
  balanceA: string;
  balanceB: string;
  seqnoA: number;
  seqnoB: number;
}

function serialize(state: ChannelState): string {
  const obj: SerializedState = {
    balanceA: state.balanceA.toString(),
    balanceB: state.balanceB.toString(),
    seqnoA: state.seqnoA,
    seqnoB: state.seqnoB,
  };
  return JSON.stringify(obj);
}

function deserialize(raw: string): ChannelState {
  const obj: SerializedState = JSON.parse(raw);
  return {
    balanceA: BigInt(obj.balanceA),
    balanceB: BigInt(obj.balanceB),
    seqnoA: obj.seqnoA,
    seqnoB: obj.seqnoB,
  };
}

/** Key prefix to namespace state entries */
const STATE_PREFIX = "state:";

/** Key used to store the set of active client keys */
const CLIENTS_KEY = "_active_clients";

/**
 * Manages off-chain channel state with a pluggable storage backend.
 *
 * State is serialized as JSON with bigint values represented as decimal strings.
 * Also maintains the set of active client keys for bulk operations (e.g. cooperative close sweep).
 *
 * @example
 * ```typescript
 * const manager = new StateManager(new MemoryStorage());
 * await manager.saveState("client-pubkey-hex", { balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
 * const state = await manager.getState("client-pubkey-hex");
 * ```
 */
export class StateManager {
  private readonly storage: StateStorage;

  /**
   * Create a StateManager backed by the given storage implementation.
   *
   * @param storage - Any {@link StateStorage}-compliant backend (in-memory, Redis, filesystem, etc.)
   */
  constructor(storage: StateStorage) {
    this.storage = storage;
  }

  /**
   * Retrieve the last accepted state for a client.
   *
   * @param clientKey - Unique identifier for the client (typically the hex-encoded public key)
   * @returns The last saved {@link ChannelState}, or null if no state exists for this client
   */
  async getState(clientKey: string): Promise<ChannelState | null> {
    const raw = await this.storage.get(STATE_PREFIX + clientKey);
    if (raw === null) return null;
    return deserialize(raw);
  }

  /**
   * Persist an accepted channel state and register the client as active.
   *
   * Writes the serialized state to storage and adds `clientKey` to the active
   * client set so it appears in {@link getActiveClients}.
   *
   * @param clientKey - Unique identifier for the client (typically the hex-encoded public key)
   * @param state     - The new accepted {@link ChannelState} to persist
   */
  async saveState(clientKey: string, state: ChannelState): Promise<void> {
    await this.storage.set(STATE_PREFIX + clientKey, serialize(state));

    // Track active clients
    const clients = await this._getClientSet();
    clients.add(clientKey);
    await this._saveClientSet(clients);
  }

  /**
   * Return all currently active client keys.
   *
   * A client is active if at least one {@link saveState} call has been made
   * for it and it has not been removed via {@link removeState}.
   *
   * @returns Array of client key strings (order is not guaranteed)
   */
  async getActiveClients(): Promise<string[]> {
    const clients = await this._getClientSet();
    return Array.from(clients);
  }

  /**
   * Delete a client's state and remove it from the active client set.
   *
   * Should be called after a channel is cooperatively or uncooperatively closed
   * to reclaim storage and prevent the client from appearing in {@link getActiveClients}.
   *
   * @param clientKey - Unique identifier for the client to remove
   */
  async removeState(clientKey: string): Promise<void> {
    await this.storage.delete(STATE_PREFIX + clientKey);

    const clients = await this._getClientSet();
    clients.delete(clientKey);
    await this._saveClientSet(clients);
  }

  // ---------------------------------------------------------------------------
  // Internal: active clients tracking
  // ---------------------------------------------------------------------------

  private async _getClientSet(): Promise<Set<string>> {
    const raw = await this.storage.get(CLIENTS_KEY);
    if (raw === null) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  }

  private async _saveClientSet(clients: Set<string>): Promise<void> {
    await this.storage.set(CLIENTS_KEY, JSON.stringify(Array.from(clients)));
  }
}
