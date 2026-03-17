<p align="center">
  <img src="banner.png" alt="Payment Channel 402" />
</p>

# Payment Channel 402

TypeScript SDK for off-chain micropayments on TON via payment channels and HTTP 402.

Open a channel on-chain, exchange unlimited signed payments off-chain, close on-chain. Three transactions total, zero gas per payment. Tested E2E on TON mainnet.

## Install

```bash
npm install pc402-core pc402-channel
```

Peer dependencies: `@ton/core`, `@ton/crypto`, `@ton/ton`.

## Flow

### 1. Discovery (HTTP 402)

Client requests a paid resource. Server responds `402` with channel info and price.

```typescript
// Server
const header = buildPaymentRequired({
  network: "ton:-239",
  amount: "1000000",
  channelAddress: "EQ...",
  channelId: "1",
  publicKeyB: serverPublicKeyHex,
  initBalanceA: "100000000",
  initBalanceB: "0",
});
res.status(402).set("PAYMENT-REQUIRED", header).end();

// Client
const req = parsePaymentRequired(header);
```

### 2. Open Channel

Client deploys a payment channel using the info from step 1. Two on-chain transactions.

```typescript
const channel = new OnchainChannel({ client, keyPairA, keyPairB, channelId, addressA, addressB, ... });
await channel.deployAndTopUp(senderA, true, toNano("1"));
await channel.init(senderA, toNano("1"), 0n, keyPairA);
```

### 3. Pay (off-chain)

Client pays per-request by signing state updates. Server verifies instantly. Zero gas, sub-millisecond.

```typescript
// Client
state = pc.createPaymentState(state, BigInt(req.amount));
const sig = pc.signState(state);
const paymentHeader = buildPaymentSignature({ state, signature: sig, ... });
fetch(url, { headers: { "PAYMENT-SIGNATURE": paymentHeader } });

// Server
const result = verifyPaymentSignature(paymentHeader, channel, lastState, price, ...);
if (result.valid) {
  const responseHeader = buildPaymentResponse({ counterSignature, ... });
}
```

Repeat per request. Bidirectional. Unlimited.

### 4. Commit (optional)

Server withdraws accumulated funds while the channel stays open. Co-signature exchanged over HTTP via `commitRequest` in `PAYMENT-RESPONSE` and `commitSignature` in the next `PAYMENT-SIGNATURE`.

```typescript
// Server: include commit request in response
const serverSig = serverChannel.signCommit(1n, 1n, sentA, sentB, 0n, withdrawB);
buildPaymentResponse({ counterSignature, commitRequest: { seqnoA: 1, seqnoB: 1, sentA, sentB, withdrawA: 0n, withdrawB, serverSignature: serverSig } });

// Client: verify, co-sign, include in next payment
const clientSig = clientChannel.signCommit(1n, 1n, sentA, sentB, 0n, withdrawB);

// Server: broadcast on-chain
await channel.cooperativeCommit(sender, 1n, 1n, sentA, sentB, clientSig, serverSig, 0n, withdrawB);
```

### 5. Close

Both parties sign the final state. One on-chain transaction distributes all funds. Channel returns to UNINITED (reopenable).

```typescript
const sentA = balanceToSentCoins(initBalanceA, state.balanceA);
const sentB = balanceToSentCoins(initBalanceB, state.balanceB);
const sigA = channel.signClose(sentA, sentB, keyPairA);
const sigB = channel.signClose(sentA, sentB, keyPairB);
await channel.cooperativeClose(senderA, sentA, sentB, sigA, sigB);
```

### 6. Dispute

If the counterparty is unresponsive, force-close via quarantine. The counterparty can challenge with a newer state during the quarantine period.

```typescript
const schA = buildSignedSemiChannel(channelId, seqnoA, sentA, keyPairA);
const schB = buildSignedSemiChannel(channelId, seqnoB, sentB, keyPairB);
const sig = channel.signStartUncoopClose(schA, schB, keyPairA);
await channel.startUncooperativeClose(senderA, true, sig, schA, schB);
// Wait quarantine + close period...
await channel.finishUncooperativeClose(senderA);
```

## Structure

| Path                | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `packages/core/`    | `pc402-core`  off-chain signing, HTTP 402, state management |
| `packages/channel/` | `pc402-channel`  on-chain lifecycle, dispute resolution |
| `contracts/src/`    | Payment channel smart contract (Tolk v2, 7 files)            |
| `contracts/test/`   | 30 sandbox tests                                             |
| `test/e2e/`         | 3 E2E mainnet test suites                                    |

## Smart Contract

The payment channel contract is written in [Tolk](https://docs.ton.org/develop/tolk/overview) and included in `contracts/src/`. Compiled bytecode is embedded in `pc402-channel`.

### Balance Model

Each party has 3 tracked values on-chain: `deposit`, `withdrawn`, `sent`. The effective balance is computed:

| Party | Effective balance |
|---|---|
| A | `depositA + sentB - sentA - withdrawnA` |
| B | `depositB + sentA - sentB - withdrawnB` |

Off-chain payments increment `sent`. Partial withdrawals increment `withdrawn`. At close, the effective balances determine the final payout.

### Channel States

| State | Transition |
|---|---|
| `UNINITED` (0) | deploy + topUp + init → `OPEN` |
| `OPEN` (1) | cooperativeClose → `UNINITED` (funds distributed, reopenable) |
| `OPEN` (1) | startUncooperativeClose → `CLOSURE_STARTED` |
| `CLOSURE_STARTED` (2) | challengeQuarantinedState → resets quarantine timer |
| `CLOSURE_STARTED` (2) | quarantine expires → `SETTLING_CONDITIONALS` |
| `SETTLING_CONDITIONALS` (3) | close period expires → `AWAITING_FINALIZATION` |
| `AWAITING_FINALIZATION` (4) | finishUncooperativeClose → `UNINITED` |

### Operations

| Operation | Opcode | Signatures | Gas |
|---|---|---|---|
| topUp | `0x593e3893` | none (sender address verified) | 0.004 TON |
| initChannel | `0x79ae99b5` | 1 (A or B) | 0.004 TON |
| cooperativeClose | `0xd2b1eeeb` | 2 (A + B) | 0.006 TON |
| cooperativeCommit | `0x076bfdf1` | 2 (A + B) | 0.005 TON |
| startUncooperativeClose | `0x8175e15d` | 1 outer + 2 inner | 0.005 TON |
| challengeQuarantinedState | `0x9a77c0db` | 1 outer + 2 inner | 0.005 TON |
| settleConditionals | `0x56c39b4c` | 1 + Merkle proof | 0.005 TON |
| finishUncooperativeClose | `0x25432a91` | none (anyone can call) | 0.005 TON |

Surplus gas is refunded via `reserveToncoinsOnBalance` + `sendExcess`.

### Dust Limit

If a party's final payout is below 0.001 TON, the amount is redirected to the counterparty instead of sending a message that would fail silently. This prevents fund loss from messages too small to cover forward fees.

### Contract Source

| File | Role |
|---|---|
| `payment-channel.tolk` | Entry points, router, all 8 handlers, GET methods |
| `storage.tolk` | 6-field balance, calcA/calcB, tiered load/save |
| `messages.tolk` | Opcodes, signature tags, state constants |
| `errors.tolk` | Error codes by operation (100-179) |
| `fees.tolk` | DUST_LIMIT constant |
| `utils.tolk` | TVM continuation helper |
| `schema.tlb` | TL-B schema (reference) |

## Testing

```bash
npm test                                          # 107 unit + sandbox tests
npm run lint                                      # biome + tsc
cd contracts && npx vitest run                    # 30 contract tests

# E2E mainnet (requires funded wallets + .env)
npx vitest run -c test/e2e/vitest.config.ts
```

## Why

Existing solutions pay on-chain per request ([x402](https://github.com/coinbase/x402)) or require trusted hardware ([A402](https://arxiv.org/abs/2503.18732)). Neither works for high-frequency machine-to-machine payments: gas costs eliminate micropayments, block confirmation adds seconds of latency, and hardware dependencies exclude IoT devices.

pc402 locks funds once in a payment channel, then exchanges Ed25519 signatures off-chain. Zero gas per payment. Sub-millisecond verification. Runs on anything from a cloud server to an ESP32 over LoRa. The blockchain is only touched at open and close.

**Use cases:** AI agents paying for API calls without API keys. IoT sensors selling data over LoRa mesh networks without internet. APIs monetized per-request without Stripe. Content paid per-paragraph instead of per-subscription. Vehicles streaming payments for tolls, parking, and charging.

See [docs/technical-overview.md](technical.md) for the full technical analysis.

## License

MIT
