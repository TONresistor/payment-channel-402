/**
 * pc402-cli — Command-line interface for pc402 payment channels
 *
 * Usage:
 *   pc402 fetch <url> [options]
 *   pc402 channel list|info|close
 *   pc402 wallet address|balance
 */

import { Command } from "commander";
import { makeFetchCommand } from "./commands/fetch.js";
import { makeChannelCommand } from "./commands/channel.js";
import { makeWalletCommand } from "./commands/wallet.js";
import { makeProtocolCommand } from "./commands/protocol.js";

const program = new Command()
  .name("pc402")
  .description("CLI for pc402 payment channels")
  .version("0.2.0")
  .option("--wallet <path>", "Path to wallet JSON file (or PC402_WALLET)")
  .option("--rpc <url>", "TonCenter RPC endpoint (or PC402_RPC_ENDPOINT)")
  .option("--rpc-key <key>", "RPC API key (or TONCENTER_API_KEY)")
  .option("--storage <path>", "Channel state file (or PC402_STORAGE)");

program.addCommand(makeFetchCommand());
program.addCommand(makeChannelCommand());
program.addCommand(makeWalletCommand());
program.addCommand(makeProtocolCommand());

program.parse();
