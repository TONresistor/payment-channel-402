# pc402-mcp

MCP server exposing pc402 payment channels as tools for AI agents (Claude, GPT, Cursor, etc.).

Runs over stdio transport (JSON-RPC), following the [Model Context Protocol](https://modelcontextprotocol.io) specification.

## Install

```bash
npm install -g pc402-mcp
```

## Usage

```bash
pc402-mcp --wallet .wallet.json --rpc https://toncenter.com/api/v2/jsonRPC
```

### Claude Desktop

Add to `claude_desktop_config.json`:

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

### Claude Code

Add to `.claude/settings.json`:

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

## Tools

| Tool | Description |
|------|-------------|
| `pc402_fetch` | Fetch a URL with automatic HTTP 402 payment |
| `pc402_balance` | Show off-chain channel balances |
| `pc402_status` | Read on-chain channel state (requires `--rpc`) |
| `pc402_topup` | Top up a channel with TON (requires `--rpc`) |
| `pc402_init` | Initialize a channel: UNINITED -> OPEN (requires `--rpc`) |
| `pc402_wallet` | Show wallet address and balance |
| `pc402_close` | Remove a channel from local storage |

## Configuration

Options can be passed as flags or environment variables:

| Flag | Env var | Description |
|------|---------|-------------|
| `--wallet <path>` | `PC402_WALLET` | Path to wallet JSON file (mnemonic array) |
| `--rpc <url>` | `PC402_RPC_ENDPOINT` | TonCenter RPC endpoint |
| `--rpc-key <key>` | `TONCENTER_API_KEY` | RPC API key |
| `--storage <path>` | `PC402_STORAGE` | Channel state file (default: `./pc402-channels.json`) |
