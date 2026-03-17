/**
 * pc402-core — MemoryStorage
 *
 * In-memory implementation of StateStorage.
 * Suitable for development, testing, and short-lived processes.
 */

import type { StateStorage } from "../types.js";

export class MemoryStorage implements StateStorage {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}
