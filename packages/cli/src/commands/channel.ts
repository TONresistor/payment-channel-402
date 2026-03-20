/**
 * pc402 channel list|info|close|status|topup|init|deploy|cooperative-close|
 * cooperative-commit|start-uncoop-close|challenge|finish-uncoop-close|pending-commit
 */

import { Address, beginCell } from "@ton/core";
import { Command } from "commander";
import { TonClient } from "@ton/ton";
import { OnchainChannel, buildSignedSemiChannel } from "pc402-channel";
import { balanceToSentCoins, buildSemiChannelBodyWithHeader, TAG_STATE } from "pc402-core";
import { ChannelPool, createSender, getOnchainState, topUpChannel, initChannel } from "pc402-fetch";
import { resolveConfig, type CliOpts } from "../config.js";

function requireRpc(config: { rpcEndpoint?: string; rpcApiKey?: string }): TonClient {
  if (!config.rpcEndpoint) {
    console.error("Error: --rpc <url> or PC402_RPC_ENDPOINT is required for on-chain operations");
    process.exit(1);
  }
  return new TonClient({ endpoint: config.rpcEndpoint, apiKey: config.rpcApiKey });
}

export function makeChannelCommand(): Command {
  const cmd = new Command("channel").description("Manage payment channels");

  cmd
    .command("list")
    .description("List all open channels (off-chain state)")
    .action(async () => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const pool = new ChannelPool(config.keyPair, config.storage);

      const channels = await pool.listChannels();
      if (channels.length === 0) {
        console.log("No channels.");
        return;
      }

      for (const addr of channels) {
        const state = await pool.getState(addr);
        if (state) {
          console.log(
            `${addr}  balA=${state.balanceA}  balB=${state.balanceB}  seqA=${state.seqnoA}  seqB=${state.seqnoB}`,
          );
        } else {
          console.log(`${addr}  (no state)`);
        }
      }
    });

  cmd
    .command("info")
    .description("Show off-chain details for a channel")
    .argument("<address>", "Channel address")
    .action(async (address: string) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const pool = new ChannelPool(config.keyPair, config.storage);

      const state = await pool.getState(address);
      if (!state) {
        console.error(`No state found for ${address}`);
        process.exit(1);
      }

      console.log(JSON.stringify({
        channelAddress: address,
        balanceA: state.balanceA.toString(),
        balanceB: state.balanceB.toString(),
        seqnoA: state.seqnoA,
        seqnoB: state.seqnoB,
      }, null, 2));
    });

  cmd
    .command("status")
    .description("Read on-chain channel state from the blockchain")
    .argument("<address>", "Channel contract address")
    .action(async (address: string) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        const state = await getOnchainState(client, address);
        const stateNames = ["uninited", "open", "quarantine"];
        console.log(JSON.stringify({
          channelAddress: address,
          state: stateNames[state.state] ?? "unknown",
          stateCode: state.state,
          balanceA: state.balanceA.toString(),
          balanceB: state.balanceB.toString(),
          channelId: state.channelId.toString(),
          seqnoA: state.seqnoA,
          seqnoB: state.seqnoB,
          withdrawnA: state.withdrawnA.toString(),
          withdrawnB: state.withdrawnB.toString(),
        }, null, 2));
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("topup")
    .description("Top up a channel with TON (on-chain)")
    .argument("<address>", "Channel contract address")
    .argument("<amount>", "Amount in nanotons")
    .action(async (address: string, amount: string) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        await topUpChannel(client, config.keyPair, address, BigInt(amount));
        console.log(`Topped up ${amount} nanoton to ${address}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("init")
    .description("Initialize a channel (UNINITED -> OPEN)")
    .argument("<address>", "Channel contract address")
    .requiredOption("--channel-id <id>", "Channel ID (uint128)")
    .requiredOption("--balance-a <amount>", "Party A initial balance in nanotons")
    .requiredOption("--balance-b <amount>", "Party B initial balance in nanotons")
    .action(async (address: string, opts: { channelId: string; balanceA: string; balanceB: string }) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        await initChannel(
          client,
          config.keyPair,
          address,
          BigInt(opts.channelId),
          BigInt(opts.balanceA),
          BigInt(opts.balanceB),
        );
        console.log(`Channel ${address} initialized.`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("close")
    .description("Close a channel (remove from local storage)")
    .argument("<address>", "Channel address")
    .action(async (address: string) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const pool = new ChannelPool(config.keyPair, config.storage);

      await pool.closeChannel(address);
      console.log(`Channel ${address} closed (local state removed).`);
    });

  // ---------------------------------------------------------------------------
  // On-chain lifecycle commands (pc402-channel)
  // ---------------------------------------------------------------------------

  /**
   * Load stored channel config from ChannelPool storage and build an OnchainChannel.
   * The pool stores config at key "pool:config:<address>" with shape:
   *   { channelId, channelAddress, serverPublicKey, initBalanceA, initBalanceB }
   * The CLI client is always party A.
   */
  async function loadOnchainChannel(
    client: TonClient,
    config: Awaited<ReturnType<typeof resolveConfig>>,
    channelAddress: string,
  ): Promise<OnchainChannel> {
    const raw = await config.storage.get(`pool:config:${channelAddress}`);
    if (!raw) {
      console.error(`Error: no channel config found for ${channelAddress}`);
      process.exit(1);
    }
    const cc = JSON.parse(raw) as {
      channelId: string;
      serverPublicKey: string;
      serverAddress?: string;
      initBalanceA: string;
      initBalanceB: string;
    };
    if (!cc.serverAddress) {
      console.error("Warning: stored config lacks serverAddress, using channel address as fallback");
    }
    const { address: myAddress } = createSender(client, config.keyPair);
    return new OnchainChannel({
      client,
      myKeyPair: config.keyPair,
      counterpartyPublicKey: Buffer.from(cc.serverPublicKey, "hex"),
      isA: true,
      channelId: BigInt(cc.channelId),
      myAddress,
      counterpartyAddress: Address.parse(cc.serverAddress || channelAddress),
      initBalanceA: BigInt(cc.initBalanceA),
      initBalanceB: BigInt(cc.initBalanceB),
    });
  }

  cmd
    .command("deploy")
    .description("Deploy a new channel and top it up (on-chain)")
    .argument("<amount>", "Amount to deposit in nanotons")
    .requiredOption("--channel-id <id>", "Channel ID (uint128)")
    .requiredOption("--counterparty-key <hex>", "Counterparty Ed25519 public key (hex)")
    .requiredOption("--counterparty-address <addr>", "Counterparty TON address")
    .option("--balance-a <amount>", "Party A initial balance in nanotons", "0")
    .option("--balance-b <amount>", "Party B initial balance in nanotons", "0")
    .action(async (amount: string, opts: {
      channelId: string;
      counterpartyKey: string;
      counterpartyAddress: string;
      balanceA: string;
      balanceB: string;
    }) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        const { sender, address: myAddress } = createSender(client, config.keyPair);
        const oc = new OnchainChannel({
          client,
          myKeyPair: config.keyPair,
          counterpartyPublicKey: Buffer.from(opts.counterpartyKey, "hex"),
          isA: true,
          channelId: BigInt(opts.channelId),
          myAddress,
          counterpartyAddress: Address.parse(opts.counterpartyAddress),
          initBalanceA: BigInt(opts.balanceA),
          initBalanceB: BigInt(opts.balanceB),
        });
        await oc.deployAndTopUp(sender, true, BigInt(amount));
        console.log(`Channel deployed at ${oc.getAddress().toString()}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("cooperative-close")
    .description("Cooperative close — settle and destroy channel (on-chain)")
    .argument("<address>", "Channel contract address")
    .requiredOption("--server-signature <hex>", "Server (party B) close signature (hex, 64 bytes)")
    .action(async (address: string, opts: { serverSignature: string }) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        const pool = new ChannelPool(config.keyPair, config.storage);
        const state = await pool.getState(address);
        if (!state) {
          console.error(`Error: no off-chain state for ${address}`);
          process.exit(1);
        }

        const oc = await loadOnchainChannel(client, config, address);
        const { sender } = createSender(client, config.keyPair);

        const raw = await config.storage.get(`pool:config:${address}`);
        const cc = JSON.parse(raw!) as { initBalanceA: string; initBalanceB: string };
        const initA = BigInt(cc.initBalanceA);
        const initB = BigInt(cc.initBalanceB);
        const sentA = balanceToSentCoins(initA, state.balanceA);
        const sentB = balanceToSentCoins(initB, state.balanceB);

        const sigA = oc.signClose(
          BigInt(state.seqnoA), BigInt(state.seqnoB), sentA, sentB, config.keyPair,
        );
        const sigB = Buffer.from(opts.serverSignature, "hex");

        await oc.cooperativeClose(
          sender, BigInt(state.seqnoA), BigInt(state.seqnoB), sentA, sentB, sigA, sigB,
        );
        console.log(`Cooperative close sent for ${address}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("cooperative-commit")
    .description("Cooperative commit — advance seqnos on-chain without closing")
    .argument("<address>", "Channel contract address")
    .requiredOption("--server-signature <hex>", "Server (party B) commit signature (hex, 64 bytes)")
    .option("--withdraw-a <amount>", "Amount to withdraw for A in nanotons", "0")
    .option("--withdraw-b <amount>", "Amount to withdraw for B in nanotons", "0")
    .action(async (address: string, opts: {
      serverSignature: string;
      withdrawA: string;
      withdrawB: string;
    }) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        const pool = new ChannelPool(config.keyPair, config.storage);
        const state = await pool.getState(address);
        if (!state) {
          console.error(`Error: no off-chain state for ${address}`);
          process.exit(1);
        }

        const oc = await loadOnchainChannel(client, config, address);
        const { sender } = createSender(client, config.keyPair);

        const raw = await config.storage.get(`pool:config:${address}`);
        const cc = JSON.parse(raw!) as { initBalanceA: string; initBalanceB: string };
        const sentA = balanceToSentCoins(BigInt(cc.initBalanceA), state.balanceA);
        const sentB = balanceToSentCoins(BigInt(cc.initBalanceB), state.balanceB);
        const withdrawA = BigInt(opts.withdrawA);
        const withdrawB = BigInt(opts.withdrawB);

        const sigA = oc.signCommit(
          BigInt(state.seqnoA), BigInt(state.seqnoB), sentA, sentB,
          config.keyPair, withdrawA, withdrawB,
        );
        const sigB = Buffer.from(opts.serverSignature, "hex");

        await oc.cooperativeCommit(
          sender, BigInt(state.seqnoA), BigInt(state.seqnoB),
          sentA, sentB, sigA, sigB, withdrawA, withdrawB,
        );
        console.log(`Cooperative commit sent for ${address}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("start-uncoop-close")
    .description("Start uncooperative close — submit state on-chain (on-chain)")
    .argument("<address>", "Channel contract address")
    .action(async (address: string) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        const pool = new ChannelPool(config.keyPair, config.storage);
        const state = await pool.getState(address);
        if (!state) {
          console.error(`Error: no off-chain state for ${address}`);
          process.exit(1);
        }

        const oc = await loadOnchainChannel(client, config, address);
        const { sender } = createSender(client, config.keyPair);

        const raw = await config.storage.get(`pool:config:${address}`);
        const cc = JSON.parse(raw!) as {
          channelId: string;
          serverPublicKey: string;
          initBalanceA: string;
          initBalanceB: string;
        };
        const channelId = BigInt(cc.channelId);
        const sentA = balanceToSentCoins(BigInt(cc.initBalanceA), state.balanceA);
        const sentB = balanceToSentCoins(BigInt(cc.initBalanceB), state.balanceB);

        // Build signed semi-channels: A signs own state, B's state uses server pubkey
        // For uncoop close, we sign our own semi-channel with our key
        const schA = buildSignedSemiChannel(
          channelId, BigInt(state.seqnoA), sentA, config.keyPair,
        );

        // Use stored server semi-channel signature if available
        const semiSigRaw = await config.storage.get("pool:semisig:" + address);
        let schB;
        if (semiSigRaw) {
          const sig = Buffer.from(semiSigRaw, "base64");
          const body = buildSemiChannelBodyWithHeader(channelId, state.seqnoB, sentB, TAG_STATE);
          schB = beginCell().storeBuffer(sig, 64).storeRef(body).endCell();
        } else {
          console.error("Warning: no stored server counter-signature (pool:semisig). Using dummy — will likely fail on-chain.");
          const serverKeyPair = {
            publicKey: Buffer.from(cc.serverPublicKey, "hex"),
            secretKey: Buffer.alloc(64),
          };
          schB = buildSignedSemiChannel(
            channelId, BigInt(state.seqnoB), sentB, serverKeyPair,
          );
        }

        const outerSig = oc.signStartUncoopClose(schA, schB, config.keyPair);
        await oc.startUncooperativeClose(sender, true, outerSig, schA, schB);
        console.log(`Uncooperative close started for ${address}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("challenge")
    .description("Challenge quarantined state with a newer one (on-chain)")
    .argument("<address>", "Channel contract address")
    .action(async (address: string) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        const pool = new ChannelPool(config.keyPair, config.storage);
        const state = await pool.getState(address);
        if (!state) {
          console.error(`Error: no off-chain state for ${address}`);
          process.exit(1);
        }

        const oc = await loadOnchainChannel(client, config, address);
        const { sender } = createSender(client, config.keyPair);

        const raw = await config.storage.get(`pool:config:${address}`);
        const cc = JSON.parse(raw!) as {
          channelId: string;
          serverPublicKey: string;
          initBalanceA: string;
          initBalanceB: string;
        };
        const channelId = BigInt(cc.channelId);
        const sentA = balanceToSentCoins(BigInt(cc.initBalanceA), state.balanceA);
        const sentB = balanceToSentCoins(BigInt(cc.initBalanceB), state.balanceB);

        const schA = buildSignedSemiChannel(
          channelId, BigInt(state.seqnoA), sentA, config.keyPair,
        );

        const semiSigRaw = await config.storage.get(`pool:semisig:${address}`);
        let schB;
        if (semiSigRaw) {
          const body = buildSemiChannelBodyWithHeader(channelId, state.seqnoB, sentB, TAG_STATE);
          const sig = Buffer.from(semiSigRaw, "base64");
          schB = beginCell().storeBuffer(sig, 64).storeRef(body).endCell();
        } else {
          console.error("Warning: no stored server counter-signature (pool:semisig). Using dummy — will likely fail on-chain.");
          const serverKeyPair = {
            publicKey: Buffer.from(cc.serverPublicKey, "hex"),
            secretKey: Buffer.alloc(64),
          };
          schB = buildSignedSemiChannel(
            channelId, BigInt(state.seqnoB), sentB, serverKeyPair,
          );
        }

        const outerSig = oc.signChallenge(schA, schB, config.keyPair);
        await oc.challengeQuarantinedState(sender, true, outerSig, schA, schB);
        console.log(`Challenge sent for ${address}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("finish-uncoop-close")
    .description("Finish uncooperative close after quarantine timeout (on-chain)")
    .argument("<address>", "Channel contract address")
    .action(async (address: string) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);
      const client = requireRpc(config);

      try {
        const oc = await loadOnchainChannel(client, config, address);
        const { sender } = createSender(client, config.keyPair);
        await oc.finishUncooperativeClose(sender);
        console.log(`Uncooperative close finished for ${address}`);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  cmd
    .command("pending-commit")
    .description("Show pending commit signature for a channel (read-only)")
    .argument("<address>", "Channel address")
    .action(async (address: string) => {
      const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);

      const raw = await config.storage.get(`pool:commit:${address}`);
      if (!raw) {
        console.log("No pending commit.");
      } else {
        console.log(`Pending commit signature: ${raw}`);
      }
    });

  return cmd;
}
