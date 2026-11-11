# Wildstate production hosting

The public frontend is https://wildstate-dsm.vercel.app/ and the repository is https://github.com/Irrefutable-Labs/wildstate-dsm. One persistent game server and one DSM account, the game's own, run on one host, apart from the storage nodes. That host was fleet instance `dsm-storage-node-1` (GCP `us-central1-b`, `34.58.75.224`); see [where production stands](#where-production-stands-2026-11-11) for what changed when the beta storage set moved. No public service depends on the developer's Wi-Fi.

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
    dsm_env_config.toml   # the pinned beta storage set: DSM main's dsm_client/frontend/public/dsm_env_config.toml, each member's CA inside it
  https-data/            # root-owned, mode 700: HTTPS certificates
  https-config/          # root-owned, mode 700
```

The account image is built from DSM main (`e3f9b3fcd` or later), whose `crates/dsm-app-host` takes `--ingress-secret-dir`: the game reaches its account only with that secret. Build it from a `git archive` of the committed revision, apart from any working checkout. Source code in DSM is not changed for this deployment.

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

The production account is fresh: no earlier account or game record is imported. The first page that connects sets the economy up: ERA from the faucet when the account needs it, WILD issued (a fixed supply of 1,000,000), and the market's five WILD/ERA SoFi vaults funded with 50,000 WILD and 1,000 ERA in equal slices, each charging a 30-bps fee on a trade. Issuing an object burns the SDK's ERA fee. The owner approved this setup and the liquidity. The first production setup (2026-10, one vault then) took 13 accepted 100-ERA claims; once WILD was issued and the vault funded, the account owned 290 ERA and 950,000 WILD outside the vault.

The same game account owns the reward reserve and the market's vaults. Victories give WILD from what the account owns. No second identity or separate reward faucet is introduced. Game JSON is not DSM ownership evidence.

## Activation (2026-10)

The public HTTPS backend and wallet relay were activated. The real account SDK reports one active vault containing 50,000 WILD and 1,000.00 ERA, with a 30-bps fee. The public RPGJS WebSocket connection was accepted and produced a real DSM wallet-connect offer. Public map administration returns 404, while the private token guard rejects unauthorized changes with 401.

Vercel's production `VITE_GAME_HOST` is `wildstate.34.58.75.224.sslip.io`. The successful production deployment `dpl_6mKHY3G6iAogPuqPzZuUApBMTaaZ` is aliased to https://wildstate-dsm.vercel.app/ and visibly displays the real cloud-hosted wallet-connect offer. Player wallet approval, reward delivery, a live trade and phone play still required verification with an actual consenting player; those actions were not simulated or claimed as tested.

## Where production stands (2026-11-11)

Checked from outside on 2026-11-11:

- The frontend at https://wildstate-dsm.vercel.app/ is up, built for the game server `wildstate.34.58.75.224.sslip.io`.
- `34.58.75.224` answers ping, but nothing answers on 443 (the game) or 8443 (the wallet relay), so no player can connect.
- The beta storage set the wallets use moved to five OVHcloud nodes on 2026-11-10 and was reprovisioned on 2026-11-11 for the storage node's schema 3, every database wiped (DSM main's `dsm_client/frontend/public/dsm_env_config.toml`). The production account was made on the set before, so it does not exist on the current one, and neither do the objects it issued or the players' wallets of that time.

A redeploy (not done; the owner decides it) takes, in order:

1. A host with ports 80, 443 and 8443 open: the old one, or a new one.
2. The account image from DSM main, `e3f9b3fcd` or later (`deploy/account/Dockerfile`), and the game image from this repository (`deploy/game/Dockerfile`).
3. `network/dsm_env_config.toml` replaced by DSM main's `dsm_client/frontend/public/dsm_env_config.toml`.
4. `account/` moved aside (it holds the old recovery mnemonic: keep it private) and a fresh, empty `account/`; a new `ingress/` (uid/gid 10001, mode 700); `game/dsm-game.json` moved aside, since it is the record of the old account and the game refuses a record of another account.
5. `.env` with `WILDSTATE_BACKEND_DOMAIN`, `WILDSTATE_RELAY_ENDPOINT`, `WILDSTATE_RELAY_NAME` and `RPGJS_MAP_UPDATE_TOKEN`, then `docker compose -p wildstate -f compose.yml up -d`.
6. One page opened against it, to set the economy up (faucet claims, WILD issued, five vaults funded); the overlay shows each step.
7. If the host's name changes: the allowed origins, Vercel's `VITE_GAME_HOST`, and a new signed APK, which carries that name. With the same name, the frontend and installed APKs reach the new server as they are: the protocol (`src/protocol.ts`) is still 2. Client wording changes reach APK players only in a new APK.

Every player connects afresh: the new account is a new app to their wallets.

## Operations

From `/opt/wildstate`, use `docker compose -p wildstate -f compose.yml ps` for status, `logs --tail 50 game` for backend failures, and `restart game` to restart the RPG process. Preserve both account and game directories during updates; do not run a second copy of the account or replace its store with an older snapshot. Keep recovery material private and outside GitHub.

Build the account image with a `git archive` of the committed DSM revision as its Docker context, which keeps private and untracked files out of the image; build the game image from this repository.
