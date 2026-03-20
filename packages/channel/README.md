# pc402-channel

On-chain payment channel lifecycle for TON. Deploy, fund, initialize, commit, close, and handle disputes via the pc402 v2.1 smart contract.

## Install

```bash
npm install pc402-channel
```

Peer dependencies: `@ton/core`, `@ton/crypto`. Also requires `@ton/ton` (TonClient).

## Usage

```typescript
import { OnchainChannel, buildSignedSemiChannel } from "pc402-channel";

// Constructor (v0.2): myKeyPair/counterpartyPublicKey/isA/myAddress/counterpartyAddress
const channel = new OnchainChannel({
  client,                              // TonClient instance
  myKeyPair: keyPairA,                 // this party's Ed25519 key pair
  counterpartyPublicKey: keyPairB.publicKey,
  isA: true,                           // true if this party is side A
  myAddress: addressA,
  counterpartyAddress: addressB,
  channelId: 1n,                       // unique uint128
  initBalanceA: 0n, initBalanceB: 0n,
  closingConfig: {                     // optional
    quarantineDuration: 3600,          // seconds (default: 0)
    conditionalCloseDuration: 3600,
    misbehaviorFine: 0n,
  },
});

// Deploy + fund + init
await channel.deployAndTopUp(senderA, true, toNano("1"));
await channel.init(senderA, toNano("1"), 0n); // uses this.myKeyPair + this.isA

// Read state
const state = await channel.getOnchainState();
// { state: 1, balanceA, balanceB, seqnoA, seqnoB, withdrawnA, withdrawnB, channelId }

// Cooperative close (v0.2): seqnoA/seqnoB added
const sigA = channel.signClose(seqnoA, seqnoB, sentA, sentB, keyPairA);
const sigB = channel.signClose(seqnoA, seqnoB, sentA, sentB, keyPairB);
await channel.cooperativeClose(senderA, seqnoA, seqnoB, sentA, sentB, sigA, sigB);
```

## API

### OnchainChannel

| Method | Description |
|---|---|
| **Lifecycle** | |
| `deployAndTopUp(via, isA, amount)` | Deploy contract + first deposit |
| `topUp(via, isA, amount)` | Add funds (before or after init) |
| `init(via, balanceA, balanceB)` | Initialize channel (UNINITED → OPEN); uses `this.myKeyPair` + `this.isA` |
| **Cooperative** | |
| `signClose(seqnoA, seqnoB, sentA, sentB, keyPair)` | Sign cooperative close payload |
| `cooperativeClose(via, seqnoA, seqnoB, sentA, sentB, sigA, sigB)` | Close and distribute funds |
| `signCommit(seqnoA, seqnoB, sentA, sentB, kp, wA?, wB?)` | Sign commit payload |
| `cooperativeCommit(via, seqnoA, seqnoB, sentA, sentB, sigA, sigB, wA?, wB?)` | Advance seqnos + optional withdrawal |
| **Dispute** | |
| `signStartUncoopClose(schA, schB, keyPair)` | Sign dispute initiation |
| `startUncooperativeClose(via, signedByA, sig, schA, schB)` | Begin quarantine |
| `signChallenge(schA, schB, keyPair)` | Sign challenge payload |
| `challengeQuarantinedState(via, byA, sig, schA, schB)` | Submit newer state during quarantine |
| `signSettle(conditionalsCell, keyPair)` | Sign conditional settlement |
| `settleConditionals(via, isFromA, sig, cell)` | Execute Merkle proof conditionals |
| `finishUncooperativeClose(via)` | Finalize after timeout (callable by anyone) |
| **Query** | |
| `getOnchainState()` | Read channel state from blockchain |
| `getAddress()` | Get contract address |
| `getChannelId()` | Get channel ID |

### Helpers

| Export | Description |
|---|---|
| `buildSignedSemiChannel(chId, seqno, sent, kp)` | Build signed semi-channel cell for dispute |
| `createChannelStateInit(config)` | Build StateInit for contract deployment |
| `PAYMENT_CHANNEL_CODE` | Compiled v2.1 contract bytecode (Cell), includes 6 security fixes over v2 |

### Constants

All opcodes (`OP_TOP_UP`, `OP_INIT_CHANNEL`, ...) are exported for advanced use. Signature tags are re-exported from `pc402-core` (single source of truth).

## Channel States

| State | Value | Description |
|---|---|---|
| UNINITED | 0 | Not initialized (or closed and reopenable) |
| OPEN | 1 | Active, payments can flow |
| CLOSURE_STARTED | 2 | Quarantine period (dispute initiated) |
| SETTLING_CONDITIONALS | 3 | Conditional payment settlement window |
| AWAITING_FINALIZATION | 4 | Ready for `finishUncooperativeClose` |

## Gas Costs

| Operation | Cost |
|---|---|
| deployAndTopUp | ~0.005 TON |
| init | ~0.004 TON |
| cooperativeCommit | ~0.005 TON |
| cooperativeClose | ~0.006 TON |
| startUncooperativeClose | ~0.005 TON |
| finishUncooperativeClose | ~0.005 TON |

Surplus gas is refunded automatically via the contract's excess pattern.

## License

MIT
