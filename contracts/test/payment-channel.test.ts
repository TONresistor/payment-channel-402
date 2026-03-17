import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, toNano, Address, contractAddress, StateInit } from '@ton/core';
import { sign, keyPairFromSeed, KeyPair } from '@ton/crypto';
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

// Load compiled v2 bytecode
const compiledJson = require('../build/payment-channel.json');
const CODE = Cell.fromBase64(compiledJson.codeBoc64);

// Opcodes (fixed hex, matching messages.tolk)
const OP_TOP_UP = 0x593e3893;
const OP_INIT_CHANNEL = 0x79ae99b5;
const OP_COOPERATIVE_CLOSE = 0xd2b1eeeb;
const OP_COOPERATIVE_COMMIT = 0x076bfdf1;
const OP_START_UNCOOPERATIVE_CLOSE = 0x8175e15d;
const OP_FINISH_UNCOOPERATIVE_CLOSE = 0x25432a91;
const OP_CHALLENGE_QUARANTINE = 0x9a77c0db;
const OP_SETTLE_CONDITIONALS = 0x56c39b4c;

// Signature tags
const TAG_INIT = 0x481ebc44;
const TAG_COOPERATIVE_CLOSE = 0x8243e9a3;
const TAG_COOPERATIVE_COMMIT = 0x4a390cac;
const TAG_START_UNCOOPERATIVE_CLOSE = 0x8c623692;
const TAG_CHALLENGE_QUARANTINE = 0xb8a21379;
const TAG_STATE = 0x50433453;

// Channel states
const STATE_UNINITED = 0;
const STATE_OPEN = 1;
const STATE_CLOSURE_STARTED = 2;

/**
 * Build v2 initial data cell.
 * Layout: inited(1) + ^Balance + keyA(256) + keyB(256) + id(128) + ^ClosureConfig
 *         + commitedSeqnoA(64) + commitedSeqnoB(64) + quarantine(Maybe) + ^PaymentConfig
 */
function buildDataCell(
    keyA: Buffer,
    keyB: Buffer,
    channelId: bigint,
    addrA: Address,
    addrB: Address,
    quarantineDuration: number = 600,
    fine: bigint = toNano('0.01'),
    closeDuration: number = 600,
    storageFee: bigint = toNano('0.05'),
): Cell {
    const balanceCell = beginCell()
        .storeCoins(0n) // depositA
        .storeCoins(0n) // depositB
        .storeCoins(0n) // withdrawnA
        .storeCoins(0n) // withdrawnB
        .storeCoins(0n) // sentA
        .storeCoins(0n) // sentB
        .endCell();

    const closureConfig = beginCell()
        .storeUint(quarantineDuration, 32)
        .storeCoins(fine)
        .storeUint(closeDuration, 32)
        .endCell();

    const paymentConfig = beginCell()
        .storeCoins(storageFee)
        .storeAddress(addrA)
        .storeAddress(addrB)
        .endCell();

    return beginCell()
        .storeBit(0)                    // inited = false
        .storeRef(balanceCell)
        .storeBuffer(keyA, 32)          // keyA (256 bits)
        .storeBuffer(keyB, 32)          // keyB (256 bits)
        .storeUint(channelId, 128)
        .storeRef(closureConfig)
        .storeUint(0, 64)              // commitedSeqnoA
        .storeUint(0, 64)              // commitedSeqnoB
        .storeBit(0)                    // quarantine = null
        .storeRef(paymentConfig)
        .endCell();
}

function getExitCode(transactions: any[], to: Address): number | undefined {
    for (const tx of transactions) {
        if (tx.inMessage?.info?.dest?.equals?.(to)) {
            const desc = tx.description;
            if (desc.type === 'generic' && desc.computePhase?.type === 'vm') {
                return desc.computePhase.exitCode;
            }
        }
    }
    return undefined;
}

describe('payment-channel v2', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let walletA: SandboxContract<TreasuryContract>;
    let walletB: SandboxContract<TreasuryContract>;
    let keyPairA: KeyPair;
    let keyPairB: KeyPair;
    let channelId: bigint;
    let channelAddress: Address;
    let stateInit: StateInit;

    beforeAll(async () => {
        keyPairA = keyPairFromSeed(Buffer.alloc(32, 1));
        keyPairB = keyPairFromSeed(Buffer.alloc(32, 2));
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        walletA = await blockchain.treasury('walletA');
        walletB = await blockchain.treasury('walletB');
        channelId = 42n;

        const data = buildDataCell(
            keyPairA.publicKey,
            keyPairB.publicKey,
            channelId,
            walletA.address,
            walletB.address,
        );

        stateInit = { code: CODE, data };
        channelAddress = contractAddress(0, stateInit);
    });

    // ============================================================
    // Helpers
    // ============================================================
    async function deploy(depositA: bigint = 0n) {
        // Deploy from walletA with initial topUp
        const result = await walletA.send({
            to: channelAddress,
            value: depositA + toNano('0.1'),
            init: stateInit,
            body: beginCell()
                .storeUint(OP_TOP_UP, 32)
                .storeBit(true) // isA
                .storeCoins(depositA) // amount
                .endCell(),
            bounce: false,
        });
        return result;
    }

    async function topUp(wallet: SandboxContract<TreasuryContract>, isA: boolean, amount: bigint) {
        return wallet.send({
            to: channelAddress,
            value: amount + toNano('0.05'),
            body: beginCell()
                .storeUint(OP_TOP_UP, 32)
                .storeBit(isA)
                .storeCoins(amount) // explicit amount
                .endCell(),
        });
    }

    async function initChannel(depositA: bigint, depositB: bigint) {
        const initPayload = beginCell()
            .storeUint(TAG_INIT, 32)
            .storeUint(channelId, 128)
            .storeCoins(depositA)
            .storeCoins(depositB)
            .endCell();

        const sigInit = sign(initPayload.hash(), keyPairA.secretKey);

        const initBody = beginCell()
            .storeUint(OP_INIT_CHANNEL, 32)
            .storeBit(true) // isA
            .storeBuffer(Buffer.from(sigInit), 64)
            .storeUint(TAG_INIT, 32)
            .storeUint(channelId, 128)
            .storeCoins(depositA)
            .storeCoins(depositB)
            .endCell();

        return deployer.send({
            to: channelAddress,
            value: toNano('0.01'),
            body: initBody,
        });
    }

    async function deployTopUpAndInit(depositA: bigint, depositB: bigint = 0n) {
        await deploy(depositA);
        if (depositB > 0n) {
            await topUp(walletB, false, depositB);
        }
        const r = await initChannel(depositA, depositB);
        expect(getExitCode(r.transactions, channelAddress)).toBe(0);
    }

    function buildCooperativeCloseBody(finalSentA: bigint, finalSentB: bigint) {
        const payload = beginCell()
            .storeUint(TAG_COOPERATIVE_CLOSE, 32)
            .storeUint(channelId, 128)
            .storeCoins(finalSentA)
            .storeCoins(finalSentB)
            .endCell();

        const hash = payload.hash();
        const sigA = sign(hash, keyPairA.secretKey);
        const sigB = sign(hash, keyPairB.secretKey);

        return beginCell()
            .storeUint(OP_COOPERATIVE_CLOSE, 32)
            .storeRef(beginCell().storeBuffer(Buffer.from(sigA), 64).endCell())
            .storeRef(beginCell().storeBuffer(Buffer.from(sigB), 64).endCell())
            .storeUint(TAG_COOPERATIVE_CLOSE, 32)
            .storeUint(channelId, 128)
            .storeCoins(finalSentA)
            .storeCoins(finalSentB)
            .endCell();
    }

    function buildCooperativeCommitBody(
        seqnoA: bigint, seqnoB: bigint,
        sentA: bigint, sentB: bigint,
        withdrawA: bigint, withdrawB: bigint,
    ) {
        const payload = beginCell()
            .storeUint(TAG_COOPERATIVE_COMMIT, 32)
            .storeUint(channelId, 128)
            .storeUint(seqnoA, 64)
            .storeUint(seqnoB, 64)
            .storeCoins(sentA)
            .storeCoins(sentB)
            .storeCoins(withdrawA)
            .storeCoins(withdrawB)
            .endCell();

        const hash = payload.hash();
        const sigA = sign(hash, keyPairA.secretKey);
        const sigB = sign(hash, keyPairB.secretKey);

        return beginCell()
            .storeUint(OP_COOPERATIVE_COMMIT, 32)
            .storeRef(beginCell().storeBuffer(Buffer.from(sigA), 64).endCell())
            .storeRef(beginCell().storeBuffer(Buffer.from(sigB), 64).endCell())
            .storeUint(TAG_COOPERATIVE_COMMIT, 32)
            .storeUint(channelId, 128)
            .storeUint(seqnoA, 64)
            .storeUint(seqnoB, 64)
            .storeCoins(sentA)
            .storeCoins(sentB)
            .storeCoins(withdrawA)
            .storeCoins(withdrawB)
            .endCell();
    }

    function buildSignedSemichannel(keyPair: KeyPair, seqno: bigint, sent: bigint, condHash: bigint = 0n): Cell {
        // State body is in a ref to avoid exceeding 1023 bits (sig=512 + body > 1023)
        const stateBody = beginCell()
            .storeUint(TAG_STATE, 32)
            .storeUint(channelId, 128)
            .storeUint(seqno, 64)
            .storeCoins(sent)
            .storeUint(condHash, 256)
            .endCell();

        const sig = sign(stateBody.hash(), keyPair.secretKey);

        // Signature in root cell, state body as ref
        return beginCell()
            .storeBuffer(Buffer.from(sig), 64)
            .storeRef(stateBody)
            .endCell();
    }

    function buildStartUncooperativeClose(signedByA: boolean, seqnoA: bigint, sentA: bigint, seqnoB: bigint, sentB: bigint) {
        const schA = buildSignedSemichannel(keyPairA, seqnoA, sentA);
        const schB = buildSignedSemichannel(keyPairB, seqnoB, sentB);

        const outerPayload = beginCell()
            .storeUint(TAG_START_UNCOOPERATIVE_CLOSE, 32)
            .storeUint(channelId, 128)
            .storeRef(schA)
            .storeRef(schB)
            .endCell();

        const keyPair = signedByA ? keyPairA : keyPairB;
        const sig = sign(outerPayload.hash(), keyPair.secretKey);

        return beginCell()
            .storeUint(OP_START_UNCOOPERATIVE_CLOSE, 32)
            .storeBit(signedByA)
            .storeBuffer(Buffer.from(sig), 64)
            .storeUint(TAG_START_UNCOOPERATIVE_CLOSE, 32)
            .storeUint(channelId, 128)
            .storeRef(schA)
            .storeRef(schB)
            .endCell();
    }

    function buildChallengeBody(challengedByA: boolean, seqnoA: bigint, sentA: bigint, seqnoB: bigint, sentB: bigint) {
        const schA = buildSignedSemichannel(keyPairA, seqnoA, sentA);
        const schB = buildSignedSemichannel(keyPairB, seqnoB, sentB);

        const outerPayload = beginCell()
            .storeUint(TAG_CHALLENGE_QUARANTINE, 32)
            .storeUint(channelId, 128)
            .storeRef(schA)
            .storeRef(schB)
            .endCell();

        const keyPair = challengedByA ? keyPairA : keyPairB;
        const sig = sign(outerPayload.hash(), keyPair.secretKey);

        return beginCell()
            .storeUint(OP_CHALLENGE_QUARANTINE, 32)
            .storeBit(challengedByA)
            .storeBuffer(Buffer.from(sig), 64)
            .storeUint(TAG_CHALLENGE_QUARANTINE, 32)
            .storeUint(channelId, 128)
            .storeRef(schA)
            .storeRef(schB)
            .endCell();
    }

    // ============================================================
    // 1. Basic lifecycle: deploy, topUp, init, close, reopen
    // ============================================================
    describe('Basic lifecycle', () => {
        it('should deploy contract', async () => {
            const r = await deploy(toNano('1'));
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should top up party A', async () => {
            await deploy(0n);
            const r = await topUp(walletA, true, toNano('1'));
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should top up party B', async () => {
            await deploy(0n);
            const r = await topUp(walletB, false, toNano('0.5'));
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should init channel', async () => {
            await deploy(toNano('1'));
            const r = await initChannel(toNano('1'), 0n);
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should reject double init', async () => {
            await deployTopUpAndInit(toNano('1'));
            const r = await initChannel(toNano('1'), 0n);
            expect(getExitCode(r.transactions, channelAddress)).toBe(100); // ERROR_ALREADY_INITED
        });

        it('should cooperative close', async () => {
            await deployTopUpAndInit(toNano('1'));
            const body = buildCooperativeCloseBody(0n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should reopen after close', async () => {
            await deployTopUpAndInit(toNano('1'));
            const closeBody = buildCooperativeCloseBody(0n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body: closeBody });

            // Re-topup and re-init
            await topUp(walletA, true, toNano('2'));
            const r = await initChannel(toNano('2'), 0n);
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });
    });

    // ============================================================
    // 2. CooperativeCommit
    // ============================================================
    describe('CooperativeCommit', () => {
        it('should commit state without withdrawal', async () => {
            await deployTopUpAndInit(toNano('1'));
            const body = buildCooperativeCommitBody(1n, 1n, 0n, 0n, 0n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should commit with sent values', async () => {
            await deployTopUpAndInit(toNano('1'));
            const body = buildCooperativeCommitBody(1n, 1n, toNano('0.3'), toNano('0'), 0n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should commit with withdrawal for A', async () => {
            await deployTopUpAndInit(toNano('1'));
            const body = buildCooperativeCommitBody(1n, 1n, 0n, 0n, toNano('0.5'), 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.05'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should reject seqno regress', async () => {
            await deployTopUpAndInit(toNano('1'));
            // First commit with seqno 5
            const body1 = buildCooperativeCommitBody(5n, 5n, 0n, 0n, 0n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body: body1 });
            // Try to commit with seqno 3 — should fail
            const body2 = buildCooperativeCommitBody(3n, 3n, 0n, 0n, 0n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body: body2 });
            expect(getExitCode(r.transactions, channelAddress)).toBe(123); // ERROR_COMMIT_SEQNO_A_REGRESS
        });

        it('should reject balance going negative', async () => {
            await deployTopUpAndInit(toNano('1'));
            // Withdraw more than deposited
            const body = buildCooperativeCommitBody(1n, 1n, 0n, 0n, toNano('2'), 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.05'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(125); // ERROR_COMMIT_BALANCE_A_NEGATIVE
        });
    });

    // ============================================================
    // 3. Cooperative close with sent values
    // ============================================================
    describe('CooperativeClose with payments', () => {
        it('should close with A having sent to B', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            // A sent 0.5 TON to B
            const body = buildCooperativeCloseBody(toNano('0.5'), 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should reject close when balance goes negative', async () => {
            await deployTopUpAndInit(toNano('1'));
            // A sent more than deposited
            const body = buildCooperativeCloseBody(toNano('2'), 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(133); // ERROR_CLOSE_BALANCE_A_NEGATIVE
        });
    });

    // ============================================================
    // 4. Uncooperative close flow
    // ============================================================
    describe('Uncooperative close', () => {
        it('should start uncooperative close', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            const body = buildStartUncooperativeClose(true, 1n, 0n, 1n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should reject double uncooperative close', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            const body = buildStartUncooperativeClose(true, 1n, 0n, 1n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            // Second attempt should fail (quarantine already active)
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(147); // ERROR_UNCOOP_QUARANTINE_ACTIVE
        });

        it('should allow challenge by counterparty', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            // A starts uncooperative close
            const startBody = buildStartUncooperativeClose(true, 1n, 0n, 1n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body: startBody });
            // B challenges with higher seqnos
            const challengeBody = buildChallengeBody(false, 2n, 0n, 2n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body: challengeBody });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should reject challenge by same party', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            const startBody = buildStartUncooperativeClose(true, 1n, 0n, 1n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body: startBody });
            // A tries to challenge own state — should fail
            const challengeBody = buildChallengeBody(true, 2n, 0n, 2n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body: challengeBody });
            expect(getExitCode(r.transactions, channelAddress)).toBe(152); // ERROR_CHALLENGE_SAME_PARTY
        });

        it('should reject challenge with non-superseding seqnos', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            const startBody = buildStartUncooperativeClose(true, 5n, 0n, 5n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body: startBody });
            // B challenges with same seqnos — should fail
            const challengeBody = buildChallengeBody(false, 5n, 0n, 5n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body: challengeBody });
            expect(getExitCode(r.transactions, channelAddress)).toBe(156); // ERROR_CHALLENGE_SEQNO_NOT_SUPERSEDE
        });

        it('should finish uncooperative close after timeout', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            const startBody = buildStartUncooperativeClose(true, 1n, toNano('0.3'), 1n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body: startBody });

            // Fast-forward past quarantine + close duration (600 + 600 = 1200 seconds)
            blockchain.now = Math.floor(Date.now() / 1000) + 1300;

            const finishBody = beginCell().storeUint(OP_FINISH_UNCOOPERATIVE_CLOSE, 32).endCell();
            const r = await deployer.send({ to: channelAddress, value: toNano('0.05'), body: finishBody });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });

        it('should reject finish before timeout', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            const startBody = buildStartUncooperativeClose(true, 1n, 0n, 1n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body: startBody });

            // Don't fast-forward
            const finishBody = beginCell().storeUint(OP_FINISH_UNCOOPERATIVE_CLOSE, 32).endCell();
            const r = await deployer.send({ to: channelAddress, value: toNano('0.05'), body: finishBody });
            expect(getExitCode(r.transactions, channelAddress)).toBe(170); // ERROR_FINISH_TOO_EARLY
        });
    });

    // ============================================================
    // 5. External messages
    // ============================================================
    describe('External messages', () => {
        it('should cooperative close via external', async () => {
            await deployTopUpAndInit(toNano('1'));
            const body = buildCooperativeCloseBody(0n, 0n);

            let result;
            try {
                result = await blockchain.sendMessage({
                    info: { type: 'external-in', dest: channelAddress, importFee: 0n },
                    body,
                    init: undefined,
                });
            } catch (e: any) {
                // External messages throw on failure
            }

            if (result) {
                const exitCode = getExitCode(result.transactions, channelAddress);
                expect(exitCode).toBe(0);
            }
        });

        it('should cooperative commit via external', async () => {
            await deployTopUpAndInit(toNano('1'));
            const body = buildCooperativeCommitBody(1n, 1n, 0n, 0n, 0n, 0n);

            let result;
            try {
                result = await blockchain.sendMessage({
                    info: { type: 'external-in', dest: channelAddress, importFee: 0n },
                    body,
                    init: undefined,
                });
            } catch (e: any) {
                // External messages throw on failure
            }

            if (result) {
                const exitCode = getExitCode(result.transactions, channelAddress);
                expect(exitCode).toBe(0);
            }
        });
    });

    // ============================================================
    // 6. GET methods
    // ============================================================
    describe('GET methods', () => {
        it('should return UNINITED state before init', async () => {
            await deploy(0n);
            const provider = blockchain.provider(channelAddress);
            const { stack } = await provider.get('get_channel_state', []);
            expect(stack.readNumber()).toBe(STATE_UNINITED);
        });

        it('should return OPEN state after init', async () => {
            await deployTopUpAndInit(toNano('1'));
            const provider = blockchain.provider(channelAddress);
            const { stack } = await provider.get('get_channel_state', []);
            expect(stack.readNumber()).toBe(STATE_OPEN);
        });

        it('should return CLOSURE_STARTED after uncooperative close', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            const body = buildStartUncooperativeClose(true, 1n, 0n, 1n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body });

            const provider = blockchain.provider(channelAddress);
            const { stack } = await provider.get('get_channel_state', []);
            expect(stack.readNumber()).toBe(STATE_CLOSURE_STARTED);
        });

        it('should return channel data', async () => {
            await deployTopUpAndInit(toNano('1'));
            const provider = blockchain.provider(channelAddress);
            const { stack } = await provider.get('get_channel_data', []);
            const state = stack.readNumber();
            expect(state).toBe(STATE_OPEN);
        });
    });

    // ============================================================
    // 7. uint64 seqnos
    // ============================================================
    describe('uint64 seqnos', () => {
        it('should handle large seqno values', async () => {
            await deployTopUpAndInit(toNano('1'));
            const largeSeqno = (1n << 32n) + 1n; // > uint32 max
            const body = buildCooperativeCommitBody(largeSeqno, largeSeqno, 0n, 0n, 0n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);
        });
    });

    // ============================================================
    // 8. Cooperative commit cancels quarantine
    // ============================================================
    describe('Commit cancels quarantine', () => {
        it('should cancel quarantine when seqnos supersede', async () => {
            await deployTopUpAndInit(toNano('1'), toNano('1'));
            // Start uncooperative close with seqno 1
            const startBody = buildStartUncooperativeClose(true, 1n, 0n, 1n, 0n);
            await deployer.send({ to: channelAddress, value: toNano('0.01'), body: startBody });

            // Cooperative commit with seqno 5 should cancel quarantine
            const commitBody = buildCooperativeCommitBody(5n, 5n, 0n, 0n, 0n, 0n);
            const r = await deployer.send({ to: channelAddress, value: toNano('0.01'), body: commitBody });
            expect(getExitCode(r.transactions, channelAddress)).toBe(0);

            // State should be OPEN (quarantine cancelled)
            const provider = blockchain.provider(channelAddress);
            const { stack } = await provider.get('get_channel_state', []);
            expect(stack.readNumber()).toBe(STATE_OPEN);
        });
    });

    // ============================================================
    // 9. Top-up address verification
    // ============================================================
    describe('Top-up address verification', () => {
        it('should reject top-up with wrong isA flag', async () => {
            await deploy(0n);
            // walletB sends with isA=true — should fail
            const r = await walletB.send({
                to: channelAddress,
                value: toNano('1'),
                body: beginCell()
                    .storeUint(OP_TOP_UP, 32)
                    .storeBit(true) // isA=true but sender is B
                    .storeCoins(toNano('0.5'))
                    .endCell(),
            });
            expect(getExitCode(r.transactions, channelAddress)).toBe(111); // ERROR_TOPUP_ADDRESS_MISMATCH
        });
    });
});
