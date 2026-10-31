import { defineConfig } from 'vite';
import { rpgjs, tiledMapFolderPlugin } from '@rpgjs/vite';
import vue from '@vitejs/plugin-vue';
import startServer from './src/server';
import { PROTOCOL } from './src/protocol';

export default defineConfig(({ command }) => {
  // Wildstate runs on DSM: what a player owns is in their wallet, and the game's
  // own account (dsm-app-host) is how the game reaches it. No account, no game.
  if (command === 'serve' && !process.env.DSM_APP_HOST) {
    throw new Error('Wildstate runs on DSM: set DSM_APP_HOST to the game account host (dsm-app-host), e.g. http://127.0.0.1:8787');
  }
  if (command === 'serve' && !process.env.DSM_APP_HOST_SECRET_FILE) {
    throw new Error("Wildstate runs on DSM: set DSM_APP_HOST_SECRET_FILE to the game account host's <data-dir>/ingress-token");
  }
  return {
    // The version a game report quotes: the release build's (scripts set WILDSTATE_VERSION_NAME), else "dev".
    define: { __WILDSTATE_VERSION__: JSON.stringify(process.env.WILDSTATE_VERSION_NAME ?? 'dev') },
    optimizeDeps: {
      include: ['pixi.js > @xmldom/xmldom']
    },
    plugins: [vue(),
      // The development server answers the clients' version check as scripts/server.mjs does,
      // including for a debug Android build, whose bundled client has its own origin.
      {
        name: 'wildstate:version',
        configureServer(server) {
          server.middlewares.use('/version', (_request, response) => {
            response.setHeader('Access-Control-Allow-Origin', '*');
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ protocol: PROTOCOL }));
          });
        },
      },
      // Characters glide over each short step instead of being drawn at once (src/gui/step-smoothing.ts).
      {
        name: 'wildstate:step-smoothing',
        enforce: 'pre',
        load(id) {
          if (!id.replace(/\\/g, '/').endsWith('@rpgjs/client/dist/components/recoil-smoothing.js')) return null;
          return `export { RecoilSmoothing } from ${JSON.stringify(new URL('./src/gui/step-smoothing.ts', import.meta.url).pathname)};`;
        },
      },
      tiledMapFolderPlugin({
        sourceFolder: './src/tiled',      // Folder containing your TMX files
        publicPath: '/map',               // Public URL path for maps
        allowedExtensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
        buildOutputPath: 'map'            // Match the runtime Tiled URL prefix
      }),
      ...rpgjs({
        server: startServer
      })
    ],
  };
});
