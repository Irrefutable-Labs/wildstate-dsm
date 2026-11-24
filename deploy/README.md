# Wildstate production hosting

The public frontend is https://wildstate-dsm.vercel.app/ and the repository is https://github.com/cryptskii/wildstate-dsm. One persistent backend and one DSM account run separately from the storage-node service on fleet instance `dsm-storage-node-1` (GCP `us-central1-b`, `34.58.75.224`). No public service depends on the developer's Wi-Fi.

## Layout on the server

```
/opt/wildstate/
  compose.yml
  Caddyfile
  .env                   # mode 600: private map publication token and public endpoints
  account/               # mode 700, uid/gid 10001: DSM SDK state, mnemonic, relay TLS identity
  ingress/               # mode 700, uid/gid 10001: the account host's ingress secret alone; the game mounts only this, read-only
  game/                  # mode 700, uid/gid 10001
    dsm-game.json        # game profiles, WILD policy and vault references; Web2 data
    rooms.sqlite         # RPGJS room/session state
  network/
    dsm_env_config.toml   # existing pinned beta storage set
    ca.crt               # public storage fleet CA
  https-data/            # root-owned, mode 700: HTTPS certificates
  https-config/          # root-owned, mode 700
```

The account uses the committed DSM integration checkout revision `9723f2cca`, which contains `crates/dsm-app-host`. It is separate from the main DSM checkout. Source code in DSM has not been changed for this deployment.

`deploy/account/Dockerfile` builds the real Rust SDK host from that checkout, using its lockfile and toolchain. `deploy/game/Dockerfile` builds the game and bundles the server (`npm run build:server`: `scripts/server.mjs` with the server module and the few packages it uses) into one file; the runtime image is Node 24 Alpine with that file and `src/tiled` only, no `node_modules` or client code. Both run as uid/gid 10001. The combined `deploy/compose.yml` uses one replica each, persistent bind mounts, restart policies and bounded logs. Multiple independent game replicas are unsupported.

## Network boundaries

- `127.0.0.1:8787`: private DSM protobuf ingress. Not exposed publicly or passed to the frontend.
  Every call carries the host's ingress secret, which the host writes to `ingress/ingress-token` at each launch (`--ingress-secret-dir /ingress`). The game container mounts `ingress/` read-only and nothing of `account/`, and re-reads the secret for every call, so a host restart needs no game restart. The account image must be built from a DSM revision whose `dsm-app-host` takes `--ingress-secret-dir`.
- `127.0.0.1:3000`: private RPGJS listener, reached through Caddy.
- Public `443`: HTTPS and game WebSockets at `wildstate.34.58.75.224.sslip.io`.
- Public `80`: HTTPS redirect and certificate issuance.
- Public `8443`: wallet DSM Connect relay at `https://34.58.75.224:8443`. Its self-signed certificate is pinned by the wallet-connect code, as in the existing DSM host implementation.

The backend accepts browser origins `https://wildstate-dsm.vercel.app`, the Android app's bundled client at `https://appassets.androidplatform.net`, and its own HTTPS origin. `/version` reports the client protocol (`src/protocol.ts`) that clients check before connecting; deploy a backend before the frontend or APK that expects it. Map publication runs internally from trusted Tiled files, protected by `RPGJS_MAP_UPDATE_TOKEN`. Caddy rejects the public map-update route. The browser never receives that token or the account mnemonic.

The initial backend hostname uses sslip.io to resolve the existing fleet IP. It can be replaced with an owned DNS name by changing `WILDSTATE_BACKEND_DOMAIN`, the allowed origins, and the Vercel frontend's `VITE_GAME_HOST`. The wallet relay endpoint and TLS identity must be handled consistently with issued connect codes.

## Economy

The production account is fresh. The previous local account and game record are not imported. Its first game connection initializes the existing economy code: claim ERA when needed, create fixed-supply WILD (1,000,000), and fund a WILD/ERA SoFi vault with 50,000 WILD and 1,000 ERA, charging the existing 30-bps swap fee. Token creation also consumes the SDK's ERA creation fee. The owner approved this initialization and the larger liquidity allocation. Funding used 13 accepted 100-ERA claims (1,300 ERA total); after WILD creation and vault funding, the account held 290 ERA and 950,000 WILD available outside the vault.

The same game identity owns both the available reward reserve and the separately funded swap vault. Victories transfer WILD from the account's available balance. No second identity or separate reward faucet is introduced. Game JSON is not DSM ownership evidence.

## Activation status

The public HTTPS backend and wallet relay are activated. The real account SDK reports one active vault containing 50,000 WILD and 1,000.00 ERA, with a 30-bps fee. The public RPGJS WebSocket connection was accepted and produced a real DSM wallet-connect offer. Public map administration returns 404, while the private token guard rejects unauthorized changes with 401.

Vercel's production `VITE_GAME_HOST` is `wildstate.34.58.75.224.sslip.io`. The successful production deployment `dpl_6mKHY3G6iAogPuqPzZuUApBMTaaZ` is aliased to https://wildstate-dsm.vercel.app/ and visibly displays the real cloud-hosted wallet-connect offer. Player wallet approval, reward delivery, a live swap and phone play still require verification with an actual consenting player; those actions have not been simulated or claimed as tested.

## Operations

From `/opt/wildstate`, use `docker compose -p wildstate -f compose.yml ps` for status, `logs --tail 50 game` for backend failures, and `restart game` to restart the RPG process. Preserve both account and game directories during updates; do not run a second copy of the account or replace its store with an older snapshot. Keep recovery material private and outside GitHub.

Build the account image with the DSM integration checkout as its Docker context; build the game image from this repository. The deployment used a `git archive` of the committed DSM revision to exclude private and untracked files from the image.
