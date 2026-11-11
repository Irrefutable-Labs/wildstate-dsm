# How Wildstate plugs into DSM

Wildstate stays an ordinary Web2 game. Walking, encounters, battles, dialogue and healing run on the game server and never touch DSM. The game plugs into DSM: its server has a DSM account of its own, and each player connects their DSM wallet to it. What a player owns is an object in their wallet:

- **WILD**, the game's coin: an object of fixed supply (1,000,000) that the game's account issued. The account gives players WILD from it: 10 after connecting, 5 for a victory, 12 for beating a trainer.
- **Creatures**: each caught creature is an object of supply one, which the game's account issues at the capture and gives to the player's wallet. Its committed policy names the game's account as issuer, plus the species and the capture number. Its policy commitment (its anchor) is the creature's identity. HP, XP and charges are game data keyed by that identity.
- **The market**: five WILD/ERA SoFi vaults the game's account funds in equal slices. The game's account prices a trade from the vaults' public state; the player's wallet carries out an ordinary SoFi trade (multi-hop when the route needs it).
- **Staked matches**: each player's wallet locks its own stake for the match, and a pinned program (DSM's `wildstate-duel`, vendored in `src/vendor/wildstate-duel`) decides the match from both wallets' signed moves (SoFi S22). The winner's wallet collects both stakes. The game relays; it decides nothing.

This is DSM Connect, DSM Amendment A11 in `specs/DSM_High_Level_Explainer.md` (the explainer's "a game" passage, §78, made concrete). DSM's [BUILDING_APPS.md](https://github.com/deterministicstatemachine/dsm/blob/main/BUILDING_APPS.md) is the general guide for any app that plugs in.

## Pieces

| Piece | Where | What it is |
|---|---|---|
| The game's DSM account | `dsm` repo, `crates/dsm-app-host` | One real DSM identity on the production SDK path, on the network's pinned storage set. Serves the game a local protobuf ingress (`/ingress`, `/activity`), on loopback only and behind a secret written at each launch, and serves wallets the DSM Connect relay over TLS pinned by the connect code. |
| DSM Connect | `dsm_sdk::sdk::connect`, the `connect.*` and `connect.app.*` routes | Connecting by code, signed offers and answers, the grant, proofs of what a wallet owns. |
| The wallet's Apps screen | `dsm_client/frontend/src/components/screens/AppsScreen.tsx` | Scan a connect code, approve, see grants and spending, answer waiting requests, disconnect. |
| The game's side | `src/integrations/dsm/`, `src/modules/main/dsm.ts`, `src/modules/main/staked.ts`, `src/gui/Dsm*.vue`, `src/gui/Market.vue` | Connect, deliveries, payments, the market, owns proofs, staked matches, and the overlay. |

## What the game asks for

A connect code names one offer, signed by the game's account. The grant the player approves lets the game, without asking again:

- **accept**: hand the player the objects the game issued (its creatures);
- **send**: be sent WILD, up to 1,000 WILD a request and 100,000 in all (capsules, items, skins);
- **trade**: trade WILD and ERA through the game's vaults, within caps;
- **owns**: be shown a proof of the WILD, ERA and creatures the wallet owns;
- **matches**: take stakes in matches the pinned program decides, up to 1,000 WILD a match and 10,000 in all;
- **contacts**: see which of the wallet's contacts play, as DSM IDs only, for FRIENDS in the arena.

Requests that spend nothing (proofs, accepts, contact lookups, every move of a match) run without asking, up to the 4,096 the offer names. Past that, or past a cap, a request waits for the player in the wallet, under Apps → Waiting.

## What the game acts on

The relay between wallet and game is transport, never evidence (A11). Every request has two answers: the wallet's word (its outcome), and the fact the game's own account established (`connect.app.status`). The game acts only on the fact:

- **a capsule**, or any item Bramble sells, only when the game's account accepted the WILD the wallet sent. A wallet saying it paid grants nothing.
- **coins and the roster** only from owns proofs. The game's account verifies each one: it walks the wallet's economic root at the proven position and recomputes that root from each Sparse Merkle path. A proof counts only while the wallet's next register cell is empty at its leader.
- **a creature delivery**: the wallet first accepts the object (it re-hashes the policy to the anchor and checks the issuer is the game), then the game's account gives it.

The game's reducer never becomes a second ledger: a victory credits no coins, and an item comes only with a payment fact, used once. Coins and the roster follow what the wallet proved it owns. A creature a player sends to another wallet leaves their party and joins the other player's, its game data travelling with its anchor.

## The overlay

Press **DSM** (top right) or **D**. Every step shows on one timeline, in two lanes:

- **GAME**: what the game server did on its own (walking, battle turns, encounters, rests). Web2.
- **WALLET**: every call the game's account made and every relay exchange with a wallet, as the account recorded it: the route, what was asked and answered, the account's economic position before and after, its economic root and its Device Tree commitment. Timings are measured by the game.

Play once with it closed: it is just a game. Then open it.

## Running it

1. The game's account, from a `dsm` checkout. It joins the network's pinned storage set, the same one the wallets use (the beta network). An account exists only on the set it was made on: the beta set was reprovisioned on 2026-11-11, so an account made before then is gone, and a fresh `--data-dir` makes a new one.

   ```
   cargo run --release -p dsm-app-host -- \
     --data-dir ~/.wildstate-account --ingress-secret-dir ~/.wildstate-ingress \
     --env-config dsm_client/frontend/public/dsm_env_config.toml \
     --game-bind 127.0.0.1:8787 --relay-bind 0.0.0.0:8443 \
     --relay-endpoint https://<this machine's LAN address>:8443 --relay-name <LAN address>
   ```

   The first start creates the account and writes its recovery mnemonic to `<data-dir>/RECOVERY_MNEMONIC` (readable by this user only). `make app-dev` in the `dsm` checkout runs the same host for you on the beta network, with its relay on loopback (`https://127.0.0.1:8443`) and its secret in `.dsm-dev/app/ingress/ingress-token`.

2. The game. Its server runs in Node and reaches the account:

   ```
   DSM_APP_HOST=http://127.0.0.1:8787 DSM_APP_HOST_SECRET_FILE=~/.wildstate-ingress/ingress-token npm run dev
   ```

   The host writes a new ingress secret to `<ingress-secret-dir>/ingress-token` at every launch and refuses a call without it. That directory holds the secret alone (the host refuses one that is, or contains, its data directory), so the game is given the secret and never the account's keys or recovery mnemonic. The game reads the file for each call, so a restarted host is reached with its new secret.

   The first page that opens sets the account up: ERA from the faucet if the account needs it (about eight claims), then WILD issued and the market's five vaults funded. Progress shows in the overlay. The game's own record is `data/dsm-game.json` (with `npm start`, `WILDSTATE_DATA_DIR/dsm-game.json`).

3. The game shows a connect code. Playing on the phone itself (open the game's Network URL in the phone's browser): tap **OPEN DSM WALLET**; the wallet opens on Apps with the code filled in; **READ**, **APPROVE**, then back to the browser, where the game picks the connection up. Playing on another screen: on the phone, **APPS** → **SCAN CODE** (or paste the code text and **READ**), then **APPROVE**. Phone and computer must be on the same network, and the computer must accept incoming connections to `dsm-app-host` (macOS: allow it when the firewall asks, or under System Settings → Network → Firewall).

   On a development rig with the phones on adb, the relay can run on loopback instead: start the host with `--relay-bind 127.0.0.1:8443 --relay-endpoint https://127.0.0.1:8443 --relay-name 127.0.0.1` and run `adb reverse tcp:8443 tcp:8443` for each phone. The certificate pin, not the address, is what the wallet trusts.

   With no phone, DSM's terminal wallet plays the player. In the `dsm` checkout, `make dev-wallet` runs a player's wallet (a second account on the beta network, funded by the faucet), and `make dev-wallet-connect CODE=<the code text>` connects it (**Copy the code text** on the connect screen copies it). A request that waits for the player shows in `make dev-wallet-pending`; `make wallet ARGS="approve <connection> <seq>"` approves it.

Reloading the page resumes the connection: after connecting, the game gives the browser a random resume token (Web2 only, never DSM authority) and resumes the connection it names while the game's account still holds it.

There is no game without the account: `npm run dev` refuses to start without `DSM_APP_HOST` and `DSM_APP_HOST_SECRET_FILE`, and nothing in the game keeps coins or creatures of its own.

## What it took on three phones (2026-10-04)

Measured on Samsung A16s against the beta storage fleet of the time:

- connect, from code shown to grant approved: about 20–30 s (the offer is 50 KB of signed bytes over pinned TLS);
- a creature issued and given as an object: about 6 s, then the wallet takes it in on its next inbox poll;
- a capsule bought with WILD under the grant, granted only once the game's account accepted the payment: about 26 s;
- a SoFi price: about 3–4 minutes the first time (the wallet verified each vault on the network that a route could use), about 15 s after;
- a trade under the grant: realized without touching the phone; a trade over the grant's per-request cap waited on the phone (Apps → Waiting) until the player approved it.

A creature the game gave stays in the party, marked as on its way, until an owns proof shows the wallet owns it.

## Not built

- Several game servers sharing one account.
- Showing a wallet's creatures that are not on screen. The game asks about every creature it issued, which is fine at demo scale.
- Recovering a profile from DSM evidence alone. Profiles are the game's own record, keyed by wallet.
