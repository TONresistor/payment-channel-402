# pc402 v0.2: Real-World Protocol Spec

## Objective
Fix all protocol gaps for real-world usage: unknown client bootstrap, structured errors, close negotiation, bidirectional payments. No breaking changes on the on-chain contract. SDK-only changes.

## What v0.1 does well (don't touch)
- Payment channel on-chain: deploy, topUp, init, close, commit, dispute (30 contract tests, E2E mainnet)
- Off-chain signing: signState, verifyState, createPaymentState (already bidirectional)
- Commit protocol: commitRequest/commitSignature over HTTP

## Changes needed

### 1. OnchainChannel refactor

Current: `OnchainChannel({ keyPairA, keyPairB, ... })` requires both full KeyPairs.
Problem: The client only has the server's public key, not the full KeyPair.

Fix:
```typescript
interface OnchainChannelOptions {
  client: TonClient;
  myKeyPair: KeyPair;              // was keyPairA or keyPairB
  counterpartyPublicKey: Buffer;   // was keyPairB.publicKey or keyPairA.publicKey
  isA: boolean;                    // which side am I?
  channelId: bigint;
  myAddress: Address;              // was addressA or addressB
  counterpartyAddress: Address;    // was addressB or addressA
  initBalanceA: bigint;
  initBalanceB: bigint;
  closingConfig?: { ... };
}
```

Impact: Breaking change on OnchainChannel constructor. All tests need update. signClose/signCommit/etc use `this.myKeyPair` instead of selecting from keyPairA/keyPairB.

Files: `packages/channel/src/onchain.ts`, all tests.

### 2. PC402PaymentRequirements

Current:
```typescript
{
  scheme, network, asset, amount,
  channelAddress: string,     // required
  channelId: string,          // required
  extra: { initBalanceA, initBalanceB, publicKeyB }
}
```

Fix:
```typescript
{
  scheme: "pc402";
  network: string;
  asset: string;
  amount: string;

  // Server identity (always present)
  payee: {
    publicKey: string;       // hex, 32 bytes
    address: string;         // TON wallet address
  };

  // Channel info (present if server knows this client's channel)
  channel?: {
    address: string;
    channelId: string;
    initBalanceA: string;
    initBalanceB: string;
  };

  // Rejection context (present if 402 is a payment rejection, not initial discovery)
  error?: VerifyErrorCode;
  errorMessage?: string;
}
```

Files: `packages/core/src/types.ts`, `packages/core/src/protocol.ts` (buildPaymentRequired, parsePaymentRequired), all tests using these.

### 3. PC402PaymentResponse: error + close

Current: `{ success: boolean, counterSignature, network, commitRequest? }`

Fix:
```typescript
// Success
{
  success: true;
  counterSignature: string;
  network: string;
  commitRequest?: PC402CommitRequest;
  closeRequest?: PC402CloseRequest;
}

// Error (payment rejected)
{
  success: false;
  error: VerifyErrorCode;
  errorMessage: string;
  network: string;
}
```

New type:
```typescript
interface PC402CloseRequest {
  sentA: string;
  sentB: string;
  serverSignature: string;   // base64, server's close sig
}
```

Files: `packages/core/src/types.ts`, `packages/core/src/protocol.ts` (buildPaymentResponse, buildPaymentError, parsePaymentResponse).

### 4. PC402PaymentPayload: close signature

Add:
```typescript
{
  // ... existing fields ...
  closeSignature?: string;   // base64, client's close co-sig
}
```

Files: `packages/core/src/types.ts`.

### 5. verifyPaymentSignature fixes

Add these checks:
- `channel_exhausted`: if client's balance after payment would be 0, set flag
- `publicKey` match: verify payload.publicKey matches channel.config.hisPublicKey
- `commitSignature` passthrough: return it in VerifyPaymentResult for the server to use
- `seqnoB` immutability: verify client didn't change seqnoB

Files: `packages/core/src/protocol.ts`.

### 6. New helpers

```typescript
// Build a 402 error response
buildPaymentError(error: VerifyErrorCode, message: string, network?: string): string

// Extract routing info from a payment (before full verification)
resolveChannelFromPayload(header: string): {
  channelAddress: string;
  channelId: string;
  publicKey: string;
} | null

// Build channel config from a 402 discovery response
channelConfigFromRequirements(
  requirements: PC402PaymentRequirements,
  myKeyPair: KeyPair,
  myAddress: Address,
): { onchainOptions: OnchainChannelOptions; paymentConfig: ChannelConfig }
```

Files: `packages/core/src/protocol.ts`, new `packages/core/src/helpers.ts`.

## Bidirectional payments

Already supported. PaymentChannel is initialized with `isA: true` or `isA: false`. Both sides can call `createPaymentState()` to pay the other. The channel contract supports bidirectional sent values (sentA/sentB).

For HTTP: the server can pay the client by including a payment in the `PAYMENT-RESPONSE`. But this is an application-level pattern, not a protocol change. The SDK already supports it:
- Server has its own PaymentChannel with `isA: false`
- Server calls `createPaymentState()` + `signState()`
- Server includes the signed state in a custom header or response body

No protocol change needed. Just documentation.

## Flows after v0.2

### Flow 1: Discovery (first contact)
```
Client -> Server: GET /resource
Server -> Client: 402 { scheme: "pc402", amount, payee: { publicKey, address } }
Client:           deploys channel on-chain using payee info
Client -> Server: GET /resource + PAYMENT-SIGNATURE { channelAddress, channelId, state, sig, publicKey, initBalanceA, initBalanceB }
Server:           verifies sig, registers channel, accepts payment
Server -> Client: 200 + PAYMENT-RESPONSE { counterSignature }
```

### Flow 2: Normal payment (channel known)
```
Client -> Server: GET /resource + PAYMENT-SIGNATURE { channelAddress, state, sig }
Server -> Client: 200 + PAYMENT-RESPONSE { counterSignature }
```

### Flow 3: Payment rejected
```
Client -> Server: GET /resource + PAYMENT-SIGNATURE { bad sig / stale seqno / underpaid }
Server -> Client: 402 + PAYMENT-RESPONSE { success: false, error: "invalid_signature", errorMessage: "..." }
```

### Flow 4: Commit (server withdraws)
```
Server -> Client: 200 + PAYMENT-RESPONSE { counterSignature, commitRequest: { seqnos, sent, withdraw, serverSig } }
Client -> Server: next request + PAYMENT-SIGNATURE { state, sig, commitSignature }
Server:           broadcasts cooperativeCommit on-chain
```

### Flow 5: Close (server-initiated)
```
Server -> Client: 200 + PAYMENT-RESPONSE { counterSignature, closeRequest: { sentA, sentB, serverSig } }
Client -> Server: next request + PAYMENT-SIGNATURE { state, sig, closeSignature }
Server:           broadcasts cooperativeClose on-chain
```

### Flow 6: Close (client-initiated)
```
Client -> Server: GET /resource + PAYMENT-SIGNATURE { state, sig, closeSignature: clientCloseSig }
Server:           co-signs, broadcasts cooperativeClose
Server -> Client: 200 + PAYMENT-RESPONSE { counterSignature, closeConfirmed: true }
```

### Flow 7: Channel exhausted
```
Client -> Server: PAYMENT-SIGNATURE { state with balanceA near 0 }
Server -> Client: 200 + PAYMENT-RESPONSE { counterSignature, channelExhausted: true }
Client:           tops up on-chain or opens new channel
```

## Implementation order

1. OnchainChannel refactor (breaking, do first)
2. Types v0.2 (PC402PaymentRequirements, PC402PaymentResponse, PC402CloseRequest)
3. Protocol helpers (buildPaymentError, resolveChannelFromPayload, channelConfigFromRequirements)
4. verifyPaymentSignature fixes
5. Update all tests
6. Update README + technical.md
7. Publish v0.2.0

## What NOT to change
- On-chain contract (zero changes)
- PaymentChannel class (already correct)
- StateManager / Storage (already correct)
- Existing error classes (already correct)
- Commit protocol (already correct)

## Verification
```bash
npm test              # all existing tests updated + new tests
npx tsc --noEmit      # 0 errors
npx @biomejs/biome lint .
npm run build
```
