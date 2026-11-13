# Wildstate Android app

The Android app runs Wildstate in a hardware-accelerated WebView, in portrait, with the game icon. The game's client (art, sound, code: the web build in `dist/client`) ships inside the APK, under `assets/game/`, and is served from `https://appassets.androidplatform.net` by WebViewAssetLoader. It loads without a download and connects to the game server named by `VITE_GAME_HOST` at build time. The game server stays authoritative and online: the APK is not an offline game. DSM links open the installed DSM wallet; returning preserves the game's WebView and login storage. Wallet approval stays in the wallet. Android 8 or newer is required.

## The client and the game server

An installed app keeps its client until the player installs an update, while the server can change at any time. Before connecting, the client asks the server's `/version` for its protocol (`src/protocol.ts`):

- the same protocol: the game starts;
- a newer server: the app asks the player to install the update from Releases (a browser asks for a reload);
- an older server: the player is told the game is being updated;
- no answer: the player is told the game can't be reached, with Try again.

Bump `PROTOCOL` whenever a server change would break clients already installed. Deploy the server first, then the web frontend and the APK. The server must accept the app's origin: `WILDSTATE_ALLOWED_ORIGINS` includes `https://appassets.androidplatform.net` (see `deploy/compose.yml`). Art and client changes reach players only in a new APK.

## Local preview

Use JDK 17 or 21 and Android SDK 35. Set ANDROID_HOME, or create ignored android/local.properties with sdk.dir. `npm run android:debug` builds the web client and packages it; name the game server it connects to in VITE_GAME_HOST. Against the development server on this machine (`npm run dev`), use its LAN address with http://, for example `VITE_GAME_HOST=http://192.168.4.46:5173 npm run android:debug`; only debug builds may use plain http. The build refuses a client that names no game server. The preview is named Wildstate on the home screen but has a separate app ID (…wildstate.preview), so it does not conflict with public releases. A debug APK is not the public release.

## Public APK for GitHub

Set VITE_GAME_HOST to the public game server's hostname (HTTPS is implied), for example `wildstate.34.58.75.224.sslip.io`. Release builds reject a client built without a public HTTPS hostname, and missing signing credentials. The public manifest does not allow cleartext HTTP. The Wi-Fi address is never accepted for a release.

Use one permanent release signing key for every update. Keep an encrypted backup outside GitHub. Generate it with Android Studio's signed APK wizard or keytool; never commit the key or passwords. Configure these GitHub secrets:

- WILDSTATE_KEYSTORE_BASE64: base64 of the release keystore.
- WILDSTATE_KEYSTORE_PASSWORD: keystore password.
- WILDSTATE_KEY_ALIAS: signing key alias.
- WILDSTATE_KEY_PASSWORD: key password.

Set the repository variable VITE_GAME_HOST. Run the Android APK workflow with the game server host/version, or push a v-prefixed tag. The workflow validates the game, builds the client for that server, builds a signed APK with it, uploads an artifact, and creates a **draft** GitHub release for tags with wildstate.apk and SHA256SUMS. Test the app against the game server, touch controls, wallet handoff/return, disconnect/reconnect, and upgrades before publishing the draft. People download wildstate.apk from Releases and permit installation from their browser or file manager.

Local release builds use WILDSTATE_KEYSTORE_PATH (an absolute file path), plus the same password/alias variables. Run `VITE_GAME_HOST=<public game server> npm run android:release`. The Android package is org.deterministicstatemachine.wildstate. Increment WILDSTATE_VERSION_CODE for each distributed update.

## The Vercel frontend

Vercel serves the web frontend at https://wildstate-dsm.vercel.app/; the APK does not use it. The live RPGJS backend and the game's DSM account run separately on the existing cloud fleet with persistent room and profile storage. `VITE_GAME_HOST` selects the public backend address at frontend build time; no account keys belong in browser settings.

The game repository is https://github.com/Irrefutable-Labs/wildstate-dsm. See [production hosting](../deploy/README.md) for the exact cloud layout, network boundaries, and where production stands. Public play and a public APK remain pending until the backend's public connection and wallet workflow are verified.

References: https://developer.android.com/develop/ui/views/layout/webapps/webview, https://developer.android.com/studio/publish/app-signing, https://vercel.com/docs/functions/websockets.
