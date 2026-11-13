# Wildstate

A creature-collecting RPG that plugs into DSM. Wildstate is an Android app. What you own in it, your WILD coin and every creature you catch, is an object in your DSM wallet, not a row on a game server.

Wildstate is in beta. Everything in it is test value: never send real Bitcoin, real crypto or anything of value to a beta wallet.

## Install

You need two apps on an Android 8 or newer phone:

1. **The DSM wallet**, from the [DSM releases](https://github.com/deterministicstatemachine/dsm/releases). Install it and set up a wallet first.
2. **Wildstate**, `wildstate.apk`, from this repository's [Releases](https://github.com/Irrefutable-Labs/wildstate-dsm/releases).

Each APK is a signed release build (Wildstate's signer is `CN=Wildstate, O=DSM`; every update is signed with the same key). Download the APK on the phone, open it, and allow installation from your browser or file manager when Android asks. Check the SHA-256 against the one on the release page if you want to be sure of the file.

The app connects to the public game server by itself. The game server stays online and authoritative: Wildstate is not an offline game. If the server has moved on to a newer version than your app, the game tells you to install the update from Releases.

## Connect your wallet

Open Wildstate. It shows a connect code. Either tap **OPEN DSM WALLET** on the same phone, or scan the code with the DSM wallet on another phone. Read what the game asks for and approve it in the wallet. From then on the game asks your wallet for what you approved (send WILD for what you buy, accept the creatures it gives you, trade at the market, prove what you own), and anything outside it waits for you in the wallet under **Apps → Waiting**.

## Playing

- **Walk** with the thumbstick. The camp is where you start.
- **Tall grass.** Walk into tall grass for a wild encounter: the meadow east of camp, and Rowan's field in the north-west. Weaken a creature to 14 HP or less, throw a capsule and name it. It joins your BAG and arrives in your wallet's Objects, an object of its own.
- **Pond.** CAST at the water's edge to fish. Water creatures come only from the pond.
- **Battles.** Each species has four moves: an unlimited Strike and three with charges. Elements matter (fire beats grass; grass beats water and volt; water beats fire; volt beats water), and moves can burn, root, stun or soak. HP and charges carry into the next fight.
- **Camp.** Mira, by the fire, rests your party. Rowan, north of her, gives guidance. The scarecrow in the garden hands out free capsules now and then.
- **Trainers.** Kade at the meadow's edge and Nessa by the pond fight with teams of three. Beating one gives your wallet a 12 WILD bounty.
- **Bramble's trading post.** BUY capsules, poultices and tonics: your wallet sends the WILD. SELL a creature to Bramble for WILD. SKINS sells Halloween looks you wear on the map.
- **Market.** Trade WILD and ERA at the game's vaults: PRICE shows what a trade gets, TRADE asks your wallet to make it.
- **Arena.** Play other players: free matches, or staked ones where each wallet locks its own stake and the winner collects both. Matches are decided by a pinned program, not by a referee.
- **BAG.** Your creatures (SWAP IN picks the lead; TEAM picks up to three for trainer battles and the arena), your items and skins, your wallet, and REPORT.
- **DSM.** Press **DSM** to see what ran on DSM and what ran only on the game server.

## Beta missions and reports

The starter missions are handed out in the beta channel. After that, every Monday morning the camp's **bulletin board** (in the garden by the scarecrow) pins up the week's missions, with COPY ALL to take the list elsewhere.

Your weekly report has two halves:

- **Wallet missions (M) and wallet bugs:** send them from the DSM wallet, Settings → Report a problem.
- **Wildstate missions (G) and game bugs:** send them from the game, BAG → REPORT. It fills in a GitHub issue for you, with the game's details attached.

Bug reports and mission reports also land in this repository's [issues](https://github.com/Irrefutable-Labs/wildstate-dsm/issues); the templates there match what the game fills in.

## Developing

The game is RPGJS v5 (Vue client, Node server), plugged into DSM: the game server has a DSM account of its own (`dsm-app-host`), and players connect their wallets to it (DSM Connect, Amendment A11; see `docs/dsm-integration.md`). There is no local mode: the game does not start without its account.

- `npm install`, start the game's account (`docs/dsm-integration.md`), then `DSM_APP_HOST=http://127.0.0.1:8787 DSM_APP_HOST_SECRET_FILE=<ingress-secret-dir>/ingress-token npm run dev`. With no phone, DSM's terminal wallet (`make dev-wallet` in a `dsm` checkout) plays the player.
- `npm test`, `npm run typecheck` and `npm run build` after a change. After a change to DSM's `proto/dsm_app.proto`, `npm run proto:gen` (it reads `../dsm/proto`, or `DSM_PROTO_DIR`).
- **The Android app:** `docs/android-app.md` covers debug builds against a development server and the signed release APK. Art and client changes reach players only in a new APK; the weekly missions are a file on the server and need no build.
- **The game server:** `deploy/README.md` covers the production host.
- **Art:** the camp map is `src/tiled/simplemap.tmx`; the creature, character and skin art and how it is packed are under `docs/` and `scripts/`.
- **Agent skills:** `.agents/skills/rpgjs` and `.agents/skills/dsm-creature-game`; `AGENTS.md` routes work to both.

Scaffold provenance: `rpgjs/starter`, v5, commit `e52f06dc1894feaf19bd8180bcfdbe140e56cfe0`. The starter's Pipoya ground tiles keep their upstream credits.
