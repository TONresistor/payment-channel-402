/**
 * pc402-mcp — MCP server entry point
 *
 * Exposes pc402 payment channels as tools for AI agents.
 * Runs over stdio transport (JSON-RPC).
 *
 * Usage:
 *   pc402-mcp --wallet .wallet.json --rpc https://toncenter.com/api/v2/jsonRPC
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient } from "@ton/ton";
import { FileStorage } from "pc402-core";
import { ChannelPool, createPC402Fetch } from "pc402-fetch";
import { registerTools } from "./tools.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    wallet: { type: "string" },
    rpc: { type: "string" },
    "rpc-key": { type: "string" },
    storage: { type: "string" },
  },
  strict: false,
});

const walletPath = (values.wallet as string | undefined) ?? process.env.PC402_WALLET;
const rpcEndpoint = (values.rpc as string | undefined) ?? process.env.PC402_RPC_ENDPOINT;
const rpcApiKey = (values["rpc-key"] as string | undefined) ?? process.env.TONCENTER_API_KEY;
const storagePath =
  (values.storage as string | undefined) ?? process.env.PC402_STORAGE ?? "./pc402-channels.json";

if (!walletPath) {
  console.error("Error: --wallet <path> or PC402_WALLET is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  // Load wallet mnemonic
  const walletRaw = await readFile(walletPath!, "utf-8");
  const walletData = JSON.parse(walletRaw);
  const mnemonic: string[] = walletData.mnemonic ?? walletData;
  if (!Array.isArray(mnemonic) || mnemonic.length < 12) {
    console.error("Error: wallet file must contain a mnemonic array (12-24 words)");
    process.exit(1);
  }

  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const storage = new FileStorage(storagePath);

  // Optional TonClient for on-chain operations
  const client = rpcEndpoint
    ? new TonClient({ endpoint: rpcEndpoint, apiKey: rpcApiKey })
    : undefined;

  const fetch402 = createPC402Fetch({ keyPair, storage });
  const pool = new ChannelPool(keyPair, storage);

  const server = new McpServer({ name: "pc402", version: "0.3.0" });
  registerTools(server, { fetch402, pool, keyPair, client, storage });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
