# DSM underneath Wildstate

Wildstate stays an ordinary Web2 game. Walking, encounters, battles, dialogue and healing run on the game server and never touch DSM. What a player owns lives in the player's DSM wallet on their phone:

- **WILD**, the game's coin: a CPTA token of fixed supply that the game's own DSM account created. The account pays players with it: 5 WILD for a victory, and starting coin after connecting.
- **Creatures**: each caught creature is a state object, a token of supply one that the game's account creates at the capture. Its committed policy names the game account as issuer, plus the species and the capture number. Its policy commitment is the creature's identity. HP, XP and charges are game data keyed by that identity.
- **The market**: a WILD/ERA SoFi vault the game's account funds. Players swap from inside the game, and the wallet runs an ordinary SoFi trade (multi-hop when the route needs it).

This is DSM Amendment A11 in `specs/DSM_High_Level_Explainer.md` (the explainer's "a game" passage, §78, made concrete).

## Pieces

| Piece | Where | What it is |
|---|---|---|
| The game's DSM account | `dsm` repo, `crates/dsm-app-host` | One real DSM identity on the production SDK path, against the network's pinned storage set. Serves the game a local protobuf ingress (`/ingress`, `/activity`) and serves wallets the DSM Connect relay over TLS pinned by the connect code. |
| DSM Connect | `dsm_sdk::sdk::connect`, `connect.*` and `connect.app.*` routes | Pairing by code, signed offers and answers, the scoped grant, holdings proofs. |
| The wallet's Apps screen | `dsm_client/frontend/src/components/screens/AppsScreen.tsx` | Scan a connect code, approve, see grants and spending, handle waiting requests, disconnect. |
| The game's integration | `src/integrations/dsm/`, `src/modules/main/dsm.ts`, `src/gui/Dsm*.vue`, `src/gui/Market.vue` | Connect, deliveries, payments, market, verified holdings, and the overlay. |

## What the game grants on

The relay between wallet and game is transport, never evidence (A11). The game grants only on what its own account established (`connect.app.status`):

- **a capsule** only when the wallet's 3 WILD transfer has been accepted onto the game account's own relationship with the wallet. An answer saying "paid" grants nothing.
- **coins and the roster** only from holdings proofs. The game account verifies each one: it walks the wallet's economic root at the proven position and recomputes that root from each Sparse Merkle path. A proof counts only while the wallet's next register cell is empty at its leader.
- **a creature delivery**: the wallet first roots the object's policy itself (it re-hashes the policy to the anchor and checks the creator is the game), then receives the object by transfer.

The domain's `ledger: 'dsm'` mode keeps the reducer from becoming a second ledger. A victory credits no coins, `buy-capsule` is refused, and a capsule comes only from `grant-capsule` with a payment fact used once. Coins and the roster follow verified holdings. A creature sent to another phone leaves this party and joins theirs, its game data travelling with its anchor.

## The overlay

Press **DSM** (top right) or **D**. Every step shows on one timeline:

- **WEB2**: what the game server did on its own (walking, battle turns, encounters, rests).
- **DSM**: every call the game's account made and every relay exchange with a wallet, as the account recorded it: the route, what was asked and answered, the account's economic position before and after, its economic root and its Device Tree commitment. Timings are measured by the game.

Play once with it closed: it is just a game. Then open it.

## Running it

1. The game's account, from the `dsm` repo (it uses the network's pinned set, the same one the phones use):

   ```
   cargo run --release -p dsm-app-host -- \
     --data-dir ~/.wildstate-account \
     --env-config <dsm>/dsm_client/frontend/public/dsm_env_config.toml \
     --game-bind 127.0.0.1:8787 --relay-bind 0.0.0.0:8443 \
     --relay-endpoint https://<this machine's LAN address>:8443 --relay-name <LAN address>
   ```

   The first start creates the account and writes its recovery mnemonic to `<data-dir>/RECOVERY_MNEMONIC` (readable by this user only).

2. The game, in DSM mode. The game server runs in Node and reaches the account:

   ```
   DSM_APP_HOST=http://127.0.0.1:8787 DSM_APP_HOST_SECRET_FILE=~/.wildstate-account/ingress-token npm run dev
   ```

   The host writes a new ingress secret to `<data-dir>/ingress-token` at every launch and refuses a call without it. The game reads that file for each call, so a restarted host is reached with its new secret.

   The first start claims ERA from the faucet if the account needs it, creates WILD and opens the WILD/ERA market. Progress shows in the overlay. The game's own record is `data/dsm-game.json`.

3. The game shows a connect code. Playing on the phone itself (open the game's Network URL in the phone's browser): tap **OPEN DSM WALLET**; the wallet opens on Apps with the code filled in; **READ**, **APPROVE**, then back to the browser, where the game picks the connection up. Playing on another screen: on the phone, **APPS** → **SCAN CODE** (or paste the code text and **READ**), then **APPROVE**. Phone and computer must be on the same network, and the computer must accept incoming connections to `dsm-app-host` (macOS: allow it when the firewall asks, or under System Settings → Network → Firewall).

   On a development rig with the phones on adb, the relay can run on loopback instead: start the host with `--relay-bind 127.0.0.1:8443 --relay-endpoint https://127.0.0.1:8443 --relay-name 127.0.0.1` and run `adb reverse tcp:8443 tcp:8443` for each phone. The certificate pin, not the address, is what the wallet trusts.

Reloading the page resumes the connection: after connecting, the game gives the browser a random login token (a Web2 login, never DSM authority) and resumes the session it names while the game's account still holds it.

There is no game without the account: `npm run dev` refuses to start without `DSM_APP_HOST`, and nothing in the game keeps coins or creatures of its own.

## What it took on three phones (2026-10-04)

Measured on Samsung A16s against the beta storage fleet:

- connect, from code shown to grant approved: about 20–30 s (the offer is 50 KB of signed bytes over pinned TLS);
- a creature issued and delivered as a state object: about 6 s, then the wallet takes it in on its next inbox poll;
- a capsule bought in WILD under the grant, granted only once the game's account accepted the transfer: about 26 s;
- a SoFi quote: about 3–4 minutes the first time (the wallet verifies each vault on the network that a route could use), about 15 s after;
- a swap under the grant: realized without touching the phone; a swap over the grant's per-request cap waited on the phone (Apps → Waiting) until the player approved it.

A creature the game sent stays in the party, marked as on its way, until a holdings proof shows the wallet holding it.

## Not built

- Several game servers sharing one account.
- Showing a wallet's creatures that are not on screen. The game asks about every creature it issued, which is fine at demo scale.
- Recovering a profile from DSM evidence alone. Profiles are the game's own record, keyed by wallet.
- The game's map tiles and character spritesheets (`spritesheets/hero.png`, `female.png`, `ranger.png`) are not in this repository: the map renders as plain grass. This predates the DSM integration.
