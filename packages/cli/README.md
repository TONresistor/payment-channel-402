# pc402-cli

Command-line interface for pc402 payment channels on TON.

## Install

```bash
npm install -g pc402-cli
```

## Usage

```bash
# Fetch a URL with automatic HTTP 402 payment
pc402 fetch https://api.example.com/data --wallet .wallet.json

# Fetch with custom method and body
pc402 fetch https://api.example.com/submit -X POST -d '{"key":"value"}' --wallet .wallet.json

# List all open channels (off-chain state)
pc402 channel list --wallet .wallet.json

# Show off-chain details for a channel
pc402 channel info <address> --wallet .wallet.json

# Read on-chain channel state from blockchain
pc402 channel status <address> --wallet .wallet.json --rpc https://toncenter.com/api/v2/jsonRPC

# Top up a channel with TON
pc402 channel topup <address> <nanotons> --wallet .wallet.json --rpc https://toncenter.com/api/v2/jsonRPC

# Initialize a channel (UNINITED -> OPEN)
pc402 channel init <address> --channel-id <id> --balance-a <nanotons> --balance-b <nanotons> --wallet .wallet.json --rpc https://toncenter.com/api/v2/jsonRPC

# Close a channel (remove from local storage)
pc402 channel close <address> --wallet .wallet.json

# Show wallet address
pc402 wallet address --wallet .wallet.json

# Show wallet balance
pc402 wallet balance --wallet .wallet.json --rpc https://toncenter.com/api/v2/jsonRPC
```

## Configuration

Options can be passed as flags or environment variables:

| Flag | Env var | Description |
|------|---------|-------------|
| `--wallet <path>` | `PC402_WALLET` | Path to wallet JSON file (mnemonic array) |
| `--rpc <url>` | `PC402_RPC_ENDPOINT` | TonCenter RPC endpoint |
| `--rpc-key <key>` | `TONCENTER_API_KEY` | RPC API key |
| `--storage <path>` | `PC402_STORAGE` | Channel state file (default: `./pc402-channels.json`) |

### Wallet file format

```json
{ "mnemonic": ["word1", "word2", "...", "word24"] }
```

Or a plain array:

```json
["word1", "word2", "...", "word24"]
```
