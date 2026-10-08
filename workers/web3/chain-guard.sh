#!/usr/bin/env bash
# Testnet-only guard for the web3 workflow. Usage: chain-guard.sh <chain_id>
# Refuses mainnets and any chain not in chains.json. ALLOW_LOCAL=1 accepts anvil's chain (simulation only).
# CHECK_RPC=1 also asks the chain's public RPC for eth_chainId and refuses a mismatch.
# Writes chain_id, name and rpc_url to $GITHUB_OUTPUT when it is set.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chain="${1:-}"
if ! [[ "$chain" =~ ^[1-9][0-9]{0,12}$ ]]; then
  echo "refused: chain id '$chain' is not a decimal chain id" >&2
  exit 1
fi
lookup="$(node -e '
const chains = require(process.argv[1]);
const id = process.argv[2];
if (chains.mainnets.includes(Number(id))) console.log("mainnet");
else if (Number(id) === chains.local) console.log("local");
else if (chains.testnets[id]) console.log(["testnet", chains.testnets[id].name, chains.testnets[id].rpc].join("\t"));
else console.log("unknown");
' "$here/chains.json" "$chain")"
kind="${lookup%%$'\t'*}"
case "$kind" in
  mainnet)
    echo "refused: chain $chain is a mainnet; the web3 crew is testnet only" >&2
    exit 1
    ;;
  unknown)
    echo "refused: chain $chain is not an allowlisted testnet" >&2
    exit 1
    ;;
  local)
    if [ "${ALLOW_LOCAL:-}" != 1 ]; then
      echo "refused: chain $chain is the local simulation chain and is never a publish target" >&2
      exit 1
    fi
    name=anvil
    rpc=http://127.0.0.1:8545
    ;;
  testnet)
    IFS=$'\t' read -r _ name rpc <<<"$lookup"
    ;;
esac
if [ "${CHECK_RPC:-}" = 1 ]; then
  reply="$(curl -fsS --max-time 20 -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$rpc")"
  reported="$(node -e 'const r = JSON.parse(process.argv[1]).result; console.log(/^0x[0-9a-f]+$/i.test(r || "") ? BigInt(r).toString() : "none")' "$reply")"
  if [ "$reported" != "$chain" ]; then
    echo "refused: RPC reports chain $reported, expected $chain" >&2
    exit 1
  fi
fi
echo "chain $chain ($name) allowed"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "chain_id=$chain"
    echo "name=$name"
    echo "rpc_url=$rpc"
  } >>"$GITHUB_OUTPUT"
fi
