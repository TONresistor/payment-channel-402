# pc402: Technical Overview

Payment channels + HTTP 402 for off-chain micropayments on TON.

## 1. Problem

HTTP 402 ("Payment Required") has existed since 1997 but was never implemented. Machine-to-machine payments are now real: AI agents calling APIs, IoT devices trading data, autonomous services paying each other.

### x402 (Coinbase)

[x402](https://github.com/coinbase/x402) was the first serious attempt. It attaches an on-chain payment to every HTTP request.

| Issue | Impact |
|---|---|
| Gas cost per payment | Micropayments below gas cost are impossible |
| ~5s latency per payment | Unusable for high-frequency workloads |
| Facilitator required | Reintroduces a trusted third party |

AI agents making 1000+ API calls/min cannot wait 5s and pay gas on each one. IoT devices on LoRa have no persistent internet. Micropayments below gas cost are economically impossible.

### A402 (academic paper)

[A402](https://arxiv.org/abs/2503.18732) (March 2026) independently reached the same conclusion: on-chain-per-payment does not scale. Their solution uses payment channels (same core idea as TON Payment Channels) but requires TEE (Intel SGX, like Cocoon). This limits deployment to specific server hardware and excludes IoT/edge devices.

## 2. Solution

Two primitives:

**Payment channels.** Lock funds once on-chain. Exchange unlimited signed state updates off-chain. Settle once on-chain. 3 transactions total regardless of payment count.

**HTTP 402 as transport.** Server returns 402 with a price. Client pays by signing a state update. Server verifies instantly. No blockchain interaction during payments.

No Facilitator. No TEE. No routing network. No token approvals during payments. The only cryptographic primitive is Ed25519

| Phase | Transactions | Cost |
|---|---|---|
| Channel open (deploy + init) | 2 | ~0.01 TON |
| Off-chain payments (unlimited) | 0 | 0 TON |
| Channel close | 1 | ~0.005 TON |
| **Total lifecycle** | **3** | **~0.015 TON** |

## 3. Protocol

6 phases. Phases 1-3 are the normal payment flow. Phase 4 (commit) allows partial withdrawal without closing. Phases 5-6 handle closure.

### Phase 1: Discovery

Client sends a normal HTTP request. Server responds 402 with payment terms:

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64 JSON: scheme, amount, channelAddress, channelId, publicKeyB>
```

### Phase 2: Channel Open

If no channel exists, the client deploys one:

1. Generate `channelId`, build `stateInit` from both parties' public keys
2. Deploy + deposit (e.g. 1 TON)
3. Send `init` to activate

Two on-chain transactions. No further on-chain interaction needed for payments.

### Phase 3: Payment (off-chain)

For every paid HTTP request:

1. Client increments `seqno`, adjusts balance, signs: `TAG_STATE + channelId + seqno + sentCoins + condHash`
2. Client sends request with signature + state in `PAYMENT-SIGNATURE` header
3. Server verifies Ed25519 signature (<1ms), checks seqno is strictly greater than last seen, checks balance validity
4. Server responds with data + counter-signature in `PAYMENT-RESPONSE` header

Cost: 0 gas. Latency: <1ms. Payload: ~200 bytes.

### Phase 4: Commit (partial withdrawal)

Novel to pc402. The server withdraws earned funds without closing the channel.

1. Server includes `commitRequest` in `PAYMENT-RESPONSE` (contains seqnos, sent values, withdraw amounts, server's commit signature)
2. Client verifies the request, includes `commitSignature` in the next `PAYMENT-SIGNATURE`
3. Server broadcasts one on-chain transaction with both signatures. Contract verifies, releases funds to server.

Channel stays open. Client keeps paying.

### Phase 5: Cooperative Close

Both parties sign: `TAG_CLOSE + channelId + sentA + sentB`. Either party broadcasts. Contract distributes funds. One transaction.

The channel returns to UNINITED and can be reopened without redeployment.

### Phase 6: Dispute

If one party disappears:

1. Remaining party submits latest signed state via `startUncooperativeClose`
2. Quarantine period begins (configurable, default 3 days)
3. During quarantine, counterparty can challenge with a state containing a higher `seqno`
4. After quarantine, `finishUncooperativeClose` distributes funds according to the latest valid state

The honest party always recovers the correct balance.

## 4. Smart Contract

Written in [Tolk](https://docs.ton.org/develop/tolk/overview) (TON's successor to FunC).

### Balance Model

6 fields per channel. Effective balance is computed, not stored:

| Party | Effective balance |
|---|---|
| A | `depositA + sentB - sentA - withdrawnA` |
| B | `depositB + sentA - sentB - withdrawnB` |

Supports top-ups, partial withdrawals, and bidirectional payments.

### Operations

| Operation | Description | Gas |
|---|---|---|
| topUp | Add funds (before or after init) | 0.004 TON |
| init | Activate channel | 0.004 TON |
| cooperativeClose | Close with both signatures | 0.006 TON |
| cooperativeCommit | Partial withdrawal, channel stays open | 0.005 TON |
| startUncooperativeClose | Begin dispute | 0.005 TON |
| challengeQuarantinedState | Submit newer state during quarantine | 0.005 TON |
| settleConditionals | Resolve conditional payments | 0.005 TON |
| finishUncooperativeClose | Finalize after quarantine | 0.005 TON |

### Design decisions

- **Dust limit (0.001 TON):** balances below this are redirected to the counterparty. Prevents silent message failures on TON where messages with value below ~0.001 TON can be dropped.
- **Channel reopen:** closed channels return to UNINITED and can be reinitialized without redeployment.
- **Surplus gas refund:** the contract reserves only what it needs and returns the rest to the sender via `sendExcess`.

## 5. Comparison

| | x402 | A402 | tonweb | Lightning | pc402 |
|---|---|---|---|---|---|
| Settlement | On-chain per payment | Payment channel | Payment channel | Channel + routing | Payment channel |
| Gas per payment | Full tx fee | 0 | 0 | 0 | 0 |
| Latency | ~5s | <1ms | <1ms | ~1s | <1ms |
| HTTP 402 | Yes | Yes | No | No | Yes |
| Third party | Facilitator | No | No | Routing nodes | No |
| Hardware | None | TEE (Intel SGX) | None | None | None |
| Chain | Base, Ethereum | Ethereum (paper) | TON | Bitcoin | TON |
| TypeScript SDK | Yes | No (paper only) | JS (unmaintained) | No (Rust/Go) | Yes |
| Mainnet tested | Yes ($26M+) | No | Unknown | Yes | Yes (800+ payments) |

Sources: [x402](https://github.com/coinbase/x402), [A402](https://arxiv.org/abs/2503.18732), [tonweb](https://github.com/toncenter/tonweb)

## 6. Security Model

### Guarantees

- **Non-custodial.** Funds are locked in the smart contract. Neither party can withdraw without a valid signed state.
- **Replay protection.** Each payment increments a `seqno`. The contract rejects any state with a seqno less than or equal to the last accepted value.
- **Dual signatures for close.** Cooperative close requires both parties' signatures. Neither can unilaterally close with a fabricated state.
- **Dispute resolution.** Quarantine period lets the counterparty challenge stale states. The honest party always recovers the correct balance.

### What the server cannot do

- **Steal funds.** Can only close with a mutually signed state.
- **Inflate its balance.** The balance model derives from the client's signed `sentA` values.
- **Deny service and keep funds.** Client force-closes and recovers all unsent funds after quarantine.

### Limitations

- **Censorship.** If the server refuses to serve, the client loses nothing financially but cannot access the service.
- **Liveness requirement.** During quarantine, the honest party must be online to challenge a stale state submission.

### No hardware dependencies

Security comes from Ed25519 cryptography and economic incentives, not trusted hardware.

## 7. Performance

Measured on TON mainnet.

### On-chain

| Operation | Cost |
|---|---|
| Full lifecycle (deploy + init + close) | ~0.015 TON (~$0.03) |
| Single operation | ~0.005 TON (~$0.01) |

### Off-chain

| Metric | Value |
|---|---|
| Gas per payment | 0 |
| Verification time | <1ms |
| Payload size | ~200 bytes |
| Throughput | 87+ payments/sec |
| Tested on mainnet | 800+ bidirectional |

### Edge/IoT

| Metric | Value |
|---|---|
| Ed25519 verify on ESP32 | ~15ms |
| LoRa max packet | 250 bytes |
| Payment fits single LoRa packet | Yes (200 bytes) |

### Break-even vs x402

x402 costs ~$0.01 gas per API call. pc402 costs ~$0.03 total for the entire channel. Break-even: 3 API calls. At 1000 calls: x402 = $10 gas, pc402 = $0.03.

## 8. Use Cases

### AI Agents

Agent sends HTTP request. Server responds 402 with price. Agent signs one Ed25519 state update. Server verifies in <1ms, responds with data. No OAuth, no API keys. The payment is the authentication. Thousands of API calls per minute, zero gas.

### IoT Mesh

Sensors trade data via LoRa or NFC. Payments are 200-byte signed messages exchanged without internet. Settlement happens when connectivity is available. Works in rural areas, ocean buoys, disaster zones.

### API Monetization

Server adds pc402 middleware: check for valid payment signature, return 402 if missing. No Stripe, no invoicing. Pay per request. Server withdraws via commit protocol without interrupting service.

### Content Streaming

Pay per paragraph, per video second, per dataset row. Minimum payment: 0.001 TON (~$0.002), bounded only by dust limit. Traditional processors require $0.50 minimum.

### Vehicle-to-Vehicle

Car pays toll, parking, charging, wifi as streaming micropayments. Channel settles on departure. One on-chain transaction covers the entire session.
