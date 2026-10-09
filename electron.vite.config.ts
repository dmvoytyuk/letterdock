import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { APP_CSP } from './src/shared/appCsp';

const CSP_PROD = APP_CSP;

// Dev needs the Vite HMR inline preamble and websocket.
const CSP_DEV = CSP_PROD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
);

function cspPlugin(): Plugin {
  return {
    name: 'mailroom-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const csp = ctx.server ? CSP_DEV : CSP_PROD;
        return html.replace(
          '<!--CSP-->',
          `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
        );
      },
    },
  };
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Two main-style bundles: the app shell and the engine (utility process).
        input: {
          index: resolve('src/main/index.ts'),
          engine: resolve('src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // The compose window (a separate BrowserWindow) has its own entry.
          compose: resolve('src/renderer/compose.html'),
          // The message window ("open in new window").
          viewer: resolve('src/renderer/viewer.html'),
        },
      },
    },
    plugins: [react(), cspPlugin()],
  },
});
