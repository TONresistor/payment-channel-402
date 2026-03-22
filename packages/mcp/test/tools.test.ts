/**
 * Unit tests for all 14 MCP tools registered by registerTools().
 *
 * Strategy: create a spy McpServer that captures tool handlers from
 * server.tool() calls, then invoke each handler directly with mocked deps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KeyPair } from "@ton/crypto";
import { keyPairFromSeed } from "@ton/crypto";
import type { ChannelPool, PC402Fetch } from "pc402-fetch";
import type { StateStorage } from "pc402-core";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { type ToolDeps, registerTools } from "../src/tools.js";

// ---------------------------------------------------------------------------
// Mock external modules that tools.ts imports at the module level
// ---------------------------------------------------------------------------

vi.mock("pc402-fetch", async () => {
  const actual = await vi.importActual<typeof import("pc402-fetch")>("pc402-fetch");
  return {
    ...actual,
    createSender: vi.fn(() => ({
      sender: { send: vi.fn() },
      address: { toString: () => "EQWallet000" },
    })),
    getOnchainState: vi.fn(),
    getWalletAddress: vi.fn(() => ({ toString: () => "EQWalletAddr" })),
    getWalletBalance: vi.fn(),
    initChannel: vi.fn(),
    topUpChannel: vi.fn(),
  };
});

vi.mock("pc402-channel", async () => {
  const actual = await vi.importActual<typeof import("pc402-channel")>("pc402-channel");
  return {
    ...actual,
    OnchainChannel: vi.fn().mockImplementation(() => ({
      deployAndTopUp: vi.fn(),
      getAddress: () => ({ toString: () => "EQDeployed000" }),
      signClose: vi.fn(() => Buffer.alloc(64, 1)),
      cooperativeClose: vi.fn(),
      signCommit: vi.fn(() => Buffer.alloc(64, 2)),
      cooperativeCommit: vi.fn(),
      signStartUncoopClose: vi.fn(() => Buffer.alloc(64, 3)),
      startUncooperativeClose: vi.fn(),
      signChallenge: vi.fn(() => Buffer.alloc(64, 4)),
      challengeQuarantinedState: vi.fn(),
      finishUncooperativeClose: vi.fn(),
    })),
    buildSignedSemiChannel: vi.fn(() => ({
      /* mock Cell */
    })),
  };
});

// Import the mocked modules so we can control return values
import {
  getOnchainState,
  getWalletAddress,
  getWalletBalance,
  topUpChannel,
  initChannel,
  createSender,
} from "pc402-fetch";
import { OnchainChannel } from "pc402-channel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeyPair(): KeyPair {
  return keyPairFromSeed(Buffer.alloc(32, 0xaa));
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

/** Build a spy McpServer that captures tool handlers. */
function captureHandlers(deps: ToolDeps): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const mockServer = {
    tool: (...toolArgs: unknown[]) => {
      // server.tool(name, desc, schema, handler) — 4-arg form
      const name = toolArgs[0] as string;
      const handler = toolArgs[toolArgs.length - 1] as ToolHandler;
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerTools(mockServer, deps);
  return handlers;
}

function parseText(result: { content: { type: string; text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const CHANNEL_ADDR = "EQCqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqseb";
const SERVER_ADDR = "EQC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u-7U";
const SERVER_PUBKEY = "bb".repeat(32);
const keyPair = makeKeyPair();

let mockPool: {
  listChannels: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  closeChannel: ReturnType<typeof vi.fn>;
};
let mockStorage: {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let mockFetch402: ReturnType<typeof vi.fn>;
let handlers: Map<string, ToolHandler>;

function makeDeps(opts: { withClient?: boolean } = {}): ToolDeps {
  return {
    fetch402: mockFetch402 as unknown as PC402Fetch,
    pool: mockPool as unknown as ChannelPool,
    keyPair,
    client: opts.withClient ? ({} as any) : undefined,
    storage: mockStorage as unknown as StateStorage,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockPool = {
    listChannels: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(null),
    closeChannel: vi.fn().mockResolvedValue(undefined),
  };

  mockStorage = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };

  mockFetch402 = vi.fn();
});

// ---------------------------------------------------------------------------
// 1. pc402_fetch
// ---------------------------------------------------------------------------
describe("pc402_fetch", () => {
  it("returns status, body, paid on success", async () => {
    const resBody = '{"answer":42}';
    mockFetch402.mockResolvedValue(
      new Response(resBody, {
        status: 200,
        headers: { "payment-response": "sig123" },
      }),
    );
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_fetch")!({ url: "https://example.com/api" });
    const data = parseText(result) as any;
    expect(data.status).toBe(200);
    expect(data.body).toBe(resBody);
    expect(data.paid).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it("returns isError on fetch failure", async () => {
    mockFetch402.mockRejectedValue(new Error("network down"));
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_fetch")!({ url: "https://example.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("network down");
  });

  it("forwards method, body and headers", async () => {
    mockFetch402.mockResolvedValue(new Response("ok", { status: 200 }));
    handlers = captureHandlers(makeDeps());
    await handlers.get("pc402_fetch")!({
      url: "https://example.com",
      method: "POST",
      body: '{"q":1}',
      headers: { "x-custom": "val" },
    });
    const call = mockFetch402.mock.calls[0];
    expect(call[0]).toBe("https://example.com");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe('{"q":1}');
    expect(call[1].headers).toEqual({ "x-custom": "val" });
  });

  it("returns paid: false when no payment-response header", async () => {
    mockFetch402.mockResolvedValue(new Response("free", { status: 200 }));
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_fetch")!({ url: "https://example.com/free" });
    const data = parseText(result) as any;
    expect(data.paid).toBe(false);
    expect(result.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. pc402_balance
// ---------------------------------------------------------------------------
describe("pc402_balance", () => {
  it("returns empty array when no channels", async () => {
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_balance")!({});
    const data = parseText(result) as any;
    expect(data.channels).toEqual([]);
  });

  it("returns balance info for channels", async () => {
    mockPool.listChannels.mockResolvedValue(["EQCh1", "EQCh2"]);
    mockPool.getState
      .mockResolvedValueOnce({ balanceA: 1000n, balanceB: 500n, seqnoA: 3, seqnoB: 1 })
      .mockResolvedValueOnce(null);
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_balance")!({});
    const data = parseText(result) as any;
    expect(data.channels).toHaveLength(2);
    expect(data.channels[0]).toEqual({
      address: "EQCh1",
      balanceA: "1000",
      balanceB: "500",
      seqnoA: 3,
      seqnoB: 1,
    });
    expect(data.channels[1].balanceA).toBe("0");
  });

  it("queries a specific channel when address provided", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 100n, balanceB: 0n, seqnoA: 1, seqnoB: 0 });
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_balance")!({ channelAddress: "EQSpecific" });
    const data = parseText(result) as any;
    expect(data.channels).toHaveLength(1);
    expect(data.channels[0].address).toBe("EQSpecific");
    expect(mockPool.listChannels).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. pc402_wallet
// ---------------------------------------------------------------------------
describe("pc402_wallet", () => {
  it("returns address and unknown balance without RPC", async () => {
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_wallet")!({});
    const data = parseText(result) as any;
    expect(data.address).toBe("EQWalletAddr");
    expect(data.balance).toBe("unknown");
  });

  it("returns address and balance with RPC", async () => {
    vi.mocked(getWalletBalance).mockResolvedValue(5_000_000_000n);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_wallet")!({});
    const data = parseText(result) as any;
    expect(data.address).toBe("EQWalletAddr");
    expect(data.balance).toBe("5000000000");
  });
});

// ---------------------------------------------------------------------------
// 4. pc402_status
// ---------------------------------------------------------------------------
describe("pc402_status", () => {
  it("returns error without RPC", async () => {
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_status")!({ channelAddress: CHANNEL_ADDR });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("returns on-chain state with RPC", async () => {
    vi.mocked(getOnchainState).mockResolvedValue({
      state: 1,
      balanceA: 1000n,
      balanceB: 200n,
      channelId: 42n,
      seqnoA: 5,
      seqnoB: 2,
      withdrawnA: 0n,
      withdrawnB: 0n,
    });
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_status")!({ channelAddress: CHANNEL_ADDR });
    const data = parseText(result) as any;
    expect(data.stateName).toBe("open");
    expect(data.balanceA).toBe("1000");
    expect(data.channelId).toBe("42");
  });

  it("maps state=0 to uninited", async () => {
    vi.mocked(getOnchainState).mockResolvedValue({
      state: 0,
      balanceA: 0n,
      balanceB: 0n,
      channelId: 1n,
      seqnoA: 0,
      seqnoB: 0,
      withdrawnA: 0n,
      withdrawnB: 0n,
    });
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_status")!({ channelAddress: CHANNEL_ADDR });
    const data = parseText(result) as any;
    expect(data.stateName).toBe("uninited");
  });
});

// ---------------------------------------------------------------------------
// 5. pc402_topup
// ---------------------------------------------------------------------------
describe("pc402_topup", () => {
  it("returns error without RPC", async () => {
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_topup")!({
      channelAddress: CHANNEL_ADDR,
      amount: "1000000000",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("calls topUpChannel and returns success", async () => {
    vi.mocked(topUpChannel).mockResolvedValue(undefined);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_topup")!({
      channelAddress: CHANNEL_ADDR,
      amount: "1000000000",
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.channelAddress).toBe(CHANNEL_ADDR);
    expect(data.amount).toBe("1000000000");
    expect(topUpChannel).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. pc402_init
// ---------------------------------------------------------------------------
describe("pc402_init", () => {
  it("returns error without RPC", async () => {
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_init")!({
      channelAddress: CHANNEL_ADDR,
      channelId: "42",
      balanceA: "1000",
      balanceB: "0",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("calls initChannel and returns success", async () => {
    vi.mocked(initChannel).mockResolvedValue(undefined);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_init")!({
      channelAddress: CHANNEL_ADDR,
      channelId: "42",
      balanceA: "1000",
      balanceB: "0",
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.channelAddress).toBe(CHANNEL_ADDR);
    expect(initChannel).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. pc402_close
// ---------------------------------------------------------------------------
describe("pc402_close", () => {
  it("calls pool.closeChannel and returns success", async () => {
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_close")!({ channelAddress: CHANNEL_ADDR });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(mockPool.closeChannel).toHaveBeenCalledWith(CHANNEL_ADDR);
  });

  it("returns isError when closeChannel throws", async () => {
    mockPool.closeChannel.mockRejectedValue(new Error("not found"));
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_close")!({ channelAddress: CHANNEL_ADDR });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// 8. pc402_deploy
// ---------------------------------------------------------------------------
describe("pc402_deploy", () => {
  it("returns error without RPC", async () => {
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_deploy")!({
      amount: "1000000000",
      channelId: "42",
      counterpartyKey: SERVER_PUBKEY,
      counterpartyAddress: SERVER_ADDR,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("deploys channel and returns success", async () => {
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_deploy")!({
      amount: "1000000000",
      channelId: "42",
      counterpartyKey: SERVER_PUBKEY,
      counterpartyAddress: SERVER_ADDR,
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.channelAddress).toBe("EQDeployed000");
  });

  it("forwards optional balanceA and balanceB to OnchainChannel", async () => {
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_deploy")!({
      amount: "1000000000",
      channelId: "42",
      counterpartyKey: SERVER_PUBKEY,
      counterpartyAddress: SERVER_ADDR,
      balanceA: "800000000",
      balanceB: "200000000",
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    const ctorCall = vi.mocked(OnchainChannel).mock.calls[0][0] as any;
    expect(ctorCall.initBalanceA).toBe(800000000n);
    expect(ctorCall.initBalanceB).toBe(200000000n);
  });
});

// ---------------------------------------------------------------------------
// 9. pc402_cooperative_close
// ---------------------------------------------------------------------------
describe("pc402_cooperative_close", () => {
  const configPayload = JSON.stringify({
    channelId: "42",
    serverPublicKey: SERVER_PUBKEY,
    serverAddress: SERVER_ADDR,
    initBalanceA: "1000000000",
    initBalanceB: "0",
  });

  it("returns error without off-chain state", async () => {
    mockPool.getState.mockResolvedValue(null);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_cooperative_close")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No off-chain state");
  });

  it("returns error without RPC", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_cooperative_close")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("performs cooperative close with valid state", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    mockStorage.get.mockResolvedValue(configPayload);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_cooperative_close")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.channelAddress).toBe(CHANNEL_ADDR);
  });

  it("calls signClose and cooperativeClose on the OnchainChannel instance", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    mockStorage.get.mockResolvedValue(configPayload);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    await handlers.get("pc402_cooperative_close")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
    });
    const instance = vi.mocked(OnchainChannel).mock.results[0].value;
    expect(instance.signClose).toHaveBeenCalled();
    expect(instance.cooperativeClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 10. pc402_cooperative_commit
// ---------------------------------------------------------------------------
describe("pc402_cooperative_commit", () => {
  const configPayload = JSON.stringify({
    channelId: "42",
    serverPublicKey: SERVER_PUBKEY,
    serverAddress: SERVER_ADDR,
    initBalanceA: "1000000000",
    initBalanceB: "0",
  });

  it("returns error without off-chain state", async () => {
    mockPool.getState.mockResolvedValue(null);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_cooperative_commit")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No off-chain state");
  });

  it("returns error without RPC", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_cooperative_commit")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("performs cooperative commit with valid state", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    mockStorage.get.mockResolvedValue(configPayload);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_cooperative_commit")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.channelAddress).toBe(CHANNEL_ADDR);
  });

  it("performs cooperative commit with withdrawals", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    mockStorage.get.mockResolvedValue(configPayload);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_cooperative_commit")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
      withdrawA: "500",
      withdrawB: "1000",
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.channelAddress).toBe(CHANNEL_ADDR);
  });

  it("calls signCommit and cooperativeCommit on the OnchainChannel instance", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    mockStorage.get.mockResolvedValue(configPayload);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    await handlers.get("pc402_cooperative_commit")!({
      channelAddress: CHANNEL_ADDR,
      serverSignature: Buffer.alloc(64).toString("base64"),
    });
    const instance = vi.mocked(OnchainChannel).mock.results[0].value;
    expect(instance.signCommit).toHaveBeenCalled();
    expect(instance.cooperativeCommit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 11. pc402_start_uncoop_close
// ---------------------------------------------------------------------------
describe("pc402_start_uncoop_close", () => {
  const configPayload = JSON.stringify({
    channelId: "42",
    serverPublicKey: SERVER_PUBKEY,
    serverAddress: SERVER_ADDR,
    initBalanceA: "1000000000",
    initBalanceB: "0",
  });

  it("returns error without off-chain state", async () => {
    mockPool.getState.mockResolvedValue(null);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_start_uncoop_close")!({
      channelAddress: CHANNEL_ADDR,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No off-chain state");
  });

  it("returns error without RPC", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_start_uncoop_close")!({
      channelAddress: CHANNEL_ADDR,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("starts uncoop close with warning when no server semi-sig", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    mockStorage.get.mockImplementation(async (key: string) => {
      if (key.startsWith("pool:config:")) return configPayload;
      return null; // no semi-sig
    });
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_start_uncoop_close")!({
      channelAddress: CHANNEL_ADDR,
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.warning).toContain("counter-signatures");
  });

  it("starts uncoop close without warning when server semi-sig exists", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    mockStorage.get.mockImplementation(async (key: string) => {
      if (key.startsWith("pool:config:")) return configPayload;
      if (key.startsWith("pool:semisig:")) return Buffer.alloc(64, 0xcc).toString("base64");
      return null;
    });
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_start_uncoop_close")!({
      channelAddress: CHANNEL_ADDR,
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. pc402_challenge
// ---------------------------------------------------------------------------
describe("pc402_challenge", () => {
  const configPayload = JSON.stringify({
    channelId: "42",
    serverPublicKey: SERVER_PUBKEY,
    serverAddress: SERVER_ADDR,
    initBalanceA: "1000000000",
    initBalanceB: "0",
  });

  it("returns error without off-chain state", async () => {
    mockPool.getState.mockResolvedValue(null);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_challenge")!({ channelAddress: CHANNEL_ADDR });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No off-chain state");
  });

  it("returns error without RPC", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_challenge")!({ channelAddress: CHANNEL_ADDR });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("challenges with warning when no server semi-sig", async () => {
    mockPool.getState.mockResolvedValue({ balanceA: 900n, balanceB: 100n, seqnoA: 1, seqnoB: 0 });
    mockStorage.get.mockImplementation(async (key: string) => {
      if (key.startsWith("pool:config:")) return configPayload;
      return null;
    });
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_challenge")!({ channelAddress: CHANNEL_ADDR });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.warning).toContain("counter-signatures");
  });
});

// ---------------------------------------------------------------------------
// 13. pc402_finish_uncoop_close
// ---------------------------------------------------------------------------
describe("pc402_finish_uncoop_close", () => {
  const configPayload = JSON.stringify({
    channelId: "42",
    serverPublicKey: SERVER_PUBKEY,
    serverAddress: SERVER_ADDR,
    initBalanceA: "1000000000",
    initBalanceB: "0",
  });

  it("returns error without RPC", async () => {
    handlers = captureHandlers(makeDeps({ withClient: false }));
    const result = await handlers.get("pc402_finish_uncoop_close")!({
      channelAddress: CHANNEL_ADDR,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RPC endpoint not configured");
  });

  it("finishes uncoop close successfully", async () => {
    mockStorage.get.mockResolvedValue(configPayload);
    handlers = captureHandlers(makeDeps({ withClient: true }));
    const result = await handlers.get("pc402_finish_uncoop_close")!({
      channelAddress: CHANNEL_ADDR,
    });
    const data = parseText(result) as any;
    expect(data.success).toBe(true);
    expect(data.channelAddress).toBe(CHANNEL_ADDR);
  });
});

// ---------------------------------------------------------------------------
// 14. pc402_pending_commit
// ---------------------------------------------------------------------------
describe("pc402_pending_commit", () => {
  it("returns pending: false when no commit stored", async () => {
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_pending_commit")!({
      channelAddress: CHANNEL_ADDR,
    });
    const data = parseText(result) as any;
    expect(data.pending).toBe(false);
  });

  it("returns pending: true with signature when commit exists", async () => {
    const sig = "base64sig==";
    mockStorage.get.mockResolvedValue(sig);
    handlers = captureHandlers(makeDeps());
    const result = await handlers.get("pc402_pending_commit")!({
      channelAddress: CHANNEL_ADDR,
    });
    const data = parseText(result) as any;
    expect(data.pending).toBe(true);
    expect(data.signature).toBe(sig);
  });
});

// ---------------------------------------------------------------------------
// Meta: verify all 14 tools are registered
// ---------------------------------------------------------------------------
describe("registerTools", () => {
  it("registers exactly 14 tools", () => {
    handlers = captureHandlers(makeDeps());
    expect(handlers.size).toBe(14);
  });

  it("registers all expected tool names", () => {
    handlers = captureHandlers(makeDeps());
    const expected = [
      "pc402_fetch",
      "pc402_balance",
      "pc402_status",
      "pc402_topup",
      "pc402_init",
      "pc402_wallet",
      "pc402_close",
      "pc402_deploy",
      "pc402_cooperative_close",
      "pc402_cooperative_commit",
      "pc402_start_uncoop_close",
      "pc402_challenge",
      "pc402_finish_uncoop_close",
      "pc402_pending_commit",
    ];
    for (const name of expected) {
      expect(handlers.has(name), `missing tool: ${name}`).toBe(true);
    }
  });
});
