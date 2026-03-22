/**
 * pc402-fetch — HTTP client with automatic 402 payment handling
 *
 * Wraps native fetch() to transparently handle HTTP 402 Payment Required
 * responses. Manages payment channels, signs off-chain state updates,
 * and retries requests with payment proof.
 */

import type { KeyPair } from "@ton/crypto";
import {
  buildPaymentSignature,
  type ChannelState,
  MemoryStorage,
  PC402Error,
  PC402ErrorCode,
  parsePaymentRequired,
  parsePaymentResponse,
  type StateStorage,
} from "pc402-core";

import { type ChannelEntry, ChannelPool } from "./channel-pool.js";

/** Options for creating a pc402-aware fetch function. */
export interface PC402FetchOptions {
  /** Client's Ed25519 key pair (provide this OR mnemonic). */
  keyPair: KeyPair;
  /** Pluggable storage for persisting channel state across sessions. */
  storage?: StateStorage;
  /** Maximum price per request in nanotons. Rejects 402 responses above this amount. */
  maxPrice?: bigint;
}

/** The fetch-like function returned by createPC402Fetch. */
export type PC402Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Create a fetch function that automatically handles HTTP 402 responses.
 *
 * When a server returns 402 Payment Required with a valid PAYMENT-REQUIRED
 * header, the returned function will:
 * 1. Parse the payment requirements
 * 2. Find or create a payment channel for the server
 * 3. Sign a new off-chain state transferring the requested amount
 * 4. Retry the request with a PAYMENT-SIGNATURE header
 * 5. Process the PAYMENT-RESPONSE (counter-signature, commit requests)
 * 6. Persist the updated channel state
 *
 * Non-402 responses are returned as-is.
 */
export function createPC402Fetch(options: PC402FetchOptions): PC402Fetch {
  const { keyPair, storage = new MemoryStorage(), maxPrice } = options;
  const pool = new ChannelPool(keyPair, storage);

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // 1. Original request
    const response = await fetch(input, init);

    // 2. Non-402: pass through
    if (response.status !== 402) return response;

    // 3. Parse PAYMENT-REQUIRED header
    const prHeader = response.headers.get("payment-required");
    if (!prHeader) {
      throw new PC402Error(
        "Server returned 402 without PAYMENT-REQUIRED header",
        PC402ErrorCode.INVALID_HEADER,
      );
    }

    const requirements = parsePaymentRequired(prHeader);
    if (!requirements) {
      throw new PC402Error("Invalid PAYMENT-REQUIRED header", PC402ErrorCode.INVALID_HEADER);
    }

    // 4. Reject if price exceeds maxPrice
    const amount = BigInt(requirements.amount);
    if (maxPrice !== undefined && amount > maxPrice) {
      throw new PC402Error(
        `Server price ${amount} exceeds maxPrice ${maxPrice}`,
        PC402ErrorCode.INVALID_AMOUNT,
      );
    }

    // 5. Get or create channel
    const entry: ChannelEntry = await pool.getOrCreate(requirements);
    const { paymentChannel, state } = entry;

    // 6. Create new state with payment
    const newState: ChannelState = paymentChannel.createPaymentState(state, amount);

    // 7. Sign the new state
    const signature = paymentChannel.signState(newState);

    // 8. Channel info must be present for payment
    if (!requirements.channel) {
      throw new PC402Error(
        "Server 402 did not include channel info (discovery mode not supported by this client)",
        PC402ErrorCode.INVALID_HEADER,
      );
    }
    const channel = requirements.channel;

    // 9. Check for pending commit signature from previous response
    const pendingCommit = await pool.popPendingCommit(channel.address);

    // 10. Build PAYMENT-SIGNATURE header
    const paymentHeader = buildPaymentSignature({
      channelAddress: channel.address,
      channelId: channel.channelId,
      state: newState,
      signature,
      publicKey: keyPair.publicKey,
      initBalanceA: BigInt(channel.initBalanceA),
      initBalanceB: BigInt(channel.initBalanceB),
      commitSignature: pendingCommit ?? undefined,
    });

    // 11. Retry with payment header
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set("payment-signature", paymentHeader);
    const retryResponse = await fetch(input, { ...init, headers: retryHeaders });

    // 12. Process PAYMENT-RESPONSE header — only save state if server accepted
    const prResponseHeader = retryResponse.headers.get("payment-response");
    const paymentResponse = prResponseHeader ? parsePaymentResponse(prResponseHeader) : null;

    if (paymentResponse?.success) {
      await pool.saveCounterSignature(channel.address, paymentResponse.counterSignature);

      if (paymentResponse.closeRequest) {
        await pool.saveCloseRequest(channel.address, paymentResponse.closeRequest);
      }

      if (paymentResponse.semiChannelSignature) {
        await pool.saveSemiChannelSignature(
          channel.address,
          paymentResponse.semiChannelSignature,
        );
      }

      if (paymentResponse.commitRequest) {
        const cr = paymentResponse.commitRequest;

        // Verify server's commit signature and co-sign if valid
        const serverSig = Buffer.from(cr.serverSignature, "base64");
        const valid = paymentChannel.verifyCommit(
          BigInt(cr.seqnoA),
          BigInt(cr.seqnoB),
          BigInt(cr.sentA),
          BigInt(cr.sentB),
          serverSig,
          BigInt(cr.withdrawA),
          BigInt(cr.withdrawB),
        );

        if (valid) {
          const commitSig = paymentChannel.signCommit(
            BigInt(cr.seqnoA),
            BigInt(cr.seqnoB),
            BigInt(cr.sentA),
            BigInt(cr.sentB),
            BigInt(cr.withdrawA),
            BigInt(cr.withdrawB),
          );
          await pool.savePendingCommit(channel.address, commitSig);
        }
      }

      // 13. Save updated state only on successful payment
      await pool.saveState(channel.address, newState);
    }

    return retryResponse;
  };
}
