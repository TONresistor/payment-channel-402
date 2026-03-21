# pc402-core

Core cryptographic primitives and HTTP 402 protocol helpers for pc402 payment channels on TON.

No blockchain I/O at runtime. Only `@ton/core` and `@ton/crypto`.

## Install

```bash
npm install pc402-core
```

## Quick example

Server verifying an incoming payment:

```typescript
import {
  PaymentChannel,
  StateManager,
  MemoryStorage,
  verifyPaymentSignature,
  buildPaymentResponse,
  buildPaymentError,
} from "pc402-core";

// One-time setup
const channel = new PaymentChannel({
  channelId: 1n,
  isA: false, // server is party B
  myKeyPair: serverKeyPair,
  hisPublicKey: clientPublicKey,
  initBalanceA: toNano("1"),
  initBalanceB: 0n,
});
const stateManager = new StateManager(new MemoryStorage());

// Per-request handler
async function handleRequest(req: Request): Promise<Response> {
  const header = req.headers.get("PAYMENT-SIGNATURE") ?? "";
  const lastState = await stateManager.getState(clientKey);

  const result = verifyPaymentSignature(
    header, channel, lastState, toNano("0.001"),
    channelAddress, channelId,
  );

  if (!result.valid) {
    return new Response(null, {
      status: 402,
      headers: { "PAYMENT-RESPONSE": buildPaymentError(result.error!, result.errorMessage!) },
    });
  }

  await stateManager.saveState(clientKey, result.state!);
  const counterSig = channel.signState(result.state!);

  return new Response("ok", {
    headers: { "PAYMENT-RESPONSE": buildPaymentResponse({ counterSignature: counterSig }) },
  });
}
```

---

## API Reference

### PaymentChannel

Off-chain signing and verification for one party of a bidirectional v2 TON payment channel.

```typescript
new PaymentChannel(config: ChannelConfig)
```

`config` is frozen on construction and accessible as `channel.config`.

#### signState / verifyState

```typescript
channel.signState(state: ChannelState): Buffer
channel.verifyState(state: ChannelState, signature: Buffer): boolean
```

`signState` builds this party's individual body and signs its hash with `myKeyPair`.
`verifyState` reconstructs the counterparty's body and verifies against `hisPublicKey`.

Body layout: `TAG_STATE(32) + channelId(128) + seqno(64) + sentCoins(Coins) + condHash(256=0)`

#### signClose / verifyClose

```typescript
channel.signClose(state: ChannelState): Buffer
channel.verifyClose(state: ChannelState, signature: Buffer): boolean
```

Both parties sign the same cooperative close body. Both signatures are required for the on-chain `cooperativeClose` message.

Body layout: `TAG_CLOSE(32) + channelId(128) + seqnoA(64) + seqnoB(64) + sentA(Coins) + sentB(Coins)`

#### createPaymentState

```typescript
channel.createPaymentState(currentState: ChannelState, amount: bigint): ChannelState
```

Returns the next state after this party pays `amount` nanotons to the counterparty. Increments the paying party's seqno by 1.

Throws `ValidationError` if amount is not positive, `ChannelError` if amount exceeds the payer's balance.

#### getMyBalance

```typescript
channel.getMyBalance(state: ChannelState): bigint
```

Returns `balanceA` if `isA`, `balanceB` otherwise.

#### signCommit / verifyCommit

```typescript
channel.signCommit(
  seqnoA: bigint, seqnoB: bigint,
  sentA: bigint, sentB: bigint,
  withdrawA?: bigint, withdrawB?: bigint,
): Buffer

channel.verifyCommit(
  seqnoA: bigint, seqnoB: bigint,
  sentA: bigint, sentB: bigint,
  signature: Buffer,
  withdrawA?: bigint, withdrawB?: bigint,
): boolean
```

Used in the commit protocol: client co-signs a `cooperativeCommit` request from the server. Body layout: `TAG_COMMIT(32) + channelId(128) + seqnoA(64) + seqnoB(64) + sentA + sentB + withdrawA + withdrawB`.

---

### Protocol helpers

Framework-agnostic HTTP 402 header encoding, decoding, and verification.

#### buildPaymentRequired

```typescript
buildPaymentRequired(opts: {
  price: bigint;
  serverPublicKey: Buffer;
  serverAddress: string;
  channelAddress?: string;
  channelId?: bigint;
  initBalanceA?: bigint;
  initBalanceB?: bigint;
  asset?: string;       // default "TON"
  network?: string;     // default "ton:-239"
}): string
```

Returns base64 JSON for the `PAYMENT-REQUIRED` header. The `channel` field is included only when `channelAddress` is provided.

#### parsePaymentRequired

```typescript
parsePaymentRequired(header: string): PC402PaymentRequirements | null
```

Returns null if malformed, missing, or not scheme `"pc402"`.

#### buildPaymentSignature

```typescript
buildPaymentSignature(opts: {
  channelAddress: string;
  channelId: string;
  state: ChannelState;
  signature: Buffer;
  publicKey: Buffer;
  initBalanceA?: bigint;
  initBalanceB?: bigint;
  commitSignature?: Buffer;
  closeSignature?: Buffer;
}): string
```

Returns base64 JSON for the `PAYMENT-SIGNATURE` header. Wraps the payload in `{ x402Version: 2, scheme: "pc402" }`.

#### parsePaymentSignature

```typescript
parsePaymentSignature(header: string): { payload: PC402PaymentPayload } | null
```

Validates `x402Version=2` and `scheme="pc402"` before returning.

#### buildPaymentResponse

```typescript
buildPaymentResponse(opts: {
  counterSignature: Buffer;
  network?: string;
  commitRequest?: {
    seqnoA: number; seqnoB: number;
    sentA: bigint; sentB: bigint;
    withdrawA: bigint; withdrawB: bigint;
    serverSignature: Buffer;
  };
  closeRequest?: {
    seqnoA: number; seqnoB: number;
    sentA: bigint; sentB: bigint;
    serverSignature: Buffer;
  };
  serverPayment?: { state: ChannelState; signature: Buffer };
  semiChannelSignature?: Buffer;
}): string
```

Returns base64 JSON for the `PAYMENT-RESPONSE` header on success. Optional fields carry commit/close requests and server-to-client payments.

#### parsePaymentResponse

```typescript
parsePaymentResponse(header: string): PC402PaymentResponse | null
```

#### buildPaymentError

```typescript
buildPaymentError(error: VerifyErrorCode, message: string, network?: string): string
```

Returns base64 JSON for a `PAYMENT-RESPONSE` error header (`success: false`).

#### verifyPaymentSignature

```typescript
verifyPaymentSignature(
  header: string,
  channel: PaymentChannel,
  lastState: ChannelState | null,
  price: bigint,
  expectedChannelAddress: string,
  expectedChannelId: string,
): VerifyPaymentResult
```

All-in-one server-side verification. Runs these checks in order:

1. Parse header — `invalid_payload`
2. Channel identity match — `unknown_channel`
3. Decode binary fields (64-byte sig, 32-byte key) — `invalid_payload`
4. Reconstruct `ChannelState` from wire strings — `invalid_payload`
5. Balance conservation: `balanceA + balanceB == initTotal` — `balance_mismatch`
6. Ed25519 signature — `invalid_signature`
7. Strict seqnoA monotonicity and seqnoB immutability — `stale_seqno`
8. Paid amount >= price — `insufficient_payment`

On success: `{ valid: true, state, paidAmount, channelExhausted? }`.
On failure: `{ valid: false, error, errorMessage }`.

#### encodeHeader / decodeHeader

```typescript
encodeHeader(obj: unknown): string
decodeHeader<T>(header: string): T | null
```

Low-level JSON-to-base64 and base64-to-JSON. `decodeHeader` returns null on any parse failure.

---

### Cell builders

TVM cell construction matching the v2 contract layout. Needed when building on-chain messages.

#### buildSemiChannelBody

```typescript
buildSemiChannelBody(seqno: number, sentCoins: bigint): Cell
```

Raw inner body without tag/channelId. Layout: `seqno(uint64) + sentCoins(Coins) + condHash(256=0)`.

#### buildSemiChannelBodyWithHeader

```typescript
buildSemiChannelBodyWithHeader(
  channelId: bigint,
  seqno: number,
  sentCoins: bigint,
  tag?: number,  // default TAG_STATE
): Cell
```

Full signable body. Layout: `tag(32) + channelId(128) + seqno(64) + sentCoins(Coins) + condHash(256=0)`. This is the cell whose hash `signState` signs.

#### balanceToSentCoins

```typescript
balanceToSentCoins(initBalance: bigint, currentBalance: bigint): bigint
```

Computes `sentCoins = initBalance - currentBalance`. Returns `0n` when the party is a net receiver.

**Signature tag constants:**

| Constant | Value | Purpose |
|---|---|---|
| `TAG_STATE` | `0x50433453` | Per-party state body |
| `TAG_CLOSE` | `0x8243e9a3` | Cooperative close body |
| `TAG_COMMIT` | `0x4a390cac` | Cooperative commit body |
| `TAG_INIT` | `0x481ebc44` | Channel init payload |
| `TAG_START_UNCOOPERATIVE_CLOSE` | `0x8c623692` | Uncooperative close outer payload |
| `TAG_CHALLENGE_QUARANTINE` | `0xb8a21379` | Challenge quarantined state |
| `TAG_SETTLE_CONDITIONALS` | `0x14588aab` | Settle conditionals |

---

### State management

#### StateManager

```typescript
new StateManager(storage: StateStorage)

manager.getState(clientKey: string): Promise<ChannelState | null>
manager.saveState(clientKey: string, state: ChannelState): Promise<void>
manager.removeState(clientKey: string): Promise<void>
manager.getActiveClients(): Promise<string[]>
```

Persists off-chain channel state with any `StateStorage` backend. Bigints are serialized as decimal strings. `clientKey` is typically the client's hex-encoded public key. `getActiveClients` returns all keys that have been saved and not yet removed.

#### FileStorage

```typescript
new FileStorage(filepath: string)
```

Stores all key-value pairs in a single JSON file. Creates parent directories if needed. Suitable for single-process servers.

#### MemoryStorage

```typescript
new MemoryStorage()
```

In-memory `Map`. State is lost on process exit. Suitable for tests and ephemeral processes.

Both implement `StateStorage`. Any backend (Redis, SQLite, etc.) can be used by implementing:

```typescript
interface StateStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

---

### Helpers

#### channelConfigFromRequirements

```typescript
channelConfigFromRequirements(
  requirements: PC402PaymentRequirements,
  myKeyPair: KeyPair,
): { channelConfig: ChannelConfig } | null
```

Builds a `ChannelConfig` for the client side from a parsed `PAYMENT-REQUIRED` header. Returns null when the header is in discovery mode (no `channel` field). Client is always `isA: true`.

#### resolveChannelFromPayload

```typescript
resolveChannelFromPayload(header: string): {
  channelAddress: string;
  channelId: string;
  publicKey: string;
} | null
```

Extracts channel identity from a `PAYMENT-SIGNATURE` header without running full verification. Useful for server-side channel lookup before constructing a `PaymentChannel`.

#### sentToBalance

```typescript
sentToBalance(initBalance: bigint, sent: bigint): bigint
```

Inverse of `balanceToSentCoins`: `balance = initBalance - sent`. Returns `0n` if sent exceeds initBalance.

#### stateFromCloseRequest

```typescript
stateFromCloseRequest(
  closeRequest: PC402CloseRequest,
  initBalanceA: bigint,
  initBalanceB: bigint,
  lastState: ChannelState,
): ChannelState
```

Reconstructs a `ChannelState` from a server close request so the client can call `channel.verifyClose()`.

---

### Error classes

All SDK errors extend `PC402Error` and carry a `code: PC402ErrorCode` field.

| Class | When thrown |
|---|---|
| `PC402Error` | Base class |
| `SignatureError` | Ed25519 signature invalid or verification failed |
| `ChannelError` | Wrong channel state, insufficient balance |
| `ProtocolError` | HTTP 402 header encoding/decoding failure |
| `ValidationError` | Input parameter validation failed |

```typescript
try {
  channel.createPaymentState(state, amount);
} catch (err) {
  if (err instanceof ChannelError) {
    console.log(err.code); // e.g. "INSUFFICIENT_BALANCE"
  }
}
```

`PC402ErrorCode` enum values: `INVALID_SIGNATURE`, `SIGNATURE_VERIFICATION_FAILED`, `CHANNEL_NOT_OPEN`, `INSUFFICIENT_BALANCE`, `SEQNO_REGRESSION`, `INVALID_HEADER`, `MISSING_FIELD`, `PAYMENT_TOO_LOW`, `PAYMENT_STALE`, `IDENTITY_MISMATCH`, `INVALID_AMOUNT`, `INVALID_KEY`, `INVALID_CHANNEL_ID`, `INVALID_BUFFER_LENGTH`.

---

## Types

| Type | Description |
|---|---|
| `ChannelConfig` | Constructor config: `channelId`, `isA`, `myKeyPair`, `hisPublicKey`, `initBalanceA`, `initBalanceB` |
| `ChannelState` | Off-chain state: `balanceA`, `balanceB` (bigint nanotons), `seqnoA`, `seqnoB` (number). Invariant: `balanceA + balanceB == initBalanceA + initBalanceB` |
| `PC402PaymentRequirements` | `PAYMENT-REQUIRED` header payload: price, server identity, optional channel config |
| `PC402PaymentPayload` | Inner payload of `PAYMENT-SIGNATURE`: state, signature (base64), publicKey (hex) |
| `PC402PaymentSignature` | Full `PAYMENT-SIGNATURE` envelope: `{ x402Version: 2, scheme: "pc402", payload }` |
| `PC402PaymentResponse` | Discriminated union: `{ success: true, counterSignature, network, commitRequest?, closeRequest?, serverPayment? }` or `{ success: false, error, errorMessage, network }` |
| `PC402CommitRequest` | Commit co-sign request embedded in `PC402PaymentResponse`: seqnos, sentA/B, withdrawA/B, serverSignature |
| `PC402CloseRequest` | Close co-sign request embedded in `PC402PaymentResponse`: seqnos, sentA/B, serverSignature |
| `PC402ServerPayment` | Server-to-client payment in `PC402PaymentResponse`: signed state from party B |
| `StateStorage` | Pluggable storage interface: `get`, `set`, `delete` |
| `VerifyErrorCode` | `"invalid_signature"` \| `"stale_seqno"` \| `"insufficient_payment"` \| `"balance_mismatch"` \| `"price_exceeds_max"` \| `"unknown_channel"` \| `"invalid_payload"` \| `"channel_exhausted"` |
| `VerifyPaymentResult` | `{ valid, state?, paidAmount?, error?, errorMessage?, commitSignature?, closeSignature?, channelExhausted? }` |
