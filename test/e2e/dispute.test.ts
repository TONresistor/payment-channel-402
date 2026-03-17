/**
 * E2E mainnet — Dispute path
 *
 * Tests: deployAndTopUp (reopen), init, buildSignedSemiChannel,
 *        startUncooperativeClose, finishUncooperativeClose, getOnchainState
 *
 * Run: npx vitest run test/e2e/dispute.test.ts
 * Note: Takes ~3 min (waits for 60s quarantine + 60s close period)
 */

import { toNano } from "@ton/core";
import { buildSignedSemiChannel } from "pc402-channel";
import { describe, expect, it } from "vitest";
import {
  createChannel,
  getContext,
  sendAndWait,
  sleep,
  waitActive,
  waitDrained,
  waitForChannelState,
} from "./setup.js";

describe("e2e mainnet: dispute path", { timeout: 300_000 }, () => {
  it("deploy → init → startUncooperativeClose → wait quarantine → finishUncooperativeClose", async () => {
    const ctx = await getContext();
    const { channel, channelId, address } = createChannel(ctx, {
      quarantineDuration: 60,
      conditionalCloseDuration: 60,
    });

    const depositA = toNano("0.015");

    // Deploy + Init
    await sendAndWait(ctx.walletA, () => channel.deployAndTopUp(ctx.senderA, true, depositA));
    await waitActive(ctx.client, address);
    await sendAndWait(ctx.walletA, () => channel.init(ctx.senderA, depositA, 0n, ctx.keyPairA));

    let state = await waitForChannelState(channel, 1);
    expect(state.state).toBe(1);

    // startUncooperativeClose — seqnos must be >= committed
    const seqA = BigInt(state.seqnoA + 1);
    const seqB = BigInt(state.seqnoB + 1);
    const schA = buildSignedSemiChannel(channelId, seqA, 0n, ctx.keyPairA);
    const schB = buildSignedSemiChannel(channelId, seqB, 0n, ctx.keyPairB);
    const uncoopSig = channel.signStartUncoopClose(schA, schB, ctx.keyPairA);

    await sendAndWait(ctx.walletA, () =>
      channel.startUncooperativeClose(ctx.senderA, true, uncoopSig, schA, schB),
    );

    state = await waitForChannelState(channel, 2);
    expect(state.state).toBe(2); // CLOSURE_STARTED

    // Wait quarantine (60s) + close period (60s) = 120s
    await sleep(130_000);

    // finishUncooperativeClose
    await sendAndWait(ctx.walletA, () => channel.finishUncooperativeClose(ctx.senderA));
    await waitDrained(ctx.client, address);

    state = await waitForChannelState(channel, 0);
    expect(state.state).toBe(0); // UNINITED
  });
});
