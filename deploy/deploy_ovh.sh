#!/usr/bin/env bash
# Redeploys Wildstate on the games host on OVH (dsm-games-1, 148.113.137.67): the game server, and the browser
# client the shared Caddy serves, from a committed revision of this repository. The account keeps running and keeps
# its keys; nothing of /opt/wildstate/account or /opt/wildstate/game is touched.
#
#   deploy/deploy_ovh.sh [revision]      default: HEAD (committed; the working tree is not sent)
#
#   WILDSTATE_HOST  the games host (default 148.113.137.67)
#   SSH_KEY         (default ~/.ssh/dsm-deploy; SSH is allowed from the operator's address only)
#
# The account (dsm-app-host from DSM main) is rebuilt apart from this: on the host, build DSM's image and retag it
# wildstate-account:production, then `docker compose -p wildstate -f compose.yml -f compose.games.yml up -d --no-deps account`.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${WILDSTATE_HOST:-148.113.137.67}"
KEY="${SSH_KEY:-$HOME/.ssh/dsm-deploy}"
DOMAIN="wildstate.$HOST.sslip.io"
REV=$(git rev-parse --short=9 "${1:-HEAD}^{commit}")
SSH=(ssh -o BatchMode=yes -i "$KEY" "ubuntu@$HOST")

SRC=$("${SSH[@]}" 'mktemp -d -p "$HOME" wildstate-src.XXXXXX')
trap '"${SSH[@]}" "sudo rm -rf $SRC" 2>/dev/null' EXIT
echo "==> sending $REV to $HOST"
git archive --format=tar "$REV" | "${SSH[@]}" "tar -x --no-same-owner -C $SRC"

echo "==> game server image wildstate-game:$REV"
"${SSH[@]}" "cd $SRC && sudo docker build -q -f deploy/game/Dockerfile -t wildstate-game:$REV -t wildstate-game:production ."

echo "==> browser client for $DOMAIN"
"${SSH[@]}" "sudo docker run --rm -v $SRC:/app -w /app -e VITE_GAME_HOST=$DOMAIN node:24-bookworm-slim sh -c 'npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null' \
  && sudo rsync -a --delete $SRC/dist/client/ /opt/https/wildstate-client/ && sudo chown -R ubuntu:ubuntu /opt/https/wildstate-client"

echo "==> compose files and restart of the game"
"${SSH[@]}" "sudo install -m 644 $SRC/deploy/compose.yml $SRC/deploy/compose.games.yml /opt/wildstate/ \
  && cd /opt/wildstate && sudo docker compose -p wildstate -f compose.yml -f compose.games.yml up -d --no-deps game"

echo "==> check"
sleep 10
curl -fsS "https://$DOMAIN/version"; echo
echo "Wildstate: https://$DOMAIN/   wallet relay: https://$HOST:8443"
