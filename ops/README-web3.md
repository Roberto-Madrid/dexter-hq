# Web3 crew (testnet only)

The `web3` crew (`crews/web3.yaml`) runs these steps:

1. Research.
2. Mechanism and threat model (`personas/web3.md`).
3. Owner gate.
4. Contracts (`personas/contracts.md`).
5. Simulations.

It is always T3 and always reviewed by the adversarial Council. Follow `checklists/web3-testnet.md`.

## What HQ enforces

- **Testnet only.** `kernel/web3.ts` allows only the listed testnets. It refuses every mainnet chain id, anvil's
  local chain, and any unknown id. `request_approval` and `request_publish` both apply this rule, and so does the
  dispatcher itself.
- **Owner gate.** `launch_agent` with role `contracts` on a web3 request needs `approvalId` set to an approved
  `web3_mechanism` card for that request.
- **Adversarial Council.**
  - On a web3 request, `request_council` refuses any mode other than adversarial.
  - `update_request done` needs the latest Council review to be a complete adversarial pass.
  - The Devil seat has no backend yet and reports not-ready, so every adversarial review is `incomplete`. As a
    result, no web3 request can be marked done or published until a Devil backend exists. Nobody writes a Devil
    verdict by hand.
- **Publishing.** `request_publish` (requestId, sha, chainId, approvalId) dispatches the workers `web3.yml` with
  `publish=true`, but only when all of these hold:
  - the owner approved a `web3_publish` card whose target is exactly `<repo>@<sha>#<chainId>`;
  - the adversarial Council passed;
  - that card was not already used.

## The workers workflow

`workers/.github/workflows/web3.yml` is HQ's copy of the workflow in the workers repo.

- **`test` job.** Holds no key. Its only secret is `CHECKER_READ_TOKEN`, used by the checkout step only and not
  persisted. Steps, in order:
  1. Chain guard.
  2. Check out the target at the sha.
  3. `forge build` and `forge test` (with `FOUNDRY_FFI=false`).
  4. A simulated deploy on anvil with an unlocked dev account.
  5. For a publish run only: a dry run against the live testnet with `--sender` set to the deployer address. The
     resulting plan is uploaded as an artifact.
- **`publish` job.** The only job that can read the deployer key.
  - It runs only when all of these hold: it `needs: test`, the run has `publish: true`, an approval id is set, and
    the job sits in the `testnet-publish` environment.
  - It never checks out or runs target code. Steps, in order:
    1. Chain guard against the live RPC.
    2. Download the plan.
    3. Check that the key's address equals `TESTNET_DEPLOYER_ADDRESS`.
    4. `send-planned.sh` signs exactly the planned transactions with `cast`.

`tests/unit/web3.test.ts` parses the workflow and asserts this scoping:

- `TESTNET_DEPLOYER_KEY` appears in exactly two step `env` blocks, both in `publish`.
- No other workflow mentions the key.
- The guard runs before any secret.
- No `run:` script interpolates an expression.

## Owner setup (once, in the workers repo)

1. **Environment.** Create the environment `testnet-publish`. Limit it to the `main` branch. Optionally add yourself
   as a required reviewer for a second human gate.
2. **Environment secret.** In `testnet-publish`, add `TESTNET_DEPLOYER_KEY`: a fresh key used only on testnets and
   funded from a faucet. Do not store it as a repository secret.
3. **Repository variable.** Add `TESTNET_DEPLOYER_ADDRESS`, that key's public address.
4. **Copy the files.** Copy `.github/workflows/web3.yml` and `web3/` from this mirror. Pushing a workflow file needs
   a token with the `workflow` scope.
