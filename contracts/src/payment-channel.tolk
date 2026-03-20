import "@stdlib/gas-payments"
import "@stdlib/tvm-lowlevel"
import "@stdlib/tvm-dicts"
import "errors.tolk"
import "fees.tolk"
import "messages.tolk"
import "storage.tolk"
import "utils.tolk"

// ============================================================
// Helper: send payout message (TON-only)
// ============================================================
fun sendPayout(dest: address, amount: int, chId: int, mode: int) {
    sendRawMessage(beginCell()
        .storeUint(0x10, 6)
        .storeAddress(dest)
        .storeCoins(amount)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeUint(OP_CHANNEL_CLOSED, 32)
        .storeUint(chId, 128)
        .endCell(), mode);
}

fun sendWithdrawMsg(dest: slice, amount: int, chId: int) {
    sendRawMessage(beginCell()
        .storeUint(0x10, 6)
        .storeSlice(dest)
        .storeCoins(amount)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeUint(OP_WITHDRAW_NOTIFICATION, 32)
        .storeUint(chId, 128)
        .endCell(), 1 + 2);  // pay fees separately + ignore errors
}

fun sendExcess(dest: slice) {
    sendRawMessage(beginCell()
        .storeUint(0x10, 6)
        .storeSlice(dest)
        .storeCoins(0)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
        .storeUint(OP_EXCESSES, 32)
        .endCell(), SEND_MODE_CARRY_ALL_BALANCE + SEND_MODE_IGNORE_ERRORS);
}

// ============================================================
// Helper: close channel and distribute funds (D18: dust limit)
// ============================================================
fun closeChannel() {
    var pcs: slice = paymentConfig.beginParse();
    var storageFee: int = pcs.loadCoins();
    var addrA: address = pcs.loadAddress();
    var addrB: address = pcs.loadAddress();

    var balA: int = calcA();
    var balB: int = calcB();

    // Clamp negative balances
    if (balA < 0) {
        balB += balA;
        balA = 0;
    }
    if (balB < 0) {
        balA += balB;
        balB = 0;
    }

    // Dust limit: redirect tiny payouts to counterparty
    if (balA < DUST_LIMIT) {
        balB += balA;
        balA = 0;
    }
    if (balB < DUST_LIMIT) {
        balA += balB;
        balB = 0;
    }

    // Send payouts
    if (balB > 0) {
        sendPayout(addrB, balB, channelId, SEND_MODE_IGNORE_ERRORS);
    }
    if (balA > 0) {
        sendPayout(addrA, balA, channelId, SEND_MODE_CARRY_ALL_BALANCE + SEND_MODE_IGNORE_ERRORS);
    }

    // Reset to UNINITED for reopen
    inited = false as int;
    depositA = 0;
    depositB = 0;
    withdrawnA = 0;
    withdrawnB = 0;
    sentA = 0;
    sentB = 0;
    quarantine = null;
    saveStorage();
}

// ============================================================
// Parse payment config and get addresses
// ============================================================
fun getPaymentAddresses(): (int, slice, slice) {
    var pcs: slice = paymentConfig.beginParse();
    var storageFee: int = pcs.loadCoins();
    var addrA: slice = pcs.loadAddress() as slice;
    var addrB: slice = pcs.loadAddress() as slice;
    return (storageFee, addrA, addrB);
}

// ============================================================
// topUp — deposit funds into channel
// ============================================================
fun topUp(myBalance: int, msgValue: int, msg: slice, senderAddr: address) {
    loadStorage(STORAGE_FULL);
    assert(quarantine == null) throw ERROR_TOPUP_QUARANTINE_ACTIVE;
    var isA: int = msg.loadInt(1);
    var amount: int = msg.loadCoins();

    // Verify sender matches party address
    var pcs: slice = paymentConfig.beginParse();
    var storageFee: int = pcs.loadCoins();
    var addrA: address = pcs.loadAddress();
    var addrB: address = pcs.loadAddress();
    if (isA) {
        assert(senderAddr == addrA) throw ERROR_TOPUP_ADDRESS_MISMATCH;
    } else {
        assert(senderAddr == addrB) throw ERROR_TOPUP_ADDRESS_MISMATCH;
    }

    // Add declared amount to deposit
    if (isA) {
        depositA += amount;
    } else {
        depositB += amount;
    }

    // Verify contract has enough funds
    assert(calcA() + calcB() + storageFee <= myBalance) throw ERROR_TOPUP_NO_VALUE;

    saveStorage();

    // Excess pattern: reserve what contract needs, send back the rest
    reserveToncoinsOnBalance(storageFee + calcA() + calcB(), RESERVE_MODE_AT_MOST);
    sendExcess(senderAddr as slice);
}

// ============================================================
// initChannel — initialize (single-signed, like v1)
// ============================================================
fun initChannel(myBalance: int, msg: slice) {
    loadStorage(STORAGE_FULL);
    assert(inited == 0) throw ERROR_ALREADY_INITED;

    var isA: int = msg.loadInt(1);
    var signature: slice = msg.loadBits(512);
    assert(isSignatureValid(msg.hash(), signature, isA ? keyA : keyB)) throw ERROR_INIT_SIG_FAILED;
    assert(msg.loadUint(32) == TAG_INIT) throw ERROR_INIT_CHANNEL_ID_MISMATCH;
    assert(channelId == msg.loadUint(128)) throw ERROR_INIT_CHANNEL_ID_MISMATCH;

    var setBalanceA: int = msg.loadCoins();
    var setBalanceB: int = msg.loadCoins();
    assert((setBalanceA >= depositA) & (setBalanceB >= depositB)) throw ERROR_INIT_DEPOSIT_MISMATCH;

    depositA = setBalanceA;
    depositB = setBalanceB;

    var pcs: slice = paymentConfig.beginParse();
    var storageFee: int = pcs.loadCoins();
    assert(depositA + depositB + storageFee <= myBalance) throw ERROR_INIT_DEPOSIT_MISMATCH;

    inited = true as int;
    saveStorage();
}

// ============================================================
// cooperativeClose — dual-signed close
// ============================================================
fun cooperativeClose(msg: slice) {
    loadStorage(STORAGE_FULL);
    assert(inited != 0) throw ERROR_CLOSE_NOT_OPEN;

    var sigA: slice = msg.loadRef().beginParse();
    var sigB: slice = msg.loadRef().beginParse();
    var hash: int = msg.hash();

    assert(isSignatureValid(hash, sigA, keyA)) throw ERROR_CLOSE_SIG_A_FAILED;
    assert(isSignatureValid(hash, sigB, keyB)) throw ERROR_CLOSE_SIG_B_FAILED;

    assert(msg.loadUint(32) == TAG_COOPERATIVE_CLOSE) throw ERROR_CLOSE_CHANNEL_ID_MISMATCH;
    assert(channelId == msg.loadUint(128)) throw ERROR_CLOSE_CHANNEL_ID_MISMATCH;

    var closeSeqnoA: int = msg.loadUint(64);
    var closeSeqnoB: int = msg.loadUint(64);
    assert(closeSeqnoA >= commitedSeqnoA) throw ERROR_CLOSE_SEQNO_A_REGRESS;
    assert(closeSeqnoB >= commitedSeqnoB) throw ERROR_CLOSE_SEQNO_B_REGRESS;

    var newSentA: int = msg.loadCoins();
    var newSentB: int = msg.loadCoins();

    sentA = newSentA;
    sentB = newSentB;

    assert(calcA() >= 0) throw ERROR_CLOSE_BALANCE_A_NEGATIVE;
    assert(calcB() >= 0) throw ERROR_CLOSE_BALANCE_B_NEGATIVE;

    acceptExternalMessage();
    closeChannel();
}

// ============================================================
// cooperativeCommit — dual-signed state update + optional withdrawal
// ============================================================
fun cooperativeCommit(msg: slice) {
    loadStorage(STORAGE_FULL);
    assert(inited != 0) throw ERROR_COMMIT_NOT_OPEN;

    var sigA: slice = msg.loadRef().beginParse();
    var sigB: slice = msg.loadRef().beginParse();
    var hash: int = msg.hash();

    assert(isSignatureValid(hash, sigA, keyA)) throw ERROR_COMMIT_SIG_A_FAILED;
    assert(isSignatureValid(hash, sigB, keyB)) throw ERROR_COMMIT_SIG_B_FAILED;

    assert(msg.loadUint(32) == TAG_COOPERATIVE_COMMIT) throw ERROR_COMMIT_CHANNEL_ID_MISMATCH;
    assert(channelId == msg.loadUint(128)) throw ERROR_COMMIT_CHANNEL_ID_MISMATCH;

    var newSeqnoA: int = msg.loadUint(64);
    var newSeqnoB: int = msg.loadUint(64);
    assert(newSeqnoA > commitedSeqnoA) throw ERROR_COMMIT_SEQNO_A_REGRESS;
    assert(newSeqnoB > commitedSeqnoB) throw ERROR_COMMIT_SEQNO_B_REGRESS;

    var newSentA: int = msg.loadCoins();
    var newSentB: int = msg.loadCoins();
    var newWithdrawA: int = msg.loadCoins();
    var newWithdrawB: int = msg.loadCoins();

    // Update sent values
    sentA = newSentA;
    sentB = newSentB;

    // Process withdrawals (absolute accounting — F1 fix)
    assert(newWithdrawA >= withdrawnA) throw ERROR_COMMIT_WITHDRAW_A_REGRESS;
    assert(newWithdrawB >= withdrawnB) throw ERROR_COMMIT_WITHDRAW_B_REGRESS;
    var deltaA: int = newWithdrawA - withdrawnA;
    var deltaB: int = newWithdrawB - withdrawnB;
    withdrawnA = newWithdrawA;
    withdrawnB = newWithdrawB;

    // Verify balances stay non-negative after all updates
    assert(calcA() >= 0) throw ERROR_COMMIT_BALANCE_A_NEGATIVE;
    assert(calcB() >= 0) throw ERROR_COMMIT_BALANCE_B_NEGATIVE;

    // Send withdrawal payouts
    if ((deltaA > 0) | (deltaB > 0)) {
        var (storageFee, addrA, addrB) = getPaymentAddresses();
        if (deltaA > 0) {
            sendWithdrawMsg(addrA, deltaA, channelId);
        }
        if (deltaB > 0) {
            sendWithdrawMsg(addrB, deltaB, channelId);
        }
    }

    // Update seqnos
    commitedSeqnoA = newSeqnoA;
    commitedSeqnoB = newSeqnoB;

    // If quarantine active and new seqnos supersede, cancel it
    if (!(quarantine == null)) {
        var qs: slice = quarantine!!.beginParse();
        var qSeqnoA: int = qs.loadUint(64);
        qs.loadCoins();
        qs.loadUint(256);
        var qSeqnoB: int = qs.loadUint(64);
        if ((newSeqnoA > qSeqnoA) | (newSeqnoB > qSeqnoB)) {
            quarantine = null;
        }
    }

    acceptExternalMessage();
    saveStorage();
}

// ============================================================
// Parse a signed semichannel: signature(512) + tag(32) + channelId(128) + seqno(64) + sent(coins) + condHash(256)
// Returns (seqno, sent, conditionalsHash)
// ============================================================
// Signed semichannel layout: signature(512 bits) + ^(tag + channelId + seqno + sent + condHash)
fun parseSemichannel(cs: slice, expectedKey: int, sigError: int, channelIdError: int): (int, int, int) {
    var sig: slice = cs.loadBits(512);
    var body: slice = cs.loadRef().beginParse();
    assert(isSignatureValid(body.hash(), sig, expectedKey)) throw sigError;
    assert(body.loadUint(32) == TAG_STATE) throw channelIdError;
    assert(channelId == body.loadUint(128)) throw channelIdError;
    var seqno: int = body.loadUint(64);
    var sent: int = body.loadCoins();
    var condHash: int = body.loadUint(256);
    return (seqno, sent, condHash);
}

// ============================================================
// startUncooperativeClose — begin dispute
// ============================================================
fun startUncooperativeClose(msg: slice) {
    loadStorage(STORAGE_WITH_SEQNOS);
    assert(inited != 0) throw ERROR_UNCOOP_NOT_OPEN;
    assert(quarantine == null) throw ERROR_UNCOOP_QUARANTINE_ACTIVE;

    var signedByA: int = msg.loadInt(1);
    var signature: slice = msg.loadBits(512);
    assert(isSignatureValid(msg.hash(), signature, signedByA ? keyA : keyB)) throw ERROR_UNCOOP_OUTER_SIG_FAILED;
    assert(msg.loadUint(32) == TAG_START_UNCOOPERATIVE_CLOSE) throw ERROR_UNCOOP_CHANNEL_ID_MISMATCH;
    assert(channelId == msg.loadUint(128)) throw ERROR_UNCOOP_CHANNEL_ID_MISMATCH;

    var schA: slice = msg.loadRef().beginParse();
    var schB: slice = msg.loadRef().beginParse();

    var (seqnoA, sentAmtA, condHashA) = parseSemichannel(schA, keyA, ERROR_UNCOOP_SIG_A_FAILED, ERROR_UNCOOP_CHANNEL_ID_MISMATCH);
    var (seqnoB, sentAmtB, condHashB) = parseSemichannel(schB, keyB, ERROR_UNCOOP_SIG_B_FAILED, ERROR_UNCOOP_CHANNEL_ID_MISMATCH);

    assert(seqnoA >= commitedSeqnoA) throw ERROR_UNCOOP_SEQNO_A_REGRESS;
    assert(seqnoB >= commitedSeqnoB) throw ERROR_UNCOOP_SEQNO_B_REGRESS;

    // F3: verify submitted semichannels produce non-negative balances
    assert(depositA + sentAmtB >= sentAmtA + withdrawnA) throw ERROR_UNCOOP_BALANCE_A_NEGATIVE;
    assert(depositB + sentAmtA >= sentAmtB + withdrawnB) throw ERROR_UNCOOP_BALANCE_B_NEGATIVE;

    // Store quarantine: stateA + stateB + metadata (F4: add originalStart)
    quarantine = beginCell()
        .storeUint(seqnoA, 64).storeCoins(sentAmtA).storeUint(condHashA, 256)
        .storeUint(seqnoB, 64).storeCoins(sentAmtB).storeUint(condHashB, 256)
        .storeUint(blockchain.now(), 32)  // originalStart
        .storeUint(blockchain.now(), 32)  // lastChallengeTime
        .storeInt(signedByA, 1)
        .storeInt(false as int, 1)
        .endCell();
    saveStorage();
}

// ============================================================
// challengeQuarantinedState — counterparty submits newer state
// ============================================================
fun challengeQuarantinedState(msg: slice) {
    loadStorage(STORAGE_WITH_SEQNOS);
    assert(!(quarantine == null)) throw ERROR_CHALLENGE_NOT_IN_CLOSURE;

    var challengedByA: int = msg.loadInt(1);
    var signature: slice = msg.loadBits(512);
    assert(isSignatureValid(msg.hash(), signature, challengedByA ? keyA : keyB)) throw ERROR_CHALLENGE_OUTER_SIG_FAILED;
    assert(msg.loadUint(32) == TAG_CHALLENGE_QUARANTINE) throw ERROR_CHALLENGE_CHANNEL_ID_MISMATCH;
    assert(channelId == msg.loadUint(128)) throw ERROR_CHALLENGE_CHANNEL_ID_MISMATCH;

    var schA: slice = msg.loadRef().beginParse();
    var schB: slice = msg.loadRef().beginParse();

    var (seqnoA, sentAmtA, condHashA) = parseSemichannel(schA, keyA, ERROR_CHALLENGE_SIG_A_FAILED, ERROR_CHALLENGE_CHANNEL_ID_MISMATCH);
    var (seqnoB, sentAmtB, condHashB) = parseSemichannel(schB, keyB, ERROR_CHALLENGE_SIG_B_FAILED, ERROR_CHALLENGE_CHANNEL_ID_MISMATCH);

    // Read quarantined state (F4: added originalStart field)
    var qs: slice = quarantine!!.beginParse();
    var qSeqnoA: int = qs.loadUint(64);
    var qSentA: int = qs.loadCoins();
    var qCondHashA: int = qs.loadUint(256);
    var qSeqnoB: int = qs.loadUint(64);
    var qSentB: int = qs.loadCoins();
    var qCondHashB: int = qs.loadUint(256);
    var originalStart: int = qs.loadUint(32);
    var lastChallengeTime: int = qs.loadUint(32);
    var prevSignedByA: int = qs.loadInt(1);
    var wasChallenged: int = qs.loadInt(1);

    // Must be within per-round quarantine window (from last challenge)
    assert(lastChallengeTime + closureQuarantineDuration() > blockchain.now()) throw ERROR_CHALLENGE_QUARANTINE_EXPIRED;

    // F4: total dispute duration cap (3x quarantine duration from original start)
    assert(originalStart + 3 * closureQuarantineDuration() > blockchain.now()) throw ERROR_CHALLENGE_DISPUTE_EXPIRED;

    // Challenger must be counterparty
    assert(!(prevSignedByA == challengedByA)) throw ERROR_CHALLENGE_SAME_PARTY;

    // At least one seqno must strictly exceed quarantined
    assert((seqnoA > qSeqnoA) | (seqnoB > qSeqnoB)) throw ERROR_CHALLENGE_SEQNO_NOT_SUPERSEDE;

    // F5: neither seqno may regress
    assert(seqnoA >= qSeqnoA) throw ERROR_CHALLENGE_SEQNO_NOT_SUPERSEDE;
    assert(seqnoB >= qSeqnoB) throw ERROR_CHALLENGE_SEQNO_NOT_SUPERSEDE;

    // F3: verify submitted semichannels produce non-negative balances
    assert(depositA + sentAmtB >= sentAmtA + withdrawnA) throw ERROR_UNCOOP_BALANCE_A_NEGATIVE;
    assert(depositB + sentAmtA >= sentAmtB + withdrawnB) throw ERROR_UNCOOP_BALANCE_B_NEGATIVE;

    // Replace quarantine with new state, keep originalStart, update lastChallengeTime
    quarantine = beginCell()
        .storeUint(seqnoA, 64).storeCoins(sentAmtA).storeUint(condHashA, 256)
        .storeUint(seqnoB, 64).storeCoins(sentAmtB).storeUint(condHashB, 256)
        .storeUint(originalStart, 32)     // F4: keep original
        .storeUint(blockchain.now(), 32)  // F4: update lastChallengeTime
        .storeInt(challengedByA, 1)
        .storeInt(true as int, 1)
        .endCell();
    saveStorage();
}

// ============================================================
// settleConditionals — submit Merkle proof during settle period
// ============================================================
fun settleConditionals(msg: slice) {
    loadStorage(STORAGE_WITH_SEQNOS);
    assert(!(quarantine == null)) throw ERROR_SETTLE_TOO_EARLY;

    var isFromA: int = msg.loadInt(1);
    var signature: slice = msg.loadBits(512);
    assert(isSignatureValid(msg.hash(), signature, isFromA ? keyA : keyB)) throw ERROR_SETTLE_SIG_FAILED;
    assert(msg.loadUint(32) == TAG_SETTLE_CONDITIONALS) throw ERROR_SETTLE_CHANNEL_ID_MISMATCH;
    assert(channelId == msg.loadUint(128)) throw ERROR_SETTLE_CHANNEL_ID_MISMATCH;

    var conditionalsCell: cell = msg.loadRef();

    // Read quarantined state (F4: added originalStart/lastChallengeTime)
    var qs: slice = quarantine!!.beginParse();
    var seqnoA: int = qs.loadUint(64);
    var qSentA: int = qs.loadCoins();
    var condHashA: int = qs.loadUint(256);
    var seqnoB: int = qs.loadUint(64);
    var qSentB: int = qs.loadCoins();
    var condHashB: int = qs.loadUint(256);
    var originalStart: int = qs.loadUint(32);
    var lastChallengeTime: int = qs.loadUint(32);
    var stateCommitedByA: int = qs.loadInt(1);
    var wasChallenged: int = qs.loadInt(1);

    var quarantineFinished: int = lastChallengeTime + closureQuarantineDuration();
    assert(quarantineFinished <= blockchain.now()) throw ERROR_SETTLE_TOO_EARLY;
    assert(quarantineFinished + closureCloseDuration() > blockchain.now()) throw ERROR_SETTLE_TOO_LATE;

    // Verify Merkle proof: hash of provided cell must match stored conditionalsHash
    var targetHash: int = condHashA;
    var targetSent: int = qSentA;
    if (isFromA) {
        targetHash = condHashB;
        targetSent = qSentB;
    }
    assert(conditionalsCell.hash() == targetHash) throw ERROR_SETTLE_HASH_MISMATCH;

    // Process conditionals from the dict inside the cell
    var condSlice: slice = conditionalsCell.beginParse();
    var condDict: dict = condSlice.loadDict();
    var conditionalsToSettle: dict = condDict;

    // Iterate conditionals and execute
    var continuee: int = true as int;
    do {
        var (cid, condition, found) = conditionalsToSettle.uDictDeleteFirstAndGet(32);
        continuee = found as int;
        if (continuee) {
            var condS: slice = condition!!;
            var amount: int = condS.loadCoins();
            var executableCondition = castToContinuation(transformSliceToContinuation(condS));
            if (executableCondition(createEmptySlice())) {
                targetSent += amount;
            }
        }
    } while (!(~continuee));

    // Update quarantine with new sent and clear conditionalsHash (all settled)
    if (isFromA) {
        condHashB = 0;
        qSentB = targetSent;
    } else {
        condHashA = 0;
        qSentA = targetSent;
    }

    quarantine = beginCell()
        .storeUint(seqnoA, 64).storeCoins(qSentA).storeUint(condHashA, 256)
        .storeUint(seqnoB, 64).storeCoins(qSentB).storeUint(condHashB, 256)
        .storeUint(originalStart, 32)
        .storeUint(lastChallengeTime, 32)
        .storeInt(stateCommitedByA, 1)
        .storeInt(wasChallenged, 1)
        .endCell();
    saveStorage();
}

// ============================================================
// finishUncooperativeClose — finalize after full dispute period
// ============================================================
fun finishUncooperativeClose() {
    loadStorage(STORAGE_FULL);
    assert(!(quarantine == null)) throw ERROR_FINISH_NO_QUARANTINE;

    var qs: slice = quarantine!!.beginParse();
    var seqnoA: int = qs.loadUint(64);
    var qSentA: int = qs.loadCoins();
    var condHashA: int = qs.loadUint(256);
    var seqnoB: int = qs.loadUint(64);
    var qSentB: int = qs.loadCoins();
    var condHashB: int = qs.loadUint(256);
    var originalStart: int = qs.loadUint(32);
    var lastChallengeTime: int = qs.loadUint(32);
    var committedByA: int = qs.loadInt(1);
    var wasChallenged: int = qs.loadInt(1);

    assert(lastChallengeTime +
        closureQuarantineDuration() +
        closureCloseDuration() <= blockchain.now()) throw ERROR_FINISH_TOO_EARLY;

    // Apply quarantined sent values to balance
    sentA = qSentA;
    sentB = qSentB;

    // If not challenged, apply fine to the initiator
    if (~wasChallenged) {
        var fine: int = closureFine();
        if (committedByA) {
            sentA += fine;
        } else {
            sentB += fine;
        }
    }

    // Update seqnos
    commitedSeqnoA = seqnoA + 1;
    commitedSeqnoB = seqnoB + 1;

    closeChannel();
}

// ============================================================
// Message router
// ============================================================
fun recvInternal(myBalance: int, msgValue: int, msgFull: cell, msg: slice) {
    var op: int = msg.loadUint(32);

    // Parse sender address from full message
    var fullSlice: slice = msgFull.beginParse();
    fullSlice.loadUint(4);  // flags
    var senderAddr: address = fullSlice.loadAddress();

    if (op == OP_TOP_UP) {
        return topUp(myBalance, msgValue, msg, senderAddr);
    } else if (op == OP_INIT_CHANNEL) {
        return initChannel(myBalance, msg);
    } else if (op == OP_COOPERATIVE_CLOSE) {
        return cooperativeClose(msg);
    } else if (op == OP_COOPERATIVE_COMMIT) {
        return cooperativeCommit(msg);
    } else if (op == OP_START_UNCOOPERATIVE_CLOSE) {
        return startUncooperativeClose(msg);
    } else if (op == OP_CHALLENGE_QUARANTINE) {
        return challengeQuarantinedState(msg);
    } else if (op == OP_SETTLE_CONDITIONALS) {
        return settleConditionals(msg);
    } else if (op == OP_FINISH_UNCOOPERATIVE_CLOSE) {
        return finishUncooperativeClose();
    }
    throw 0xffff;
}

fun recvExternal(msg: slice) {
    var op: int = msg.loadUint(32);
    if (op == OP_COOPERATIVE_CLOSE) {
        return cooperativeClose(msg);
    } else if (op == OP_COOPERATIVE_COMMIT) {
        return cooperativeCommit(msg);
    }
    throw 0xffff;
}

// ============================================================
// Entry points
// ============================================================
fun onInternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
    return recvInternal(myBalance, msgValue, msgFull, msgBody);
}

fun onExternalMessage(myBalance: int, msgValue: int, msgFull: cell, msgBody: slice) {
    return recvExternal(msgBody);
}

// ============================================================
// GET methods
// ============================================================
get fun get_channel_state(): int {
    loadStorage(STORAGE_FULL);
    if (inited == 0) {
        return STATE_UNINITED;
    }
    if (quarantine == null) {
        return STATE_OPEN;
    }
    // Parse quarantine to check timing (F4: originalStart + lastChallengeTime)
    var qs: slice = quarantine!!.beginParse();
    qs.loadUint(64);     // seqnoA
    qs.loadCoins();      // sentA
    qs.loadUint(256);    // condHashA
    qs.loadUint(64);     // seqnoB
    qs.loadCoins();      // sentB
    qs.loadUint(256);    // condHashB
    qs.loadUint(32);     // originalStart (skip)
    var lastChallengeTime: int = qs.loadUint(32);

    if (lastChallengeTime + closureQuarantineDuration() > blockchain.now()) {
        return STATE_CLOSURE_STARTED;
    }
    if (lastChallengeTime + closureQuarantineDuration() + closureCloseDuration() > blockchain.now()) {
        return STATE_SETTLING_CONDITIONALS;
    }
    return STATE_AWAITING_FINALIZATION;
}

get fun get_channel_data() {
    loadStorage(STORAGE_FULL);
    var pcs: slice = paymentConfig.beginParse();
    var storageFee: int = pcs.loadCoins();
    var addrA: address = pcs.loadAddress();
    var addrB: address = pcs.loadAddress();

    return (get_channel_state(),
        [calcA(), calcB(), depositA, depositB, withdrawnA, withdrawnB],
        [keyA, keyB],
        channelId,
        closureConfig,
        [commitedSeqnoA, commitedSeqnoB],
        quarantine,
        [storageFee, addrA, addrB]);
}
