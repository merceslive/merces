#!/usr/bin/env bash
# RepoHub mainnet deploy (Robinhood Chain 4663). The USER runs this. It sends ONE tx (contract creation) from
# the key in ../.keys/mainnet-deployer.key (chmod 600, gitignored). The deployer is also the hub owner
# (can pause new claims and propose a verifier change with a 3-day delay; cannot move funds).
# Without --go: dry run only (no tx).
set -euo pipefail
cd "$(dirname "$0")"
RPC=${RPC:-https://robinhood-rpc.publicnode.com}   # *.chain.robinhood.com is ISP-blocked here
KEYS=../.keys
[[ "$(cast chain-id --rpc-url "$RPC")" == "4663" ]] || { echo "RPC is not Robinhood Chain mainnet"; exit 1; }
[[ -s $KEYS/mainnet-deployer.key && -s $KEYS/mainnet-verifier.key ]] || { echo "missing keys in $KEYS"; exit 1; }
DEPLOYER=$(cast wallet address --private-key "$(cat $KEYS/mainnet-deployer.key)")
VERIFIER=$(cast wallet address --private-key "$(cat $KEYS/mainnet-verifier.key)")
echo "deployer/owner: $DEPLOYER  balance: $(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") ETH (needs ~0.00005)"
echo "verifier:       $VERIFIER (the key the merces.live server signs claims with)"
export OWNER=$DEPLOYER VERIFIER

if [[ "${1:-}" != "--go" ]]; then
  echo "Dry run (no tx):"
  forge script script/DeployHub.s.sol --rpc-url "$RPC" --sender "$DEPLOYER" 2>&1 | grep -E "RepoHub|0x[0-9a-f]{64}$|gas|Error|Script ran" || true
  echo; echo "To deploy for real:   ./deploy-mainnet.sh --go"
  exit 0
fi

read -r -p "Broadcast RepoHub to MAINNET from $DEPLOYER? type yes: " ok
[[ "$ok" == "yes" ]] || { echo "aborted"; exit 1; }
forge script script/DeployHub.s.sol --rpc-url "$RPC" --private-key "$(cat $KEYS/mainnet-deployer.key)" --broadcast --slow 2>&1 | grep -vE "0x[0-9a-fA-F]{64}$" | tail -12
ADDR=$(jq -r '.transactions[0].contractAddress' broadcast/DeployHub.s.sol/4663/run-latest.json)
TX=$(jq -r '.transactions[0].hash' broadcast/DeployHub.s.sol/4663/run-latest.json)
BLOCK=$(cast receipt "$TX" blockNumber --rpc-url "$RPC")
echo "RepoHub: $ADDR  (tx $TX, block $BLOCK)"
echo "verifier() on chain: $(cast call "$ADDR" 'verifier()(address)' --rpc-url "$RPC")"
echo "owner()    on chain: $(cast call "$ADDR" 'owner()(address)' --rpc-url "$RPC")"
forge verify-contract "$ADDR" src/RepoHub.sol:RepoHub --chain-id 4663 --verifier sourcify --watch || \
  echo "verify failed: rerun: forge verify-contract $ADDR src/RepoHub.sol:RepoHub --chain-id 4663 --verifier sourcify"
printf '{"RepoHub":"%s","tx":"%s","block":%s,"owner":"%s","verifier":"%s"}\n' "$ADDR" "$TX" "$BLOCK" "$DEPLOYER" "$VERIFIER" > deployments-mainnet.json
echo "Explorer: https://robinhoodchain.blockscout.com/address/$ADDR"
echo "Then tell Claude 'udah deploy' (Claude re-checks on chain, wires the address into merces.live and redeploys)."
