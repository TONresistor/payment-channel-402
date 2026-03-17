# pc402-core

Off-chain payment channel protocol for TON. Handles Ed25519 state signing, HTTP 402 header encoding/verification, and pluggable state persistence.

No blockchain dependencies at runtime — only `@ton/core` and `@ton/crypto`.

## Install

```bash
npm install pc402-core
```

## Usage

### Off-chain payments

```typescript
import { PaymentChannel } from "pc402-core";
import type { ChannelState } from "pc402-core";

const pc = new PaymentChannel({
  channelId: 1n,
  isA: true,
  myKeyPair: keyPairA,
  hisPublicKey: keyPairB.publicKey,
  initBalanceA: toNano("1"),
  initBalanceB: 0n,
});

let state: ChannelState = {
  balanceA: toNano("1"), balanceB: 0n, seqnoA: 0, seqnoB: 0,
};

// Pay 0.01 TON to counterparty
state = pc.createPaymentState(state, toNano("0.01"));
const sig = pc.signState(state);

// Counterparty verifies
const valid = pcB.verifyState(state, sig); // true
```

### HTTP 402 server

```typescript
import {
  buildPaymentRequired,
  verifyPaymentSignature,
  buildPaymentResponse,
} from "pc402-core";

// Respond with 402
const header = buildPaymentRequired({
  network: "ton:-239",
  amount: "1000000",          // 0.001 TON
  channelAddress: "EQ...",
  channelId: "1",
  publicKeyB: serverKeyHex,
  initBalanceA: "100000000",
  initBalanceB: "0",
});

// Verify client payment
const result = verifyPaymentSignature(
  paymentHeader, channel, lastState, price, channelAddress, channelId,
);
if (result.valid) {
  const response = buildPaymentResponse({ ... });
}
```

## API

### PaymentChannel

| Method | Description |
|---|---|
| `createPaymentState(state, amount)` | Create next state after a payment (increments seqno) |
| `signState(state)` | Sign this party's state body (Ed25519) |
| `verifyState(state, sig)` | Verify counterparty's state signature |
| `signClose(state)` | Sign cooperative close body (same for both parties) |
| `verifyClose(state, sig)` | Verify counterparty's close signature |
| `signCommit(seqnoA, seqnoB, sentA, sentB, wA?, wB?)` | Sign a cooperative commit payload |
| `verifyCommit(seqnoA, seqnoB, sentA, sentB, sig, wA?, wB?)` | Verify counterparty's commit signature |
| `getMyBalance(state)` | Get this party's balance from a state |

### HTTP 402 Protocol

| Function | Description |
|---|---|
| `buildPaymentRequired(opts)` | Encode 402 response header (server) |
| `parsePaymentRequired(header)` | Decode 402 header (client) |
| `buildPaymentSignature(opts)` | Encode payment proof header (client) |
| `parsePaymentSignature(header)` | Decode payment proof (server) |
| `verifyPaymentSignature(...)` | Full 8-step verification pipeline (server) |
| `buildPaymentResponse(opts)` | Encode counter-signature + optional commitRequest (server) |
| `parsePaymentResponse(header)` | Decode counter-signature + optional commitRequest (client) |
| `encodeHeader(obj)` / `decodeHeader(str)` | Raw base64 JSON encoding |

### State Persistence

| Class | Description |
|---|---|
| `StateManager` | Manages per-client state with active tracking |
| `MemoryStorage` | In-memory `Map` backend |
| `FileStorage` | JSON file backend |

### Errors

| Class | When |
|---|---|
| `PC402Error` | Base class for all SDK errors |
| `ValidationError` | Invalid input (negative amount, wrong key length) |
| `ChannelError` | Channel logic failure (insufficient balance) |
| `SignatureError` | Signature creation or verification failure |
| `ProtocolError` | HTTP 402 header encoding/decoding failure |

All errors have a `code: PC402ErrorCode` field for programmatic handling.

### Cell Helpers

| Function | Description |
|---|---|
| `buildSemiChannelBody(seqno, sent)` | Build seqno + sent + condHash cell |
| `buildSemiChannelBodyWithHeader(chId, seqno, sent)` | Build full body with tag + channelId |
| `balanceToSentCoins(init, current)` | Compute sentCoins from balance change |

## License

MIT
