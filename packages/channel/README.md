# pc402-channel

On-chain TON payment channel lifecycle management for pc402.

## Install

```bash
npm install pc402-channel
```

Peer dependencies: `@ton/core >=0.60.0`, `@ton/crypto >=3.3.0`

## Quick example

```ts
import { OnchainChannel } from "pc402-channel";
import { TonClient } from "@ton/ton";
import { toNano } from "@ton/core";

const client = new TonClient({ endpoint: "https://toncenter.com/api/v2/jsonRPC" });

const channel = new OnchainChannel({
  client,
  myKeyPair: keyPairA,
  counterpartyPublicKey: keyPairB.publicKey,
  isA: true,
  channelId: 1n,
  myAddress: addrA,
  counterpartyAddress: addrB,
  initBalanceA: toNano("1"),
  initBalanceB: toNano("1"),
});

// Party A: deploy and fund in one tx
await channel.deployAndTopUp(senderA, true, toNano("1"));

// Party B: fund their side
await channel.topUp(senderB, false, toNano("1"));

// Either party inits (transitions UNINITED -> OPEN)
await channel.init(senderA, toNano("1"), toNano("1"));

console.log(channel.getAddress().toString());
```

## OnchainChannel API

### Constructor

```ts
new OnchainChannel(options: OnchainChannelOptions)
```

Computes the deterministic contract address from the stateInit. Throws `ValidationError` if `channelId <= 0` or a public key is not 32 bytes.

**OnchainChannelOptions**

| Field | Type | Description |
|---|---|---|
| `client` | `TonClient` | TonClient instance for sending messages and calling get-methods |
| `myKeyPair` | `KeyPair` | Ed25519 key pair of this party |
| `counterpartyPublicKey` | `Buffer` | Ed25519 public key of the counterparty (32 bytes) |
| `isA` | `boolean` | `true` if this party is A, `false` if B |
| `channelId` | `bigint` | Unique channel identifier (uint128, must be positive) |
| `myAddress` | `Address` | TON address of this party |
| `counterpartyAddress` | `Address` | TON address of the counterparty |
| `initBalanceA` | `bigint` | A's initial deposit in nanotons |
| `initBalanceB` | `bigint` | B's initial deposit in nanotons |
| `closingConfig?` | `object` | Optional closing parameters (see below) |

**closingConfig** (all optional, defaults to 0)

| Field | Type | Default | Description |
|---|---|---|---|
| `quarantineDuration` | `number` | `0` | Quarantine window in seconds |
| `misbehaviorFine` | `bigint` | `0n` | Fine deducted from the misbehaving party in nanotons |
| `conditionalCloseDuration` | `number` | `0` | Duration for conditional resolution in seconds |

### Getters

```ts
getAddress(): Address
```
Returns the deterministic contract address derived from the stateInit.

```ts
getChannelId(): bigint
```
Returns the uint128 channel identifier.

```ts
getIsA(): boolean
```
Returns `true` if this instance represents party A.

### Deploy

```ts
async deployAndTopUp(via: Sender, isA: boolean, amount: bigint): Promise<void>
```
Deploys the contract and funds it in a single transaction. Sends `amount + GAS_DEPLOY` (0.02 TON). The other party calls `topUp()` separately. Throws `ValidationError` if `amount <= 0`.

```ts
async topUp(via: Sender, isA: boolean, amount: bigint): Promise<void>
```
Tops up an already-deployed channel. The contract validates that the sender matches `addrA` (if `isA=true`) or `addrB` (if `isA=false`). Throws `ValidationError` if `amount <= 0`.

### Init

```ts
signInit(balanceA: bigint, balanceB: bigint, keyPair: KeyPair): Buffer
```
Signs `tag_init(32) + channelId(128) + balanceA(Coins) + balanceB(Coins)`. Returns a 64-byte Ed25519 signature.

```ts
async init(via: Sender, balanceA: bigint, balanceB: bigint): Promise<void>
```
Transitions the channel from UNINITED to OPEN. Signs with `myKeyPair`. Only one party's signature is required by the contract.

### Cooperative close

```ts
signClose(
  seqnoA: bigint,
  seqnoB: bigint,
  sentA: bigint,
  sentB: bigint,
  keyPair: KeyPair,
): Buffer
```
Signs `tag_close(32) + channelId(128) + seqnoA(64) + seqnoB(64) + sentA(Coins) + sentB(Coins)`. Returns a 64-byte Ed25519 signature. Throws `ValidationError` if `sentA < 0` or `sentB < 0`.

```ts
async cooperativeClose(
  via: Sender,
  seqnoA: bigint,
  seqnoB: bigint,
  sentA: bigint,
  sentB: bigint,
  signatureA: Buffer,
  signatureB: Buffer,
): Promise<void>
```
Closes the channel with both signatures. The contract verifies both, distributes funds, and destroys itself.

### Cooperative commit

```ts
signCommit(
  seqnoA: bigint,
  seqnoB: bigint,
  sentA: bigint,
  sentB: bigint,
  keyPair: KeyPair,
  withdrawA?: bigint,  // default 0n
  withdrawB?: bigint,  // default 0n
): Buffer
```
Signs the commit payload. Returns a 64-byte Ed25519 signature.

```ts
async cooperativeCommit(
  via: Sender,
  seqnoA: bigint,
  seqnoB: bigint,
  sentA: bigint,
  sentB: bigint,
  signatureA: Buffer,
  signatureB: Buffer,
  withdrawA?: bigint,  // default 0n
  withdrawB?: bigint,  // default 0n
): Promise<void>
```
Advances committed seqnos on-chain without closing. Allows both parties to safely discard older states. Can trigger partial withdrawals when `withdrawA` or `withdrawB` is non-zero.

### Uncooperative close

```ts
signStartUncoopClose(schA: Cell, schB: Cell, keyPair: KeyPair): Buffer
```
Signs `tag(32) + channelId(128) + schA(ref) + schB(ref)`. Returns a 64-byte Ed25519 signature.

```ts
async startUncooperativeClose(
  via: Sender,
  signedByA: boolean,
  signatureMsg: Buffer,
  schA: Cell,
  schB: Cell,
): Promise<void>
```
Submits the latest known state on-chain and begins the quarantine period. The counterparty may challenge with a newer state during this window.

```ts
signChallenge(schA: Cell, schB: Cell, keyPair: KeyPair): Buffer
```
Signs `tag(32) + channelId(128) + schA(ref) + schB(ref)` for a challenge. Returns a 64-byte Ed25519 signature.

```ts
async challengeQuarantinedState(
  via: Sender,
  challengedByA: boolean,
  signatureMsg: Buffer,
  schA: Cell,
  schB: Cell,
): Promise<void>
```
Challenges a quarantined state with a newer one. Must be called during the quarantine period. If the challenger's seqnos are strictly higher, the contract replaces the quarantined state and optionally penalizes the misbehaving party.

```ts
signSettle(conditionalsCell: Cell, keyPair: KeyPair): Buffer
```
Signs `tag(32) + channelId(128) + conditionalsCell(ref)`. Returns a 64-byte Ed25519 signature.

```ts
async settleConditionals(
  via: Sender,
  isFromA: boolean,
  signature: Buffer,
  conditionalsCell: Cell,
): Promise<void>
```
Resolves pending conditional payments during the conditional close period after uncooperative close.

```ts
async finishUncooperativeClose(via: Sender): Promise<void>
```
Finalizes uncooperative close after quarantine and conditional close periods have both expired. Can be sent by anyone. Distributes remaining funds and destroys the contract.

### State

```ts
async getOnchainState(): Promise<{
  state: number;       // 0=uninited, 1=open, 2=quarantine
  balanceA: bigint;    // A's current available balance in nanotons
  balanceB: bigint;    // B's current available balance in nanotons
  channelId: bigint;   // uint128 channel identifier
  seqnoA: number;      // A's last committed sequence number
  seqnoB: number;      // B's last committed sequence number
  withdrawnA: bigint;  // total already withdrawn by A in nanotons
  withdrawnB: bigint;  // total already withdrawn by B in nanotons
}>
```
Calls `get_channel_data` on the contract and parses the result.

## Exported functions

```ts
function buildSignedSemiChannel(
  channelId: bigint,
  seqno: bigint,
  sentCoins: bigint,
  keyPair: KeyPair,
): Cell
```
Builds a `SignedSemiChannel` cell (v2 layout) for use with `startUncooperativeClose` and `challengeQuarantinedState`. The cell contains a 512-bit Ed25519 signature and a ref to the body cell (`tag_state + channelId + seqno + sentCoins + conditionalsHash`).

```ts
function createChannelStateInit(config: ChannelInitConfig): StateInit
```
Builds the `StateInit` (code + data cell) for a new channel contract. Used internally by `OnchainChannel` to derive the deterministic contract address.

**ChannelInitConfig**

| Field | Type | Default | Description |
|---|---|---|---|
| `publicKeyA` | `Buffer` | required | A's Ed25519 public key (32 bytes) |
| `publicKeyB` | `Buffer` | required | B's Ed25519 public key (32 bytes) |
| `channelId` | `bigint` | required | Unique channel identifier (uint128) |
| `addressA` | `Address` | required | A's TON address |
| `addressB` | `Address` | required | B's TON address |
| `quarantineDuration` | `number` | `259200` (3 days) | Quarantine window in seconds |
| `misbehaviorFine` | `bigint` | `0n` | Fine in nanotons |
| `conditionalCloseDuration` | `number` | `86400` (1 day) | Conditional close window in seconds |
| `storageFee` | `bigint` | `10000000n` (0.01 TON) | Storage fee reserved in nanotons |

## Exported constants

### OP codes

| Constant | Value |
|---|---|
| `OP_TOP_UP` | `0x593e3893` |
| `OP_INIT_CHANNEL` | `0x79ae99b5` |
| `OP_COOPERATIVE_CLOSE` | `0xd2b1eeeb` |
| `OP_COOPERATIVE_COMMIT` | `0x076bfdf1` |
| `OP_START_UNCOOPERATIVE_CLOSE` | `0x8175e15d` |
| `OP_CHALLENGE_QUARANTINE` | `0x9a77c0db` |
| `OP_SETTLE_CONDITIONALS` | `0x56c39b4c` |
| `OP_FINISH_UNCOOPERATIVE_CLOSE` | `0x25432a91` |

### TAG constants

| Constant | Description |
|---|---|
| `TAG_STATE` | Domain tag for semi-channel state signing |
| `TAG_INIT` | Domain tag for channel init signing |
| `TAG_COOPERATIVE_CLOSE` | Domain tag for cooperative close signing |
| `TAG_COOPERATIVE_COMMIT` | Domain tag for cooperative commit signing |
| `TAG_START_UNCOOPERATIVE_CLOSE` | Domain tag for start uncoop close signing |
| `TAG_CHALLENGE_QUARANTINE` | Domain tag for challenge signing |
| `TAG_SETTLE_CONDITIONALS` | Domain tag for settle conditionals signing |

### Contract bytecode

```ts
PAYMENT_CHANNEL_CODE: Cell  // compiled pc402 Tolk contract v2
```
