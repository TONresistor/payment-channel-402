/**
 * pc402-cli — Shared configuration loader
 *
 * Resolves wallet path, RPC endpoint, and storage from CLI opts or env vars.
 * Derives KeyPair from mnemonic on demand.
 */

import { readFile } from "node:fs/promises";
import type { KeyPair } from "@ton/crypto";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { FileStorage, type StateStorage } from "pc402-core";

export interface ResolvedConfig {
  keyPair: KeyPair;
  storage: StateStorage;
  rpcEndpoint: string | undefined;
  rpcApiKey: string | undefined;
}

export interface CliOpts {
  wallet?: string;
  rpc?: string;
  rpcKey?: string;
  storage?: string;
}

export async function resolveConfig(opts: CliOpts): Promise<ResolvedConfig> {
  const walletPath = opts.wallet ?? process.env.PC402_WALLET;
  if (!walletPath) {
    console.error("Error: --wallet <path> or PC402_WALLET is required");
    process.exit(1);
  }

  const walletRaw = await readFile(walletPath, "utf-8");
  const walletData = JSON.parse(walletRaw);
  const mnemonic: string[] = walletData.mnemonic ?? walletData;
  if (!Array.isArray(mnemonic) || mnemonic.length < 12) {
    console.error("Error: wallet file must contain a mnemonic array (12-24 words)");
    process.exit(1);
  }

  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const storagePath = opts.storage ?? process.env.PC402_STORAGE ?? "./pc402-channels.json";
  const storage = new FileStorage(storagePath);
  const rpcEndpoint = opts.rpc ?? process.env.PC402_RPC_ENDPOINT;
  const rpcApiKey = opts.rpcKey ?? process.env.TONCENTER_API_KEY;

  return { keyPair, storage, rpcEndpoint, rpcApiKey };
}
