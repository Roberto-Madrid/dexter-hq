# web3 (workers)

Scripts for `.github/workflows/web3.yml`. Testnet only.

- `chains.json`: the allowlisted testnets (with public RPCs that carry no key), the mainnets refused by name, and
  anvil's local chain. It must match `kernel/web3.ts` in dexter-hq; a unit test keeps the two in sync.
- `chain-guard.sh <chain_id>`: refuses mainnets and unknown chains. `ALLOW_LOCAL=1` admits anvil (simulation only).
  `CHECK_RPC=1` also checks that the public RPC reports the same chain id.
- `send-planned.sh <plan.json>`: publish job only. It signs and sends the transactions in a forge dry-run plan with
  `cast`, after checking the sender, the chain, and the guard. It never runs target code.
- `sample/`: a Foundry project with no dependencies, used to self-test the workflow (`forge build`, `forge test`, and a
  `script/Deploy.s.sol` run with `--sender`).
