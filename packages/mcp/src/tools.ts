/**
 * pc402-mcp — Tool definitions
 *
 * Registers pc402 tools on an McpServer instance:
 *   pc402_fetch              — Fetch a URL with automatic 402 payment
 *   pc402_balance            — Show channel balances (off-chain)
 *   pc402_status             — Show on-chain channel state
 *   pc402_topup              — Top up a channel on-chain
 *   pc402_close              — Close a payment channel (remove from local storage)
 *   pc402_deploy             — Deploy a new channel
 *   pc402_cooperative_close  — Cooperative close
 *   pc402_cooperative_commit — Cooperative commit
 *   pc402_start_uncoop_close — Start uncooperative close
 *   pc402_challenge          — Challenge quarantined state
 *   pc402_finish_uncoop_close — Finish uncooperative close
 *   pc402_pending_commit     — Show pending commit
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Address, beginCell } from "@ton/core";
import type { KeyPair } from "@ton/crypto";
import type { TonClient } from "@ton/ton";
import { buildSignedSemiChannel, OnchainChannel } from "pc402-channel";
import type { StateStorage } from "pc402-core";
import { balanceToSentCoins, buildSemiChannelBodyWithHeader, TAG_STATE } from "pc402-core";
import type { ChannelPool, PC402Fetch } from "pc402-fetch";
import {
  createSender,
  getOnchainState,
  getWalletAddress,
  getWalletBalance,
  initChannel,
  topUpChannel,
} from "pc402-fetch";
import { z } from "zod";

export interface ToolDeps {
  fetch402: PC402Fetch;
  pool: ChannelPool;
  keyPair: KeyPair;
  client?: TonClient;
  storage: StateStorage;
}

/**
 * Load stored channel config from ChannelPool storage and build an OnchainChannel.
 * The pool stores config at key "pool:config:<address>" with shape:
 *   { channelId, channelAddress, serverPublicKey, initBalanceA, initBalanceB }
 * The MCP client is always party A.
 */
async function loadOnchainChannel(
  client: TonClient,
  keyPair: KeyPair,
  storage: StateStorage,
  channelAddress: string,
): Promise<OnchainChannel> {
  const raw = await storage.get(`pool:config:${channelAddress}`);
  if (!raw) throw new Error(`No channel config found for ${channelAddress}`);
  const cc = JSON.parse(raw) as {
    channelId: string;
    serverPublicKey: string;
    serverAddress?: string;
    initBalanceA: string;
    initBalanceB: string;
  };
  const { address: myAddress } = createSender(client, keyPair);
  return new OnchainChannel({
    client,
    myKeyPair: keyPair,
    counterpartyPublicKey: Buffer.from(cc.serverPublicKey, "hex"),
    isA: true,
    channelId: BigInt(cc.channelId),
    myAddress,
    counterpartyAddress: Address.parse(cc.serverAddress || channelAddress),
    initBalanceA: BigInt(cc.initBalanceA),
    initBalanceB: BigInt(cc.initBalanceB),
  });
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { fetch402, pool, keyPair, client, storage } = deps;

  // -------------------------------------------------------------------------
  // pc402_fetch
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_fetch",
    "Fetch a URL with automatic HTTP 402 payment. If the server requires payment, it is handled transparently.",
    {
      url: z.string().describe("URL to fetch"),
      method: z.string().optional().describe("HTTP method (default GET)"),
      body: z.string().optional().describe("Request body (for POST/PUT)"),
      headers: z.record(z.string()).optional().describe("Additional HTTP headers"),
    },
    async ({ url, method, body, headers }) => {
      try {
        const init: RequestInit = {};
        if (method) init.method = method;
        if (body) init.body = body;
        if (headers) init.headers = headers;

        const res = await fetch402(url, init);
        const text = await res.text();
        const paid = res.headers.has("payment-response");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: res.status, body: text, paid }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_balance
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_balance",
    "Show off-chain payment channel balances from local storage.",
    {
      channelAddress: z.string().optional().describe("Specific channel address (omit for all)"),
    },
    async ({ channelAddress }) => {
      try {
        const addresses = channelAddress ? [channelAddress] : await pool.listChannels();
        const channels = [];
        for (const addr of addresses) {
          const state = await pool.getState(addr);
          channels.push({
            address: addr,
            balanceA: state ? state.balanceA.toString() : "0",
            balanceB: state ? state.balanceB.toString() : "0",
            seqnoA: state?.seqnoA ?? 0,
            seqnoB: state?.seqnoB ?? 0,
          });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify({ channels }) }] };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_status (on-chain)
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_status",
    "Read on-chain channel state from the blockchain. Requires RPC endpoint.",
    {
      channelAddress: z.string().describe("Channel contract address"),
    },
    async ({ channelAddress }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        const state = await getOnchainState(client, channelAddress);
        const stateNames = ["uninited", "open", "quarantine"];
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...state,
                stateName: stateNames[state.state] ?? "unknown",
                balanceA: state.balanceA.toString(),
                balanceB: state.balanceB.toString(),
                channelId: state.channelId.toString(),
                withdrawnA: state.withdrawnA.toString(),
                withdrawnB: state.withdrawnB.toString(),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_topup
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_topup",
    "Top up a payment channel with TON. Sends funds to the on-chain contract.",
    {
      channelAddress: z.string().describe("Channel contract address"),
      amount: z.string().describe("Amount in nanotons to deposit"),
    },
    async ({ channelAddress, amount }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        await topUpChannel(client, keyPair, channelAddress, BigInt(amount));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, channelAddress, amount }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_init
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_init",
    "Initialize a payment channel (transition from UNINITED to OPEN). Must be topped up first.",
    {
      channelAddress: z.string().describe("Channel contract address"),
      channelId: z.string().describe("Channel ID (uint128 as string)"),
      balanceA: z.string().describe("Party A initial balance in nanotons"),
      balanceB: z.string().describe("Party B initial balance in nanotons"),
    },
    async ({ channelAddress, channelId, balanceA, balanceB }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        await initChannel(
          client,
          keyPair,
          channelAddress,
          BigInt(channelId),
          BigInt(balanceA),
          BigInt(balanceB),
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: true, channelAddress }) },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_wallet
  // -------------------------------------------------------------------------
  server.tool("pc402_wallet", "Show wallet address and TON balance.", {}, async () => {
    try {
      const address = getWalletAddress(keyPair).toString();
      let balance = "unknown";
      if (client) {
        const bal = await getWalletBalance(client, keyPair);
        balance = bal.toString();
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ address, balance }) }] };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
        ],
        isError: true,
      };
    }
  });

  // -------------------------------------------------------------------------
  // pc402_close
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_close",
    "Close a payment channel (remove from local storage).",
    {
      channelAddress: z.string().describe("Address of the channel to close"),
    },
    async ({ channelAddress }) => {
      try {
        await pool.closeChannel(channelAddress);
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }] };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_deploy
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_deploy",
    "Deploy a new payment channel and top it up (on-chain).",
    {
      amount: z.string().describe("Amount to deposit in nanotons"),
      channelId: z.string().describe("Channel ID (uint128 as string)"),
      counterpartyKey: z.string().describe("Counterparty Ed25519 public key (hex)"),
      counterpartyAddress: z.string().describe("Counterparty TON address"),
      balanceA: z.string().optional().describe("Party A initial balance in nanotons (default 0)"),
      balanceB: z.string().optional().describe("Party B initial balance in nanotons (default 0)"),
    },
    async ({ amount, channelId, counterpartyKey, counterpartyAddress, balanceA, balanceB }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        const { sender, address: myAddress } = createSender(client, keyPair);
        const oc = new OnchainChannel({
          client,
          myKeyPair: keyPair,
          counterpartyPublicKey: Buffer.from(counterpartyKey, "hex"),
          isA: true,
          channelId: BigInt(channelId),
          myAddress,
          counterpartyAddress: Address.parse(counterpartyAddress),
          initBalanceA: BigInt(balanceA ?? "0"),
          initBalanceB: BigInt(balanceB ?? "0"),
        });
        await oc.deployAndTopUp(sender, true, BigInt(amount));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, channelAddress: oc.getAddress().toString() }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_cooperative_close
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_cooperative_close",
    "Cooperative close — settle and destroy a payment channel (on-chain). Requires server signature.",
    {
      channelAddress: z.string().describe("Channel contract address"),
      serverSignature: z.string().describe("Server (party B) close signature (base64)"),
    },
    async ({ channelAddress, serverSignature }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        const state = await pool.getState(channelAddress);
        if (!state) throw new Error(`No off-chain state for ${channelAddress}`);

        const oc = await loadOnchainChannel(client, keyPair, storage, channelAddress);
        const { sender } = createSender(client, keyPair);

        const raw = await storage.get(`pool:config:${channelAddress}`);
        const cc = JSON.parse(raw!) as { initBalanceA: string; initBalanceB: string };
        const initA = BigInt(cc.initBalanceA);
        const initB = BigInt(cc.initBalanceB);
        const sentA = balanceToSentCoins(initA, state.balanceA);
        const sentB = balanceToSentCoins(initB, state.balanceB);

        const sigA = oc.signClose(
          BigInt(state.seqnoA),
          BigInt(state.seqnoB),
          sentA,
          sentB,
          keyPair,
        );
        const sigB = Buffer.from(serverSignature, "base64");

        await oc.cooperativeClose(
          sender,
          BigInt(state.seqnoA),
          BigInt(state.seqnoB),
          sentA,
          sentB,
          sigA,
          sigB,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: true, channelAddress }) },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_cooperative_commit
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_cooperative_commit",
    "Cooperative commit — advance seqnos on-chain without closing.",
    {
      channelAddress: z.string().describe("Channel contract address"),
      serverSignature: z.string().describe("Server (party B) commit signature (base64)"),
      withdrawA: z.string().optional().describe("Amount to withdraw for A in nanotons (default 0)"),
      withdrawB: z.string().optional().describe("Amount to withdraw for B in nanotons (default 0)"),
    },
    async ({ channelAddress, serverSignature, withdrawA, withdrawB }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        const state = await pool.getState(channelAddress);
        if (!state) throw new Error(`No off-chain state for ${channelAddress}`);

        const oc = await loadOnchainChannel(client, keyPair, storage, channelAddress);
        const { sender } = createSender(client, keyPair);

        const raw = await storage.get(`pool:config:${channelAddress}`);
        const cc = JSON.parse(raw!) as { initBalanceA: string; initBalanceB: string };
        const sentA = balanceToSentCoins(BigInt(cc.initBalanceA), state.balanceA);
        const sentB = balanceToSentCoins(BigInt(cc.initBalanceB), state.balanceB);
        const wA = BigInt(withdrawA ?? "0");
        const wB = BigInt(withdrawB ?? "0");

        const sigA = oc.signCommit(
          BigInt(state.seqnoA),
          BigInt(state.seqnoB),
          sentA,
          sentB,
          keyPair,
          wA,
          wB,
        );
        const sigB = Buffer.from(serverSignature, "base64");

        await oc.cooperativeCommit(
          sender,
          BigInt(state.seqnoA),
          BigInt(state.seqnoB),
          sentA,
          sentB,
          sigA,
          sigB,
          wA,
          wB,
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: true, channelAddress }) },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_start_uncoop_close
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_start_uncoop_close",
    "Start uncooperative close — submit state on-chain. WARNING: requires server counter-signatures which may not be stored yet.",
    {
      channelAddress: z.string().describe("Channel contract address"),
    },
    async ({ channelAddress }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        const state = await pool.getState(channelAddress);
        if (!state) throw new Error(`No off-chain state for ${channelAddress}`);

        const oc = await loadOnchainChannel(client, keyPair, storage, channelAddress);
        const { sender } = createSender(client, keyPair);

        const raw = await storage.get(`pool:config:${channelAddress}`);
        const cc = JSON.parse(raw!) as {
          channelId: string;
          serverPublicKey: string;
          initBalanceA: string;
          initBalanceB: string;
        };
        const channelId = BigInt(cc.channelId);
        const sentA = balanceToSentCoins(BigInt(cc.initBalanceA), state.balanceA);
        const sentB = balanceToSentCoins(BigInt(cc.initBalanceB), state.balanceB);

        const schA = buildSignedSemiChannel(channelId, BigInt(state.seqnoA), sentA, keyPair);

        // Use stored server semi-channel signature if available
        const semiSigRaw = await storage.get("pool:semisig:" + channelAddress);
        let schB: import("@ton/core").Cell;
        if (semiSigRaw) {
          const sig = Buffer.from(semiSigRaw, "base64");
          const body = buildSemiChannelBodyWithHeader(channelId, state.seqnoB, sentB, TAG_STATE);
          schB = beginCell().storeBuffer(sig, 64).storeRef(body).endCell();
        } else {
          const serverKeyPair = {
            publicKey: Buffer.from(cc.serverPublicKey, "hex"),
            secretKey: Buffer.alloc(64),
          };
          schB = buildSignedSemiChannel(channelId, BigInt(state.seqnoB), sentB, serverKeyPair);
        }

        const outerSig = oc.signStartUncoopClose(schA, schB, keyPair);
        await oc.startUncooperativeClose(sender, true, outerSig, schA, schB);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                channelAddress,
                ...(semiSigRaw
                  ? {}
                  : {
                      warning:
                        "Uncooperative close requires server counter-signatures. This may fail on-chain if they are not stored.",
                    }),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_challenge
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_challenge",
    "Challenge quarantined state with a newer one (on-chain). WARNING: requires server counter-signatures.",
    {
      channelAddress: z.string().describe("Channel contract address"),
    },
    async ({ channelAddress }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        const state = await pool.getState(channelAddress);
        if (!state) throw new Error(`No off-chain state for ${channelAddress}`);

        const oc = await loadOnchainChannel(client, keyPair, storage, channelAddress);
        const { sender } = createSender(client, keyPair);

        const raw = await storage.get(`pool:config:${channelAddress}`);
        const cc = JSON.parse(raw!) as {
          channelId: string;
          serverPublicKey: string;
          initBalanceA: string;
          initBalanceB: string;
        };
        const channelId = BigInt(cc.channelId);
        const sentA = balanceToSentCoins(BigInt(cc.initBalanceA), state.balanceA);
        const sentB = balanceToSentCoins(BigInt(cc.initBalanceB), state.balanceB);

        const schA = buildSignedSemiChannel(channelId, BigInt(state.seqnoA), sentA, keyPair);

        // Use stored server semi-channel signature if available
        const semiSigRaw = await storage.get("pool:semisig:" + channelAddress);
        let schB: import("@ton/core").Cell;
        if (semiSigRaw) {
          const sig = Buffer.from(semiSigRaw, "base64");
          const body = buildSemiChannelBodyWithHeader(channelId, state.seqnoB, sentB, TAG_STATE);
          schB = beginCell().storeBuffer(sig, 64).storeRef(body).endCell();
        } else {
          const serverKeyPair = {
            publicKey: Buffer.from(cc.serverPublicKey, "hex"),
            secretKey: Buffer.alloc(64),
          };
          schB = buildSignedSemiChannel(channelId, BigInt(state.seqnoB), sentB, serverKeyPair);
        }

        const outerSig = oc.signChallenge(schA, schB, keyPair);
        await oc.challengeQuarantinedState(sender, true, outerSig, schA, schB);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                channelAddress,
                ...(semiSigRaw
                  ? {}
                  : {
                      warning:
                        "Challenge requires server counter-signatures. This may fail on-chain if they are not stored.",
                    }),
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_finish_uncoop_close
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_finish_uncoop_close",
    "Finish uncooperative close after quarantine timeout (on-chain).",
    {
      channelAddress: z.string().describe("Channel contract address"),
    },
    async ({ channelAddress }) => {
      try {
        if (!client) throw new Error("RPC endpoint not configured (--rpc)");
        const oc = await loadOnchainChannel(client, keyPair, storage, channelAddress);
        const { sender } = createSender(client, keyPair);
        await oc.finishUncooperativeClose(sender);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: true, channelAddress }) },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // pc402_pending_commit
  // -------------------------------------------------------------------------
  server.tool(
    "pc402_pending_commit",
    "Show pending commit signature for a channel (read-only).",
    {
      channelAddress: z.string().describe("Channel address"),
    },
    async ({ channelAddress }) => {
      try {
        const raw = await storage.get(`pool:commit:${channelAddress}`);
        if (!raw) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ pending: false }) }] };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ pending: true, signature: raw }) },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : err}` },
          ],
          isError: true,
        };
      }
    },
  );
}
