/**
 * pc402-core — FileStorage
 *
 * File-based implementation of StateStorage.
 * Stores all key-value pairs in a single JSON file.
 * Suitable for single-process servers with persistence needs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StateStorage } from "../types.js";

export class FileStorage implements StateStorage {
  private readonly filepath: string;
  private data: Map<string, string> | null = null;

  constructor(filepath: string) {
    this.filepath = filepath;
  }

  async get(key: string): Promise<string | null> {
    const data = await this._load();
    return data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this._load();
    data.set(key, value);
    await this._save(data);
  }

  async delete(key: string): Promise<void> {
    const data = await this._load();
    data.delete(key);
    await this._save(data);
  }

  // ---------------------------------------------------------------------------
  // Internal: file I/O
  // ---------------------------------------------------------------------------

  private async _load(): Promise<Map<string, string>> {
    if (this.data !== null) return this.data;
    try {
      const raw = await readFile(this.filepath, "utf-8");
      const obj = JSON.parse(raw) as Record<string, string>;
      this.data = new Map(Object.entries(obj));
    } catch {
      // File doesn't exist yet — start empty
      this.data = new Map();
    }
    return this.data;
  }

  private async _save(data: Map<string, string>): Promise<void> {
    this.data = data;
    const obj = Object.fromEntries(data);
    const dir = dirname(this.filepath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filepath, JSON.stringify(obj, null, 2), "utf-8");
  }
}
