#!/usr/bin/env bash
# T0: put the $WAGE contract address live on merces.live.
#   ./golive.sh 0x<CA> --check   verify on chain only (code, symbol); changes nothing
#   ./golive.sh 0x<CA>           write state/token.json on us1 → /api/token returns the CA, header and /token show it
set -euo pipefail
cd "$(dirname "$0")"
CA="${1:-}"; MODE="${2:-}"
RPC=https://robinhood-rpc.publicnode.com
[[ "$CA" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "usage: ./golive.sh 0x<40 hex> [--check]" >&2; exit 1; }
[[ "$(cast chain-id --rpc-url $RPC)" == "4663" ]] || { echo "RPC is not Robinhood Chain mainnet"; exit 1; }
SIZE=$(cast codesize "$CA" --rpc-url $RPC)
SYM=$(cast call "$CA" 'symbol()(string)' --rpc-url $RPC 2>/dev/null | tr -d '"' || true)
echo "CA $CA · codesize $SIZE · symbol $SYM"
[[ "$SIZE" -gt 0 ]] || { echo "no contract at $CA"; exit 1; }
[[ "$SYM" == "WAGE" ]] || { echo "symbol is '$SYM', expected WAGE — stop and check the CA"; exit 1; }
[[ "$MODE" == "--check" ]] && { echo "check only: nothing changed"; exit 0; }
H=$(cat .deploy-host)
JSON=$(printf '{"ca":"%s","ticker":"WAGE","chainId":4663,"liveAt":"%s"}' "$CA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
ssh "$H" "printf '%s\n' '$JSON' > /opt/merces/state/token.json.tmp && chown merces:merces /opt/merces/state/token.json.tmp && mv /opt/merces/state/token.json.tmp /opt/merces/state/token.json"
echo "web: $(curl -s https://merces.live/api/token)"
