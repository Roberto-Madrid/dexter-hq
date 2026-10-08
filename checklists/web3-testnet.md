# Web3 testnet checklist

Use this for every `web3` request. A box that cannot be ticked stops the lane.

## Before contracts
- [ ] The researcher's note is posted with dated sources.
- [ ] The web3 persona posted the mechanism and threat model: actors, assets, trust assumptions, attacks and why each fails.
- [ ] The target is an allowlisted testnet (`kernel/web3.ts`, `workers/web3/chains.json`). Any mainnet chain id is refused.
- [ ] The owner approved the `web3_mechanism` approval card. The Contracts lane cannot launch without it.

## Contracts
- [ ] `foundry.toml`, contracts, Foundry tests, and `script/Deploy.s.sol` live in the venture repo.
- [ ] Tests cover edge cases and every attack in the threat model.
- [ ] The workers `web3.yml` test job passes: `forge build`, `forge test`, and a simulated deploy on anvil (chain 31337).
- [ ] No private key, seed phrase, or RPC URL with a key appears anywhere in the repo, brief, or board.

## Review
- [ ] The adversarial Council ran (standard seats plus Devil). An incomplete review is not a pass.
- [ ] Today the Devil seat has no backend and reports not-ready, so a web3 request cannot pass the Council and cannot
      be marked done or published. Nobody writes a Devil verdict by hand.

## Publish (testnet only)
- [ ] The owner approved a `web3_publish` approval card whose target is exactly `<repo>@<sha>#<chainId>`.
- [ ] `request_publish` dispatched the workers publish job. Only that job can read `TESTNET_DEPLOYER_KEY` (an
      environment secret of `testnet-publish`). It signs the planned transactions with cast and runs no target code.
- [ ] The transaction hashes and contract addresses are posted to the board as evidence.
