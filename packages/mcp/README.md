# pc402-mcp

MCP server exposing pc402 payment channels as tools for AI agents (Claude, GPT, Cursor, etc.).

Runs over stdio transport (JSON-RPC), following the [Model Context Protocol](https://modelcontextprotocol.io) specification.

## Install

```bash
npm install -g pc402-mcp
```

## Setup

### Claude Code

```bash
claude mcp add pc402 -- pc402-mcp --wallet /path/to/.wallet.json --rpc https://toncenter.com/api/v2/jsonRPC
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pc402": {
      "command": "pc402-mcp",
      "args": ["--wallet", "/path/to/.wallet.json", "--rpc", "https://toncenter.com/api/v2/jsonRPC"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json` (same format as above).

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "pc402": {
      "type": "stdio",
      "command": "pc402-mcp",
      "args": ["--wallet", "/path/to/.wallet.json", "--rpc", "https://toncenter.com/api/v2/jsonRPC"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `pc402_fetch` | Fetch a URL with automatic 402 payment |
| `pc402_balance` | Show off-chain channel balances |
| `pc402_wallet` | Show wallet address and balance |
| `pc402_status` | Read on-chain channel state |
| `pc402_deploy` | Deploy a new channel |
| `pc402_init` | Initialize a channel (UNINITED -> OPEN) |
| `pc402_topup` | Top up a channel with TON |
| `pc402_cooperative_close` | Settle and close a channel |
| `pc402_cooperative_commit` | Partial withdrawal without closing |
| `pc402_start_uncoop_close` | Start dispute (server offline) |
| `pc402_challenge` | Challenge a stale quarantined state |
| `pc402_finish_uncoop_close` | Finalize after quarantine |
| `pc402_pending_commit` | Check pending commit signature |
| `pc402_close` | Remove channel from local storage |

## Configuration

Options can be passed as flags or environment variables:

| Flag | Env var | Description |
|------|---------|-------------|
| `--wallet <path>` | `PC402_WALLET` | Path to wallet JSON file (mnemonic array) |
| `--rpc <url>` | `PC402_RPC_ENDPOINT` | TonCenter RPC endpoint |
| `--rpc-key <key>` | `TONCENTER_API_KEY` | RPC API key |
| `--storage <path>` | `PC402_STORAGE` | Channel state file (default: `./pc402-channels.json`) |
