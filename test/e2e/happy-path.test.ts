/**
 * E2E mainnet — Happy path
 *
 * Tests: deployAndTopUp, init, cooperativeCommit, cooperativeCommit+withdraw,
 *        cooperativeClose, getOnchainState, reopen
 *
 * Run: npx vitest run test/e2e/happy-path.test.ts
 */

import { toNano } from "@ton/core";
import { describe, expect, it } from "vitest";
import {
  createChannel,
  getContext,
  sendAndWait,
  waitActive,
  waitDrained,
  waitForChannelState,
} from "./setup.js";

describe("e2e mainnet: happy path", { timeout: 120_000 }, () => {
  it("deploy → init → commit → commit+withdraw → close → reopen check", async () => {
    const ctx = await getContext();
    const { channel, address } = createChannel(ctx);
    const depositA = toNano("0.02");

    // Deploy + TopUp A
    await sendAndWait(ctx.walletA, () => channel.deployAndTopUp(ctx.senderA, true, depositA));
    await waitActive(ctx.client, address);

    // Init
    await sendAndWait(ctx.walletA, () => channel.init(ctx.senderA, depositA, 0n, ctx.keyPairA));
    let state = await waitForChannelState(channel, 1);
    expect(state.state).toBe(1);
    expect(state.balanceA).toBe(depositA);

    // CooperativeCommit #1
    const sentA = toNano("0.005");
    const sigCA1 = channel.signCommit(1n, 1n, sentA, 0n, ctx.keyPairA);
    const sigCB1 = channel.signCommit(1n, 1n, sentA, 0n, ctx.keyPairB);
    await sendAndWait(ctx.walletA, () =>
      channel.cooperativeCommit(ctx.senderA, 1n, 1n, sentA, 0n, sigCA1, sigCB1),
    );
    state = await waitForChannelState(channel, 1);
    expect(state.seqnoA).toBe(1);
    expect(state.seqnoB).toBe(1);

    // CooperativeCommit #2 + withdrawal
    const withdrawA = toNano("0.002");
    const sigCA2 = channel.signCommit(2n, 2n, sentA, 0n, ctx.keyPairA, withdrawA);
    const sigCB2 = channel.signCommit(2n, 2n, sentA, 0n, ctx.keyPairB, withdrawA);
    await sendAndWait(ctx.walletA, () =>
      channel.cooperativeCommit(ctx.senderA, 2n, 2n, sentA, 0n, sigCA2, sigCB2, withdrawA),
    );
    state = await waitForChannelState(channel, 1);
    expect(state.withdrawnA).toBe(withdrawA);

    // CooperativeClose
    const closeSigA = channel.signClose(sentA, 0n, ctx.keyPairA);
    const closeSigB = channel.signClose(sentA, 0n, ctx.keyPairB);
    await sendAndWait(ctx.walletA, () =>
      channel.cooperativeClose(ctx.senderA, sentA, 0n, closeSigA, closeSigB),
    );
    await waitDrained(ctx.client, address);

    // Verify UNINITED (reopen possible)
    state = await waitForChannelState(channel, 0);
    expect(state.state).toBe(0);
  });
});
