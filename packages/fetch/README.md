# pc402-fetch

HTTP client that automatically handles HTTP 402 Payment Required using TON payment channels.

## Install

```bash
npm install pc402-fetch
```

Peer dependencies: `@ton/core >=0.60.0`, `@ton/crypto >=3.3.0`

## Quick example

```ts
import { mnemonicToPrivateKey } from "@ton/crypto";
import { createPC402Fetch, FileStorage } from "pc402-fetch";

const keyPair = await mnemonicToPrivateKey(process.env.MNEMONIC!.split(" "));
const fetch402 = createPC402Fetch({
  keyPair,
  storage: new FileStorage("./channels.json"),
});

const res = await fetch402("https://api.example.com/data");
console.log(await res.json());
```

Non-402 responses are returned as-is. Payment is transparent to the caller.

## How it works

1. **Request** — `fetch402` sends the original request.
2. **402** — Server returns `402 Payment Required` with a `PAYMENT-REQUIRED` header describing the price and channel info.
3. **Sign** — The client increments the off-chain state by the requested amount and signs it with its Ed25519 key.
4. **Retry** — The signed state is attached as a `PAYMENT-SIGNATURE` header and the request is retried.
5. **200** — Server verifies the signature, serves the response, and returns a `PAYMENT-RESPONSE` header with its counter-signature and optional cooperative commit/close requests.
6. **Persist** — The updated channel state, counter-signature, and any commit co-signatures are saved to storage.

No on-chain transaction happens per request. The channel is topped up and initialized once; payments flow off-chain until the channel is cooperatively closed or one party disputes.

## API reference

### `createPC402Fetch(options)`

```ts
function createPC402Fetch(options: PC402FetchOptions): PC402Fetch

interface PC402FetchOptions {
  keyPair: KeyPair;        // Ed25519 key pair from @ton/crypto
  storage?: StateStorage;  // default: MemoryStorage
}

type PC402Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
```

Returns a function with the same signature as the native `fetch`. All 402 negotiation is handled internally. The client is always party A (payer).

---

### `ChannelPool`

Manages open payment channels, one per server channel address. Persists configs and off-chain state through a `StateStorage` backend. Used internally by `createPC402Fetch`; exposed for advanced use cases such as inspecting or closing channels from outside the fetch loop.

```ts
constructor(keyPair: KeyPair, storage?: StateStorage)
```

#### Methods

```ts
getOrCreate(requirements: PC402PaymentRequirements): Promise<ChannelEntry>
```
Returns an existing channel from storage or creates a new one from the 402 payment requirements. `ChannelEntry` contains `{ paymentChannel: PaymentChannel, state: ChannelState }`.

```ts
saveState(channelAddress: string, state: ChannelState): Promise<void>
getState(channelAddress: string): Promise<ChannelState | null>
```
Persist or retrieve the current off-chain state for a channel.

```ts
listChannels(): Promise<string[]>
```
Returns all known channel addresses.

```ts
closeChannel(channelAddress: string): Promise<void>
```
Removes a channel and all associated data from storage (config, state, signatures). Does not send any on-chain transaction.

```ts
savePendingCommit(channelAddress: string, commitSignature: Buffer): Promise<void>
popPendingCommit(channelAddress: string): Promise<Buffer | null>
```
Store and retrieve-then-delete the client's co-signature for a cooperative commit. The pending commit is attached to the next outgoing payment header automatically by `createPC402Fetch`.

```ts
saveCounterSignature(channelAddress: string, signature: string): Promise<void>
getCounterSignature(channelAddress: string): Promise<string | null>
```
Store the server's counter-signature (base64) received from `PAYMENT-RESPONSE`.

```ts
saveCloseRequest(channelAddress: string, closeRequest: object): Promise<void>
getCloseRequest(channelAddress: string): Promise<object | null>
```
Store the server's cooperative close request received from `PAYMENT-RESPONSE`.

```ts
saveSemiChannelSignature(channelAddress: string, signature: string): Promise<void>
getSemiChannelSignature(channelAddress: string): Promise<string | null>
```
Store the server's semi-channel signature received from `PAYMENT-RESPONSE`. Used by the client to prove the server's last known state in an uncooperative close.

---

### On-chain helpers

Lightweight helpers for managing channel lifecycle on-chain. These operate on a known channel address without needing the full `OnchainChannel` constructor.

```ts
createSender(client: TonClient, keyPair: KeyPair): { sender: Sender; address: Address }
```
Creates a `WalletContractV4` sender from a key pair. Used internally by the other helpers.

```ts
topUpChannel(
  client: TonClient,
  keyPair: KeyPair,
  channelAddress: string,
  amount: bigint,            // nanotons
): Promise<void>
```
Sends TON to the contract (`OP_TOP_UP`). The contract validates that the sender matches party A's address. Sends `amount + 0.008 TON` (gas included).

```ts
initChannel(
  client: TonClient,
  keyPair: KeyPair,
  channelAddress: string,
  channelId: bigint,
  balanceA: bigint,          // nanotons
  balanceB: bigint,          // nanotons
): Promise<void>
```
Transitions the channel from `UNINITED` to `OPEN` (`OP_INIT_CHANNEL`). The client signs as party A; only one signature is required to open.

```ts
getOnchainState(client: TonClient, channelAddress: string): Promise<OnchainState>

interface OnchainState {
  state: number;       // 0=uninited, 1=open, 2=quarantine
  balanceA: bigint;
  balanceB: bigint;
  channelId: bigint;
  seqnoA: number;
  seqnoB: number;
  withdrawnA: bigint;
  withdrawnB: bigint;
}
```
Reads on-chain channel state via the `get_channel_data` get-method.

```ts
getWalletAddress(keyPair: KeyPair): Address
```
Returns the `WalletContractV4` address for a key pair (workchain 0).

```ts
getWalletBalance(client: TonClient, keyPair: KeyPair): Promise<bigint>
```
Returns the wallet's TON balance in nanotons.

---

## Storage

All channel data is persisted through the `StateStorage` interface from `pc402-core`:

```ts
interface StateStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Two implementations are provided:

**`MemoryStorage`** — in-memory, no persistence. Default when no `storage` option is passed. Suitable for testing and short-lived processes.

```ts
import { MemoryStorage } from "pc402-core";
const storage = new MemoryStorage();
```

**`FileStorage`** — stores all key-value pairs in a single JSON file. Suitable for single-process clients that need state to survive restarts.

```ts
import { FileStorage } from "pc402-core";
const storage = new FileStorage("./pc402-channels.json");
```

Any custom backend (Redis, SQLite, etc.) can be used by implementing the three-method `StateStorage` interface.
