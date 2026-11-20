#!/usr/bin/env bash
# Merces deploy → us1: rsync → build on server → systemd → nginx. Usage: ./deploy.sh
# First run on a new host: check the port with `ssh us1 ss -ltnp | grep 8791`, then `certbot --nginx -d merces.live -d www.merces.live`.
set -euo pipefail
cd "$(dirname "$0")"
H=$(cat .deploy-host)
R=/opt/merces
grep -q "LOCAL FORK ONLY" web/public/config.js && { echo "web/public/config.js still points at the local fork hub — set the mainnet hub first"; exit 1; }

ssh "$H" "id merces >/dev/null 2>&1 || useradd --system --home $R --shell /usr/sbin/nologin merces; mkdir -p $R/{server,web,state}"
rsync -az --delete --exclude node_modules server/ "$H:$R/server/"
rsync -az --delete --exclude node_modules --exclude dist web/ "$H:$R/web/"

ssh "$H" bash -s <<EOS
set -euo pipefail
cd $R/server && npm install --omit=dev --no-audit --no-fund
cd $R/web && npm install --no-audit --no-fund && npx vite build
[ -f $R/state/server.env ] || cp $R/server/deploy/server.env.example $R/state/server.env
cp $R/server/deploy/merces-server.service /etc/systemd/system/merces-server.service
[ -f /etc/nginx/sites-available/merces.live ] || cp $R/server/deploy/nginx-merces.live.conf /etc/nginx/sites-available/merces.live
ln -sf /etc/nginx/sites-available/merces.live /etc/nginx/sites-enabled/merces.live
chown -R merces:merces $R/state
chmod 600 $R/state/server.env
systemctl daemon-reload && systemctl enable merces-server >/dev/null 2>&1 && systemctl restart merces-server
nginx -t && systemctl reload nginx
sleep 3; curl -s 127.0.0.1:8791/api/health; echo
EOS
