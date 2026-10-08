#!/usr/bin/env bash
# Publish job only: signs and sends the transactions in a forge dry-run plan with cast. It never runs target code,
# so the deployer key is only ever handed to cast. Usage: send-planned.sh <plan.json>
# Env: CHAIN_ID, EXPECTED_SENDER (the deployer address), DEPLOYER_KEY (environment secret TESTNET_DEPLOYER_KEY).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plan="${1:?usage: send-planned.sh <plan.json>}"
: "${CHAIN_ID:?CHAIN_ID is required}"
: "${EXPECTED_SENDER:?EXPECTED_SENDER is required}"
: "${DEPLOYER_KEY:?DEPLOYER_KEY is not set (environment secret TESTNET_DEPLOYER_KEY)}"

guard_out="$(mktemp)"
GITHUB_OUTPUT="$guard_out" bash "$here/chain-guard.sh" "$CHAIN_ID"
rpc="$(sed -n 's/^rpc_url=//p' "$guard_out")"
rm -f "$guard_out"
actual="$(cast chain-id --rpc-url "$rpc")"
if [ "$actual" != "$CHAIN_ID" ]; then
  echo "refused: RPC reports chain $actual, expected $CHAIN_ID" >&2
  exit 1
fi

# One line per transaction: kind, to, input, value (decimal wei). Any mismatch refuses the whole plan.
rows="$(node -e '
const [file, sender, chain] = process.argv.slice(1);
const fail = (message) => { console.error(`refused: ${message}`); process.exit(1); };
const plan = JSON.parse(require("fs").readFileSync(file, "utf8"));
const txs = Array.isArray(plan.transactions) ? plan.transactions : [];
if (txs.length === 0) fail("plan has no transactions");
for (const item of txs) {
  const tx = item.transaction || {};
  if (String(tx.from || "").toLowerCase() !== sender.toLowerCase()) fail(`planned sender ${tx.from} is not the deployer`);
  if (tx.chainId !== undefined && tx.chainId !== null && BigInt(tx.chainId).toString() !== chain) fail(`planned chain ${BigInt(tx.chainId)} is not ${chain}`);
  const input = String(tx.input || tx.data || "0x");
  if (!/^0x[0-9a-fA-F]*$/.test(input)) fail("planned input is not hex");
  const value = BigInt(tx.value || "0x0").toString();
  if (item.transactionType === "CREATE") {
    if (input === "0x") fail("planned create has no bytecode");
    console.log(["create", "-", input, value].join("\t"));
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(tx.to || ""))) fail("planned call has no target address");
    console.log(["call", tx.to, input, value].join("\t"));
  }
}
' "$plan" "$EXPECTED_SENDER" "$CHAIN_ID")"

count=0
while IFS=$'\t' read -r kind to input value; do
  if [ "$kind" = create ]; then
    receipt="$(cast send --json --rpc-url "$rpc" --chain "$CHAIN_ID" --private-key "$DEPLOYER_KEY" --value "$value" --create "$input")"
  else
    receipt="$(cast send --json --rpc-url "$rpc" --chain "$CHAIN_ID" --private-key "$DEPLOYER_KEY" --value "$value" "$to" "$input")"
  fi
  count=$((count + 1))
  # Only public receipt fields are printed: the hash and, for a create, the contract address.
  summary="$(node -e 'try { const r = JSON.parse(process.argv[1]); console.log(`${r.transactionHash || "?"} ${r.contractAddress || ""}`.trim()); } catch { console.log("no receipt"); }' "$receipt")"
  echo "sent planned transaction $count ($kind): $summary"
done <<<"$rows"
