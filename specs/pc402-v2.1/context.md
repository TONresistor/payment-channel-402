# pc402 v2.1: Security Fixes — Contract + SDK

## Objective
Fix all 6 security findings from the audit (docs/findings.md). Contract v2.1 + SDK update. No backward compatibility constraints — carte blanche.

## Findings to fix

| # | Severity | Finding | Wire-breaking |
|---|----------|---------|--------------|
| F1 | CRITICAL | cooperativeCommit withdrawal replay | No (semantic change) |
| F2 | HIGH | cooperativeClose without seqno check | Yes (new fields in signed payload) |
| F3 | MEDIUM | Missing semichannel cross-validation | No (reject only) |
| F4 | MEDIUM | Unbounded quarantine timer on challenge | No (quarantine cell layout change) |
| F5 | MEDIUM | Challenge replaces both semichannels | No (reject only) |
| F6 | LOW | topUp allowed during active dispute | No (reject only) |

## F1 — cooperativeCommit: strict seqno + absolute withdrawal

### Contract changes (payment-channel.tolk)

**Line 221-222**: `>=` → `>`
```tolk
// BEFORE
assert(newSeqnoA >= commitedSeqnoA) throw ERROR_COMMIT_SEQNO_A_REGRESS;
assert(newSeqnoB >= commitedSeqnoB) throw ERROR_COMMIT_SEQNO_B_REGRESS;

// AFTER
assert(newSeqnoA > commitedSeqnoA) throw ERROR_COMMIT_SEQNO_A_REGRESS;
assert(newSeqnoB > commitedSeqnoB) throw ERROR_COMMIT_SEQNO_B_REGRESS;
```

**Lines 234-237**: additive → absolute
```tolk
// BEFORE
var deltaA: int = newWithdrawA;
var deltaB: int = newWithdrawB;
withdrawnA += deltaA;
withdrawnB += deltaB;

// AFTER
assert(newWithdrawA >= withdrawnA) throw ERROR_COMMIT_WITHDRAW_A_REGRESS;
assert(newWithdrawB >= withdrawnB) throw ERROR_COMMIT_WITHDRAW_B_REGRESS;
var deltaA: int = newWithdrawA - withdrawnA;
var deltaB: int = newWithdrawB - withdrawnB;
withdrawnA = newWithdrawA;
withdrawnB = newWithdrawB;
```

**New error constants (errors.tolk)**:
```tolk
const ERROR_COMMIT_WITHDRAW_A_REGRESS = 128;
const ERROR_COMMIT_WITHDRAW_B_REGRESS = 129;
```

### Message layout change: NONE
Same fields, same order. `withdrawA/B` semantic changes from delta to cumulative absolute.

### SDK changes
- `OnchainChannel.signCommit()` — JSDoc update: `withdrawA/B` are now cumulative totals, not per-call deltas
- `OnchainChannel.cooperativeCommit()` — same JSDoc update
- `PaymentChannel.signCommit()` — same
- `PaymentChannel.verifyCommit()` — same
- No code change needed — the signature and message bytes are identical

### Test changes
- Update sandbox tests: add test that replaying same cooperativeCommit is rejected (seqno `>` strict)
- Add test: `withdrawA < current withdrawnA` → rejected

## F2 — cooperativeClose: add seqno check

### Contract changes (payment-channel.tolk)

**Lines 186-196**: add seqno fields after channelId
```tolk
// BEFORE
assert(msg.loadUint(32) == TAG_COOPERATIVE_CLOSE) throw ERROR_CLOSE_CHANNEL_ID_MISMATCH;
assert(channelId == msg.loadUint(128)) throw ERROR_CLOSE_CHANNEL_ID_MISMATCH;
var newSentA: int = msg.loadCoins();
var newSentB: int = msg.loadCoins();

// AFTER
assert(msg.loadUint(32) == TAG_COOPERATIVE_CLOSE) throw ERROR_CLOSE_CHANNEL_ID_MISMATCH;
assert(channelId == msg.loadUint(128)) throw ERROR_CLOSE_CHANNEL_ID_MISMATCH;
var closeSeqnoA: int = msg.loadUint(64);
var closeSeqnoB: int = msg.loadUint(64);
assert(closeSeqnoA >= commitedSeqnoA) throw ERROR_CLOSE_SEQNO_A_REGRESS;
assert(closeSeqnoB >= commitedSeqnoB) throw ERROR_CLOSE_SEQNO_B_REGRESS;
var newSentA: int = msg.loadCoins();
var newSentB: int = msg.loadCoins();
```

**New error constants (errors.tolk)**:
```tolk
const ERROR_CLOSE_SEQNO_A_REGRESS = 136;
const ERROR_CLOSE_SEQNO_B_REGRESS = 137;
```

### Signed payload change (WIRE-BREAKING)
```
// BEFORE
TAG_CLOSE(32) + channelId(128) + sentA(Coins) + sentB(Coins)

// AFTER
TAG_CLOSE(32) + channelId(128) + seqnoA(64) + seqnoB(64) + sentA(Coins) + sentB(Coins)
```

### SDK changes

**`packages/core/src/cell.ts`** — no change needed. TAG_CLOSE value stays 0x8243e9a3.

**`packages/core/src/channel.ts` — `_buildStateCell` TAG_CLOSE branch**:
```typescript
// BEFORE (lines ~293-300)
if (tag === TAG_CLOSE) {
  return beginCell()
    .storeUint(TAG_CLOSE, 32)
    .storeUint(channelId, 128)
    .storeCoins(sentA)
    .storeCoins(sentB)
    .endCell();
}

// AFTER
if (tag === TAG_CLOSE) {
  return beginCell()
    .storeUint(TAG_CLOSE, 32)
    .storeUint(channelId, 128)
    .storeUint(state.seqnoA, 64)
    .storeUint(state.seqnoB, 64)
    .storeCoins(sentA)
    .storeCoins(sentB)
    .endCell();
}
```

`signClose(state)` and `verifyClose(state, sig)` pass `state` which already has `seqnoA/seqnoB`. No API change needed.

**`packages/channel/src/onchain.ts` — `signClose`**:
```typescript
// BEFORE
signClose(sentA: bigint, sentB: bigint, keyPair: KeyPair): Buffer {
  const payloadCell = beginCell()
    .storeUint(TAG_COOPERATIVE_CLOSE, 32)
    .storeUint(this.channelId, 128)
    .storeCoins(sentA)
    .storeCoins(sentB)
    .endCell();

// AFTER
signClose(seqnoA: bigint, seqnoB: bigint, sentA: bigint, sentB: bigint, keyPair: KeyPair): Buffer {
  const payloadCell = beginCell()
    .storeUint(TAG_COOPERATIVE_CLOSE, 32)
    .storeUint(this.channelId, 128)
    .storeUint(seqnoA, 64)
    .storeUint(seqnoB, 64)
    .storeCoins(sentA)
    .storeCoins(sentB)
    .endCell();
```

**`packages/channel/src/onchain.ts` — `cooperativeClose`**:
```typescript
// BEFORE
async cooperativeClose(via, sentA, sentB, signatureA, signatureB)

// AFTER
async cooperativeClose(via, seqnoA, seqnoB, sentA, sentB, signatureA, signatureB)

// Message body adds seqnoA(64) + seqnoB(64) between channelId and sentA
```

### Test changes
- `channel.test.ts`: signClose/verifyClose tests — signatures now include seqnos
- `onchain.test.ts`: add cooperativeClose message layout test
- `payment-channel.test.ts` (contract sandbox): update all cooperativeClose calls
- `happy-path.test.ts` (E2E mainnet): update cooperativeClose call
- `offchain-payments.test.ts` (E2E mainnet): update cooperativeClose call
- Add test: old close signature rejected after commit advances seqno

## F3 — Missing semichannel cross-validation

### Contract changes (payment-channel.tolk)

After parsing both semichannels in `startUncooperativeClose` AND `challengeQuarantinedState`, add balance floor check:

```tolk
// After: var (seqnoA, sentAmtA, condHashA) = parseSemichannel(schA, ...);
//        var (seqnoB, sentAmtB, condHashB) = parseSemichannel(schB, ...);
// Add:
assert(depositA + sentAmtB >= sentAmtA + withdrawnA) throw ERROR_UNCOOP_BALANCE_A_NEGATIVE;
assert(depositB + sentAmtA >= sentAmtB + withdrawnB) throw ERROR_UNCOOP_BALANCE_B_NEGATIVE;
```

Note: This requires `loadStorage(STORAGE_FULL)` in both functions to have access to deposit/withdrawn values. Check current storage load level and upgrade if needed.

**New error constants**:
```tolk
const ERROR_UNCOOP_BALANCE_A_NEGATIVE = 148;
const ERROR_UNCOOP_BALANCE_B_NEGATIVE = 149;
```

### SDK changes: NONE
### Test changes: Add sandbox test for mismatched semichannel rejection

## F4 — Unbounded quarantine timer

### Contract changes

**Quarantine cell layout change**: add `originalStart` field (uint32)
```
// BEFORE
seqnoA(64) + sentA(Coins) + condHashA(256)
+ seqnoB(64) + sentB(Coins) + condHashB(256)
+ timestamp(32) + signedByA(1) + wasChallenged(1)

// AFTER
seqnoA(64) + sentA(Coins) + condHashA(256)
+ seqnoB(64) + sentB(Coins) + condHashB(256)
+ originalStart(32) + lastChallengeTime(32) + signedByA(1) + wasChallenged(1)
```

**startUncooperativeClose**: write `originalStart = blockchain.now()` and `lastChallengeTime = blockchain.now()`

**challengeQuarantinedState**:
- Read `originalStart` from quarantine
- Check: `assert(originalStart + 3 * closureQuarantineDuration() > blockchain.now()) throw ERROR_CHALLENGE_DISPUTE_EXPIRED;`
- Write: keep `originalStart`, update `lastChallengeTime = blockchain.now()`

**finishUncooperativeClose / settleConditionals**: use `lastChallengeTime` (not `originalStart`) for the per-round timeout check.

**New error constant**:
```tolk
const ERROR_CHALLENGE_DISPUTE_EXPIRED = 158;
```

### All quarantine readers must be updated (4 locations):
- startUncooperativeClose (write)
- challengeQuarantinedState (read + write)
- settleConditionals (read)
- finishUncooperativeClose (read)
- get_channel_data (read, if quarantine is returned)

### SDK changes: NONE (dispute flow not wrapped)
### Test changes: Add sandbox test for challenge after max dispute duration

## F5 — Challenge replaces both semichannels

### Contract changes (payment-channel.tolk)

In `challengeQuarantinedState`, add per-semichannel seqno floor:

```tolk
// After parsing both semichannels, before writing new quarantine:
assert(seqnoA >= qSeqnoA) throw ERROR_CHALLENGE_SEQNO_A_REGRESS;
assert(seqnoB >= qSeqnoB) throw ERROR_CHALLENGE_SEQNO_B_REGRESS;
```

The existing outer check `(seqnoA > qSeqnoA) | (seqnoB > qSeqnoB)` already requires at least one to advance. The new per-field checks prevent the other from regressing.

### SDK changes: NONE
### Test changes: Add sandbox test for semichannel regression rejection

## F6 — topUp during dispute

### Contract changes (payment-channel.tolk)

In `topUp` function, add quarantine check:

```tolk
fun topUp(myBalance: int, msgValue: int, msg: slice, senderAddr: address) {
    loadStorage(STORAGE_FULL);
    assert(quarantine == null) throw ERROR_TOPUP_QUARANTINE_ACTIVE;
    // ... rest unchanged
}
```

**New error constant**:
```tolk
const ERROR_TOPUP_QUARANTINE_ACTIVE = 113;
```

### SDK changes: NONE
### Test changes: Add sandbox test for topUp rejection during quarantine

## Implementation order

1. **Contract**: Apply F1-F6 to `contracts/src/*.tolk`
2. **Compile**: `npx tolk-js` or blueprint build → get new codeBoc64
3. **Embed**: Update `PAYMENT_CHANNEL_CODE_BOC64` in `packages/channel/src/contract.ts`
4. **SDK F2**: Update `_buildStateCell` TAG_CLOSE branch, `OnchainChannel.signClose`, `OnchainChannel.cooperativeClose`
5. **SDK F1**: Update JSDoc for withdraw params (semantic: delta → absolute)
6. **Tests**: Update all close/commit tests, add 6 new reject tests
7. **E2E mainnet**: Run full suite

## Files to modify

### Contract (6 files)
- `contracts/src/payment-channel.tolk` — F1, F2, F3, F4, F5, F6
- `contracts/src/errors.tolk` — new error constants
- `contracts/src/storage.tolk` — quarantine cell layout (F4)
- `contracts/test/payment-channel.test.ts` — update all tests + 6 new

### SDK (4 files)
- `packages/channel/src/contract.ts` — new bytecode
- `packages/channel/src/onchain.ts` — signClose, cooperativeClose (F2)
- `packages/core/src/channel.ts` — _buildStateCell TAG_CLOSE branch (F2)
- `packages/core/src/types.ts` — PC402CloseRequest add seqnoA/seqnoB fields

### Tests (6 files)
- `contracts/test/payment-channel.test.ts` — F1-F6 new reject tests + close layout
- `packages/core/test/channel.test.ts` — signClose/verifyClose with seqnos
- `packages/channel/test/onchain.test.ts` — cooperativeClose message layout
- `packages/core/test/protocol.test.ts` — closeRequest round-trip with seqnos
- `test/e2e/happy-path.test.ts` — cooperativeClose call
- `test/e2e/offchain-payments.test.ts` — cooperativeClose call

## What NOT to change
- TAG values (all stay the same)
- ChannelConfig / ChannelState types
- PaymentChannel constructor
- OnchainChannel constructor (v0.2 refactor stays)
- signState / verifyState (state body unchanged)
- signCommit message layout (unchanged, just semantic)
- buildSignedSemiChannel (state body unchanged)
- HTTP 402 protocol helpers (except PC402CloseRequest)

## Verification
```bash
cd contracts && npx blueprint build    # or tolk-js compile
npm test                               # all unit + sandbox tests
npx tsc --noEmit                       # type check
npm run build                          # build all packages
source .env && npx vitest run -c test/e2e/vitest.config.ts  # E2E mainnet
```
