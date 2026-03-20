# Security Audit Findings — pc402 Payment Channel Contract v2

**Date**: 2026-03-20
**Contract**: `contracts/src/payment-channel.tolk` (Tolk, compiled with tolk-js v1.2.0)
**Code hash**: `AF84AD6CF541DD74EA908C6C7F8315FD6CA3A96689BD4BAD4BFD13F5FEAC86D5`
**Methodology**: Static analysis + sandbox PoC (vitest + @ton/sandbox) + TON documentation review

---

## Summary

| #  | Finding                                          | Severity     | Verified        |
|----|--------------------------------------------------|--------------|-----------------|
| F1 | cooperativeCommit withdrawal replay              | **CRITICAL** | PoC confirmed   |
| F2 | cooperativeClose without seqno check             | **HIGH**     | PoC confirmed   |
| F3 | Missing semichannel cross-validation             | **MEDIUM**   | Architectural   |
| F4 | Unbounded quarantine timer on challenge           | **MEDIUM**   | Code confirmed  |
| F5 | Challenge replaces both semichannels              | **MEDIUM**   | Code confirmed  |
| F6 | topUp allowed during active dispute               | **LOW**      | Code confirmed  |
| F7 | Fine penalizes honest uncooperative close         | **LOW**      | Code confirmed  |
| F8 | finishUncooperativeClose is permissionless        | **LOW**      | Code confirmed  |
| F9 | Payout ordering asymmetry (A absorbs fees)        | **LOW**      | Code confirmed  |
| F10 | Gas limit risk on settleConditionals             | **LOW**      | Code confirmed  |
| F11 | TAG_STATE / schema.tlb desynchronized            | **LOW**      | Code confirmed  |
| F12 | Bounce disabled on all outbound messages         | **INFO**     | Code confirmed  |
| F13 | Dust limit asymmetry (A processed first)         | **INFO**     | Code confirmed  |
| F14 | No integer overflow risk (TVM 257-bit)           | **INFO**     | Positive        |
| F15 | Signature domain separation correct (7 tags)     | **INFO**     | Positive        |
| F16 | channelId verified in all operations             | **INFO**     | Positive        |
| F17 | Third-party interference correctly prevented     | **INFO**     | Positive        |

---

## CRITICAL

### F1 — cooperativeCommit Withdrawal Replay

**Location**: `payment-channel.tolk:221-222, 234-237`
**Status**: Confirmed by sandbox PoC (`tests/poc-replay.test.ts`)

#### Description

The `cooperativeCommit` operation uses `>=` for seqno validation:

```tolk
assert(newSeqnoA >= commitedSeqnoA) throw ERROR_COMMIT_SEQNO_A_REGRESS;  // line 221
assert(newSeqnoB >= commitedSeqnoB) throw ERROR_COMMIT_SEQNO_B_REGRESS;  // line 222
```

Combined with **additive** withdrawal accounting:

```tolk
withdrawnA += deltaA;  // line 236
withdrawnB += deltaB;  // line 237
```

If the exact same cooperativeCommit message is replayed, the seqno check passes (equality), `sentA`/`sentB` are set idempotently (absolute assignment, line 230-231), but `withdrawnA`/`withdrawnB` are **incremented again**. Each replay sends an additional withdrawal payout.

#### PoC Results

- Channel: depositA=2 TON, depositB=1 TON
- cooperativeCommit with withdrawA=0.5 TON, seqno=(1,1)
- 1st call: success, `withdrawnA = 0.5 TON`
- 2nd call (replay): success, `withdrawnA = 1.0 TON`
- 3rd call: success, `withdrawnA = 1.5 TON`
- 4th call: success, `withdrawnA = 2.0 TON` — **entire deposit drained**
- 5th call: exit code 125 (ERROR_COMMIT_BALANCE_A_NEGATIVE)

#### TON Mainnet Exploitability

TON provides **no built-in replay protection** for external messages. Per official documentation:

> "In the TON protocol itself, there is no built-in protection against validators including your message any number of times."

Since `cooperativeCommit` is callable via `recvExternal` (line 533), any network observer can extract the message from a processed block and re-broadcast it. The @ton/sandbox behavior matches mainnet on this point.

#### Recommended Fix

Change withdrawal accounting from additive to absolute:

```tolk
// Before (vulnerable):
withdrawnA += deltaA;

// After (idempotent):
assert(newWithdrawA >= withdrawnA) throw ERROR_COMMIT_WITHDRAW_REGRESS;
withdrawnA = newWithdrawA;
```

This preserves the `>=` seqno design while making replay harmless.

---

## HIGH

### F2 — cooperativeClose Without Seqno Check

**Location**: `payment-channel.tolk:175-200`
**Status**: Confirmed by sandbox PoC (`tests/poc-mismatched.test.ts`)

#### Description

`cooperativeClose` verifies dual signatures, TAG, and channelId, but performs **no seqno validation**. Any previously dual-signed close message remains valid indefinitely, even after `cooperativeCommit` has advanced the on-chain state.

#### PoC Results

1. Channel: depositA=2 TON, depositB=1 TON
2. Both parties sign cooperativeClose(sentA=0, sentB=0)
3. cooperativeCommit advances state to sentA=0.5 TON
4. Old cooperativeClose(sentA=0) replayed: **exit code 0** (accepted)
5. Channel closes at sentA=0 instead of 0.5 TON — B loses 0.5 TON

#### Attack Scenario

Party A and B sign a close message at state X. They decide not to close and continue transacting. State advances via commits to state Y (where A has paid more to B). Party A replays the old close message to revert to state X, recovering funds already committed to B.

If the close was previously broadcast as an external message (even if not processed), it is visible on-chain and replayable by anyone.

#### Note on Post-Close Replay

After `closeChannel()` executes, it resets `inited = false` (line 86). A replay of the same close message after the channel has closed would fail at `assert(inited != 0)` (line 177). The vulnerability only applies to replay **before** close but **after** state has advanced via commit.

#### Recommended Fix

Add seqno fields to the cooperativeClose signed payload and enforce monotonicity:

```tolk
var closeSeqnoA: int = msg.loadUint(64);
var closeSeqnoB: int = msg.loadUint(64);
assert(closeSeqnoA >= commitedSeqnoA) throw ERROR_CLOSE_SEQNO_REGRESS;
assert(closeSeqnoB >= commitedSeqnoB) throw ERROR_CLOSE_SEQNO_REGRESS;
```

This requires updating `TAG_COOPERATIVE_CLOSE` signed payload format.

---

## MEDIUM

### F3 — Missing Semichannel Cross-Validation

**Location**: `payment-channel.tolk:305-312` (startUncooperativeClose), `payment-channel.tolk:338-363` (challengeQuarantinedState)
**Status**: Architecturally confirmed (PoC blocked by TAG_STATE mismatch in stale build)

#### Description

In `startUncooperativeClose` and `challengeQuarantinedState`, each semichannel is parsed and verified independently via `parseSemichannel()`. The only cross-check is that both seqnos meet the `>= commitedSeqno` threshold. There is no validation that the two submitted semichannels are **mutually consistent**.

#### Attack Scenario

1. Party A has old self-signed state (seqnoA=5, sentA=0) and current B state (seqnoB=5, sentB=0.5 TON)
2. After cooperativeCommit at seqno 5, A submits: old schA(sentA=0) + current schB(sentB=0.5)
3. Both semichannels have valid signatures and seqnos >= committed
4. If B doesn't challenge within quarantine period, A benefits from lower sentA

#### Practical Exploitability: Low

- The `>= commitedSeqno` check blocks states older than the last on-chain commit
- Off-chain protocols typically increment seqnos, making multiple states at the same seqno unlikely
- The challenge mechanism provides recourse within quarantine duration

#### Recommended Fix

Add a `counterpartyData` field to each semichannel (each party signs their view of the counterparty's state, enabling cross-checks), or add a check that submitted `sentA`/`sentB` are `>=` the on-chain committed values.

---

### F4 — Unbounded Quarantine Timer on Challenge

**Location**: `payment-channel.tolk:369`
**Status**: Code confirmed (intentional design choice)

#### Description

When a challenge succeeds, the quarantine timer is reset to `blockchain.now()`:

```tolk
.storeUint(blockchain.now(), 32)  // line 369
```

Combined with unlimited challenges (alternating parties, each with a strictly higher seqno), the total dispute duration can be extended indefinitely.

#### Impact

An adversary with many pre-signed states at incrementally higher seqnos can repeatedly challenge, resetting the timer each time. Total lockup duration = `N × quarantineDuration` where N is the number of available state increments.

#### Recommended Fix

Add a maximum dispute duration cap:

```tolk
assert(originalStartedAt + maxDisputeDuration > blockchain.now()) throw ERROR_DISPUTE_EXPIRED;
```

Or limit the number of challenge rounds.

---

### F5 — Challenge Replaces Both Semichannels

**Location**: `payment-channel.tolk:366-372`
**Status**: Code confirmed

#### Description

In `challengeQuarantinedState`, the entire quarantine cell is replaced — both party A's and party B's semichannel data. This means the challenger can submit a favorable version of their **own** semichannel (lower sent = higher balance for themselves) while also updating the initiator's.

#### Impact

Combined with F3 (no cross-validation), the challenger can submit:
- A legitimately newer state from the initiator (higher seqno, satisfying the supersede check)
- Their own older state with lower sent value

#### Recommended Fix

Only replace the initiator's semichannel during challenge, not both. The challenger's own semichannel (already submitted by the initiator) should be left untouched.

---

## LOW

### F6 — topUp Allowed During Active Dispute

**Location**: `payment-channel.tolk:111-142`

`topUp` has no `quarantine == null` guard. Deposits during an active dispute change `depositA`/`depositB` and thus alter `calcA()`/`calcB()` at finalization.

**Impact**: A party can increase their final payout by depositing during dispute, though they are spending real money to do so. Minor manipulation vector.

**Recommended Fix**: Add `assert(quarantine == null)` at the start of `topUp`, or load quarantine state to check.

---

### F7 — Fine Penalizes Honest Uncooperative Close

**Location**: `payment-channel.tolk:482-489`

The fine is applied to the dispute initiator whenever the counterparty does **not** challenge (`~wasChallenged`). If party B is genuinely offline/dead and A honestly submits the latest state, A is still fined. An alternative design would apply the fine only when misbehavior is detected (challenger proves stale state), which is more equitable but provides less deterrent.

**Impact**: Honest parties are penalized when counterparties are unresponsive. This may discourage legitimate uncooperative closes.

---

### F8 — finishUncooperativeClose is Permissionless

**Location**: `payment-channel.tolk:458-496`

`finishUncooperativeClose` requires no signature or sender verification. Anyone can trigger finalization after the full dispute period expires.

**Impact**: Safe by design — the outcome is fully determined by the quarantined state and time locks. However, a third party could front-run a last-second `cooperativeClose` that both parties prefer. This is standard practice in payment channels.

---

### F9 — Payout Ordering Asymmetry

**Location**: `payment-channel.tolk:78-83`

Party B is paid first with an explicit amount. Party A is paid last with `SEND_MODE_CARRY_ALL_BALANCE`, receiving whatever remains. This means A absorbs:
- Accumulated storage fees
- Any gas overhead from the close transaction
- Rounding from the balance computation

**Impact**: Negligible in normal operation. In pathological cases (very long-lived channel with insufficient storage reserve), the erosion could be material.

---

### F10 — Gas Limit Risk on settleConditionals

**Location**: `payment-channel.tolk:429-431`

Each conditional is executed as a TVM continuation. Computationally expensive continuations could exceed the transaction gas limit, causing `settleConditionals` to fail. If the settle window expires without successful settlement, `finishUncooperativeClose` proceeds without conditional adjustments.

**Impact**: The affected party loses funds owed via conditionals. Mitigated by the fact that both parties consented to the conditional code (signed the condHash), and the submitter has economic incentive to ensure success.

---

### F11 — TAG_STATE / schema.tlb Desynchronized

**Location**: `messages.tolk:20`, `schema.tlb:15`, `tests/payment-channel.test.ts:26`

- Contract source: `TAG_STATE = 0x50433453` ("PC4S") — uncommitted change
- Test file: `TAG_STATE = 0x43685374` ("ChSt") — old value
- Schema TLB: `semichannel_body$43685374` — old value
- Compiled build: uses old value (build is stale)

**Impact**: Dispute-related tests fail against a recompiled build. No security impact, but blocks testing of dispute paths including F3 verification.

**Fix**: Update tests and schema.tlb to use `0x50433453`, then recompile.

---

## INFORMATIONAL

### F12 — Bounce Disabled on All Outbound Messages

**Location**: `payment-channel.tolk:15, 26, 37` (`storeUint(0x10, 6)` = bounce off)

All payout, withdrawal, and excess messages use non-bounceable addressing. If a recipient address is non-existent, frozen, or deleted, the funds are permanently lost. This simplifies the contract (no bounce handler) but requires that `addrA` and `addrB` are valid, persistent addresses at deployment time.

---

### F13 — Dust Limit Asymmetry

**Location**: `payment-channel.tolk:68-75`

Dust limit processing checks A first, then B. If both are below `DUST_LIMIT` (0.001 TON), A's dust goes to B, then B (now above dust) keeps everything. Minor asymmetry favoring B for negligible amounts.

---

### F14 — No Integer Overflow Risk (Positive)

TVM uses 257-bit signed integers natively. `Coins` max value is 2^120 - 1. All arithmetic in `calcA()`/`calcB()` involves at most 4 Coins-sized values, fitting comfortably within 257 bits. No overflow is possible.

---

### F15 — Signature Domain Separation Correct (Positive)

All 7 TAG constants are unique. Cross-operation signature reuse is impossible. Key assignment is correct: `keyA` for party-A signatures, `keyB` for party-B signatures. Signatures are stored in separate cell refs, excluded from the signed hash.

| Tag                              | Value        | Operation                     |
|----------------------------------|--------------|-------------------------------|
| `TAG_INIT`                       | `0x481ebc44` | initChannel                   |
| `TAG_COOPERATIVE_CLOSE`          | `0x8243e9a3` | cooperativeClose              |
| `TAG_COOPERATIVE_COMMIT`         | `0x4a390cac` | cooperativeCommit             |
| `TAG_START_UNCOOPERATIVE_CLOSE`  | `0x8c623692` | startUncooperativeClose       |
| `TAG_CHALLENGE_QUARANTINE`       | `0xb8a21379` | challengeQuarantinedState     |
| `TAG_SETTLE_CONDITIONALS`        | `0x14588aab` | settleConditionals            |
| `TAG_STATE`                      | `0x50433453` | parseSemichannel (state body) |

---

### F16 — channelId Verified in All Operations (Positive)

`channelId` (128-bit) is loaded from storage and checked against the message payload in every authenticated operation: initChannel, cooperativeClose, cooperativeCommit, startUncooperativeClose, challengeQuarantinedState, settleConditionals, and parseSemichannel. Provides proper domain separation between contract instances.

---

### F17 — Third-Party Interference Correctly Prevented (Positive)

- `topUp`: sender address verified against `addrA`/`addrB`
- All dispute operations: require valid Ed25519 signatures from channel parties
- `cooperativeClose`/`cooperativeCommit`: require dual signatures
- `finishUncooperativeClose`: permissionless but safe (outcome determined by on-chain state + time locks)

No operation allows a third party to modify channel state or extract funds.

---

## Priority Actions

1. **CRITICAL**: Fix F1 — absolute withdrawal accounting in cooperativeCommit
2. **HIGH**: Fix F2 — add seqno check to cooperativeClose
3. **MEDIUM**: Fix F3/F5 — add semichannel cross-validation or limit challenge scope
4. **MEDIUM**: Fix F4 — cap maximum dispute duration
5. **LOW**: Fix F11 — synchronize TAG_STATE across tests, schema, and build
6. **LOW**: Fix F6 — block topUp during quarantine

### Propagation Checklist

Fixes must be applied to:
- [ ] `c402-contract/contracts/*.tolk` (source of truth)
- [ ] `c402-ton/contracts/src/*.tolk` (copy)
- [ ] `c402-ton/packages/channel/src/contract.ts` (embedded codeBoc64)
- [ ] Recompile with `npx tolk-js contracts/payment-channel.tolk`
- [ ] Update and run all test suites
