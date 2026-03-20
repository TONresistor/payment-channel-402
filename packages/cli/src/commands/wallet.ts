/**
 * pc402 wallet balance|address — Wallet info
 */

import { Command } from "commander";
import { TonClient } from "@ton/ton";
import { getWalletAddress, getWalletBalance } from "pc402-fetch";
import { resolveConfig, type CliOpts } from "../config.js";

export function makeWalletCommand(): Command {
  const cmd = new Command("wallet").description("Wallet information");

  cmd
    .command("address")
    .description("Show wallet address")
    .action(async () => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      console.log(getWalletAddress(config.keyPair).toString());
    });

  cmd
    .command("balance")
    .description("Show wallet TON balance")
    .action(async () => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);

      if (!config.rpcEndpoint) {
        console.error("Error: --rpc <url> or PC402_RPC_ENDPOINT is required for balance");
        process.exit(1);
      }

      const client = new TonClient({
        endpoint: config.rpcEndpoint,
        apiKey: config.rpcApiKey,
      });

      const addr = getWalletAddress(config.keyPair);
      const balance = await getWalletBalance(client, config.keyPair);
      const ton = Number(balance) / 1e9;
      console.log(addr.toString());
      console.log(`${ton.toFixed(4)} TON (${balance} nanoton)`);
    });

  return cmd;
}
