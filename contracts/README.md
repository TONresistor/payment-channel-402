# pc402 Payment Channel Contract v2.1

Tolk smart contract for bidirectional payment channels on TON. Part of the [pc402 SDK](https://github.com/AAAFighterTON/pc402-ton).

## Overview

A payment channel allows two parties (A and B) to exchange off-chain payments secured by an on-chain escrow. Only 3 on-chain transactions are needed for the typical lifecycle: deploy, init, close. All payments happen off-chain at zero gas cost.

Key properties:
- Bidirectional payments (A pays B, B pays A)
- 6-field balance model (depositA/B, withdrawnA/B, sentA/B)
- Cooperative close (instant, both sign) and uncooperative close (quarantine period)
- Partial withdrawal via cooperativeCommit without closing
- Channel reopen after close (same address)
- ~0.005 TON per on-chain operation

## Source files

```
src/
  payment-channel.tolk   Main contract logic (8 operations + 2 get-methods)
  storage.tolk           Data cell layout, load/save, calcA()/calcB()
  messages.tolk          Opcodes, signature tags, channel states
  errors.tolk            Error codes (100-179)
  fees.tolk              DUST_LIMIT constant
  utils.tolk             castToContinuation helper
```

## Storage layout

```
channel$_ inited:Bool
          ^Balance{depositA depositB withdrawnA withdrawnB sentA sentB}
          keyA:uint256 keyB:uint256
          channelId:uint128
          ^ClosureConfig{quarantineDuration:uint32 fine:Coins closeDuration:uint32}
          commitedSeqnoA:uint64 commitedSeqnoB:uint64
          quarantine:(Maybe ^Quarantine)
          ^PaymentConfig{storageFee:Coins addrA:Address addrB:Address}
```

Balance formula:
```
calcA() = depositA + sentB - sentA - withdrawnA
calcB() = depositB + sentA - sentB - withdrawnB
```

## Quarantine cell layout (v2.1)

```
seqnoA:uint64 sentA:Coins condHashA:uint256
seqnoB:uint64 sentB:Coins condHashB:uint256
originalStart:uint32 lastChallengeTime:uint32
signedByA:int1 wasChallenged:int1
```

`originalStart` is immutable (set when dispute begins). `lastChallengeTime` is updated on each challenge. Total dispute duration is capped at `3 * quarantineDuration` from `originalStart`.

## Operations

### recv_internal

| Operation | Opcode | Description |
|-----------|--------|-------------|
| topUp | `0x593e3893` | Deposit funds. Sender verified against addrA/addrB. Blocked during quarantine (F6). |
| initChannel | `0x79ae99b5` | Transition UNINITED -> OPEN. Single-party signature. |
| cooperativeClose | `0xd2b1eeeb` | Dual-signed close. Distributes funds, resets to UNINITED. Includes seqno check (F2). |
| cooperativeCommit | `0x076bfdf1` | Dual-signed state advance + optional withdrawal. Strict seqno `>` (F1). Absolute withdrawal accounting (F1). |
| startUncooperativeClose | `0x8175e15d` | Begin dispute with two signed semichannels. Balance cross-validation (F3). |
| challengeQuarantinedState | `0x9a77c0db` | Counterparty submits newer state. Per-semichannel seqno floor (F5). Dispute duration cap (F4). |
| settleConditionals | `0x56c39b4c` | Execute conditional payments during settle window. |
| finishUncooperativeClose | `0x25432a91` | Finalize after full timeout. Permissionless. Fine applied if unchallenged. |

### recv_external

| Operation | Opcode | Description |
|-----------|--------|-------------|
| cooperativeClose | `0xd2b1eeeb` | Gasless close (both signatures required). |
| cooperativeCommit | `0x076bfdf1` | Gasless commit (both signatures required). |

### GET methods

| Method | Returns |
|--------|---------|
| `get_channel_state()` | int: 0=UNINITED, 1=OPEN, 2=CLOSURE_STARTED, 3=SETTLING_CONDITIONALS, 4=AWAITING_FINALIZATION |
| `get_channel_data()` | 8-tuple: (state, balances[6], keys[2], channelId, closureConfig, seqnos[2], quarantine?, paymentConfig) |

## Signature tags

Each operation uses a unique 32-bit tag to prevent cross-operation signature reuse.

| Tag | Value | Signed payload |
|-----|-------|----------------|
| TAG_INIT | `0x481ebc44` | tag + channelId + balanceA + balanceB |
| TAG_COOPERATIVE_CLOSE | `0x8243e9a3` | tag + channelId + seqnoA + seqnoB + sentA + sentB |
| TAG_COOPERATIVE_COMMIT | `0x4a390cac` | tag + channelId + seqnoA + seqnoB + sentA + sentB + withdrawA + withdrawB |
| TAG_STATE | `0x50433453` | tag + channelId + seqno + sent + condHash |
| TAG_START_UNCOOPERATIVE_CLOSE | `0x8c623692` | tag + channelId + ref[schA] + ref[schB] |
| TAG_CHALLENGE_QUARANTINE | `0xb8a21379` | tag + channelId + ref[schA] + ref[schB] |
| TAG_SETTLE_CONDITIONALS | `0x14588aab` | tag + channelId + ref[conditionalsCell] |

## Error codes

| Range | Operation | Codes |
|-------|-----------|-------|
| 100-109 | initChannel | 100 ALREADY_INITED, 102 DEPOSIT_MISMATCH, 103 SIG_FAILED, 104 CHANNEL_ID_MISMATCH |
| 110-119 | topUp | 111 ADDRESS_MISMATCH, 112 NO_VALUE, 113 QUARANTINE_ACTIVE |
| 120-129 | cooperativeCommit | 120 NOT_OPEN, 121-122 SIG_FAILED, 123-124 SEQNO_REGRESS, 125-126 BALANCE_NEGATIVE, 127 CHANNEL_ID_MISMATCH, 128-129 WITHDRAW_REGRESS |
| 130-139 | cooperativeClose | 130 NOT_OPEN, 131-132 SIG_FAILED, 133-134 BALANCE_NEGATIVE, 135 CHANNEL_ID_MISMATCH, 136-137 SEQNO_REGRESS |
| 140-149 | startUncooperativeClose | 140 NOT_OPEN, 141 OUTER_SIG_FAILED, 142-143 SIG_FAILED, 144-145 SEQNO_REGRESS, 146 CHANNEL_ID_MISMATCH, 147 QUARANTINE_ACTIVE, 148-149 BALANCE_NEGATIVE |
| 150-159 | challengeQuarantinedState | 150 NOT_IN_CLOSURE, 151 QUARANTINE_EXPIRED, 152 SAME_PARTY, 153 OUTER_SIG_FAILED, 154-155 SIG_FAILED, 156 SEQNO_NOT_SUPERSEDE, 157 CHANNEL_ID_MISMATCH, 158 DISPUTE_EXPIRED |
| 160-169 | settleConditionals | 160 TOO_EARLY, 161 TOO_LATE, 162 SIG_FAILED, 163 HASH_MISMATCH, 164 CHANNEL_ID_MISMATCH, 165 EXEC_FAILED |
| 170-179 | finishUncooperativeClose | 170 TOO_EARLY, 171 NO_QUARANTINE |

## Security fixes (v2.1)

| ID | Severity | Fix | Test |
|----|----------|-----|------|
| F1 | CRITICAL | cooperativeCommit: strict seqno `>` + absolute withdrawal accounting | Replay rejected, withdrawal regress rejected |
| F2 | HIGH | cooperativeClose: seqnoA/seqnoB added to signed payload, enforced `>= commitedSeqno` | Old close rejected after commit |
| F3 | MEDIUM | startUncooperativeClose + challenge: balance floor check (`calcA >= 0`, `calcB >= 0`) | Inconsistent semichannels rejected |
| F4 | MEDIUM | challengeQuarantinedState: total dispute capped at `3 * quarantineDuration` from originalStart | Timer cannot be extended indefinitely |
| F5 | MEDIUM | challengeQuarantinedState: per-semichannel seqno floor (neither may regress) | Seqno regression rejected |
| F6 | LOW | topUp: blocked during active quarantine | topUp during dispute rejected |

## Build

Requires `@ton/tolk-js` (Tolk compiler v1.2.0).

```bash
tolk-js -o build/payment-channel.json -C src payment-channel.tolk
```

The compiled bytecode is embedded in the SDK at `packages/channel/src/contract.ts` as `PAYMENT_CHANNEL_CODE_BOC64`.

## Tests

36 sandbox tests using `@ton/sandbox` (local blockchain, no mainnet required).

```bash
npx vitest run
```

### Test coverage

**Basic lifecycle (7 tests)**
- Deploy contract
- Top up party A / party B
- Init channel (UNINITED -> OPEN)
- Reject double init (exit 100)
- Cooperative close
- Reopen after close

**CooperativeCommit (5 tests)**
- Commit state without withdrawal
- Commit with sent values
- Commit with withdrawal for A
- Reject seqno regress (exit 123)
- Reject balance going negative (exit 125)

**CooperativeClose with payments (2 tests)**
- Close with A having sent to B
- Reject close when balance goes negative (exit 133)

**Uncooperative close (7 tests)**
- Start uncooperative close
- Reject double uncooperative close (exit 147)
- Allow challenge by counterparty
- Reject challenge by same party (exit 152)
- Reject challenge with non-superseding seqnos (exit 156)
- Finish uncooperative close after timeout
- Reject finish before timeout (exit 170)

**External messages (2 tests)**
- Cooperative close via external
- Cooperative commit via external

**GET methods (4 tests)**
- Return UNINITED state before init
- Return OPEN state after init
- Return CLOSURE_STARTED after uncooperative close
- Return channel data tuple

**Edge cases (3 tests)**
- uint64 seqno values (> uint32 max)
- Commit cancels active quarantine when seqnos supersede
- Reject top-up with wrong isA flag (exit 111)

**Security regression (6 tests)**
- F1: Reject cooperativeCommit replay with same seqno (exit 123)
- F1: Reject withdrawal regress with absolute accounting (exit 128)
- F2: Reject old cooperativeClose after commit advances seqno (exit 136)
- F3: Reject uncooperative close with inconsistent semichannels (exit 148)
- F5: Reject challenge that regresses a seqno (exit 156)
- F6: Reject topUp during quarantine (exit 113)

## E2E mainnet tests

3 additional tests run against TON mainnet (requires funded wallets):

```bash
source .env && npx vitest run -c test/e2e/vitest.config.ts
```

- **happy-path**: deploy -> init -> commit -> commit+withdraw -> close -> reopen
- **offchain-payments**: 800 bidirectional payments (400 A->B, 400 B->A) -> cooperativeClose
- **dispute**: deploy -> init -> startUncooperativeClose -> quarantine -> finishUncooperativeClose

## Gas costs (measured on mainnet)

| Operation | Gas | Notes |
|-----------|-----|-------|
| deployAndTopUp | ~0.02 TON | Covers storageFee + fwd_fee |
| topUp | ~0.008 TON | Surplus refunded |
| initChannel | ~0.008 TON | |
| cooperativeCommit | ~0.008 TON | |
| cooperativeClose | ~0.008 TON | 2 outbound messages |
| startUncooperativeClose | ~0.008 TON | |
| challengeQuarantinedState | ~0.008 TON | |
| finishUncooperativeClose | ~0.008 TON | 2 outbound messages |
| **Off-chain payment** | **0 TON** | 12-14ms per payment |

## License

MIT
