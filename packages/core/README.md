# pc402-core

Off-chain payment channel protocol for TON. Handles Ed25519 state signing, HTTP 402 header encoding/verification, and pluggable state persistence.

No blockchain dependencies at runtime. Only `@ton/core` and `@ton/crypto`.

## Version

v0.2: updated `PC402PaymentRequirements`/`PC402PaymentResponse` shapes, discriminated union response, new helper functions, 5 additional verification checks in `verifyPaymentSignature`, all 7 signature tags exported from a single source.

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
// PC402PaymentRequirements shape (v0.2):
const header = buildPaymentRequired({
  network: "ton:-239",
  amount: "1000000",          // 0.001 TON
  payee: {
    publicKey: serverKeyHex,
    address: "EQ...",
  },
  channel: {                  // optional, omit when no channel exists yet
    address: "EQ...",
    channelId: "1",
    initBalanceA: "100000000",
    initBalanceB: "0",
  },
});

// Verify client payment
const result = verifyPaymentSignature(
  paymentHeader, channel, lastState, price,
);
// result.valid, result.commitSignature?, result.closeSignature?, result.channelExhausted?

if (result.valid) {
  // PC402PaymentResponse is a discriminated union (v0.2):
  // { success: true, counterSignature, network, commitRequest?, closeRequest?, serverPayment? }
  // { success: false, error, errorMessage, network }
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

### Types (v0.2)

| Type | Shape |
|---|---|
| `PC402PaymentRequirements` | `{ payee: { publicKey, address }, channel?: { address, channelId, initBalanceA, initBalanceB }, error?, errorMessage?, ... }` |
| `PC402PaymentResponse` | Discriminated union: `{ success: true, counterSignature, network, commitRequest?, closeRequest?, serverPayment? }` \| `{ success: false, error, errorMessage, network }` |
| `PC402CloseRequest` | `{ seqnoA, seqnoB, sentA, sentB, serverSignature }` |
| `PC402ServerPayment` | `{ state, signature }` |
| `VerifyPaymentResult` | `{ valid, commitSignature?, closeSignature?, channelExhausted? }` |

### HTTP 402 Protocol

| Function | Description |
|---|---|
| `buildPaymentRequired(opts)` | Encode 402 response header (server) |
| `parsePaymentRequired(header)` | Decode 402 header (client) |
| `buildPaymentSignature(opts)` | Encode payment proof header (client) |
| `parsePaymentSignature(header)` | Decode payment proof (server) |
| `verifyPaymentSignature(...)` | Full 13-step verification pipeline (server); checks publicKey match, seqnoB immutability, commitSignature/closeSignature passthrough, channelExhausted |
| `buildPaymentResponse(opts)` | Encode counter-signature + optional commitRequest/closeRequest (server) |
| `parsePaymentResponse(header)` | Decode counter-signature + optional commitRequest/closeRequest (client) |
| `buildPaymentError(opts)` | Build a `{ success: false }` error response |
| `resolveChannelFromPayload(payload)` | Extract channel identity from a payment payload |
| `channelConfigFromRequirements(req)` | Build PaymentChannel config from PC402PaymentRequirements |
| `sentToBalance(init, sent)` | Convert sentCoins back to balance |
| `stateFromCloseRequest(req)` | Reconstruct ChannelState from a PC402CloseRequest |
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

### Signature Tags

All 7 tags are exported from `cell.ts` as the single source of truth:

`TAG_STATE`, `TAG_CLOSE`, `TAG_COMMIT`, `TAG_INIT`, `TAG_START_UNCOOPERATIVE_CLOSE`, `TAG_CHALLENGE_QUARANTINE`, `TAG_SETTLE_CONDITIONALS`

## License

MIT
