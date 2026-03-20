# pc402 — SDK for TON Payment Channels over HTTP 402

## What this is
TypeScript SDK for off-chain micropayments on TON blockchain via payment channels + HTTP 402 protocol. Two packages: `pc402-core` (crypto, protocol) and `pc402-channel` (on-chain lifecycle).

## Commands
```bash
npm install          # install deps
npm run build        # build all packages (tsup, CJS+ESM)
npm test             # run all unit tests (vitest)
npx vitest run -c test/e2e/vitest.config.ts  # E2E mainnet tests
npx tsc --noEmit     # type check
```

## Structure
```
packages/core/       — pc402-core: PaymentChannel, HTTP 402 helpers, state management
packages/channel/    — pc402-channel: OnchainChannel, all on-chain operations
test/e2e/            — E2E mainnet tests (3 test files, requires funded wallets)
scripts/             — E2E mainnet runner script
specs/pc402/          — 11 spec files
```

## Smart contract (v2)
Source in `/home/anon/Bureau/TONNET/pc402-contract/contracts/` (7 Tolk files). Compiled bytecode embedded in `packages/channel/src/contract.ts`. v2 improvements: 6-field balance model, uint64 seqnos, dust limit, channel reopen, delegated challenge, excess refund pattern.

## Key facts
- 101 unit tests + 3 E2E mainnet test suites, all passing
- Tested E2E on TON mainnet (800+ off-chain payments, dispute flow, reopen)
- Bidirectional payment channels with v2 contract
- HTTP 402 is for machine-to-machine (agents, bots, APIs)
- No Facilitator needed (unlike x402)
- Gas optimized: ~0.005 TON per on-chain operation

## Related repos
- Contract: `/home/anon/Bureau/TONNET/pc402-contract/`
- Game demo: `/home/anon/Bureau/TONNET/demo-game-pc402/`
- x402 (separate project): `/home/anon/Bureau/TONNET/x402-ton/`

## Deployment
Server: 80.78.18.152 (SSH: `ssh -i ~/.ssh/id_master root@80.78.18.152`)
Path on server: `/opt/pc402/`
