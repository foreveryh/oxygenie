import { intlayer, intlayerProxy } from 'vite-intlayer';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { defineConfig, loadEnv, type ConfigEnv, type ViteDevServer } from 'vite';
import tsConfigPaths from 'vite-tsconfig-paths';
import browserEcho from '@browser-echo/vite';
import Icons from 'unplugin-icons/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';

export default ({ mode }: ConfigEnv) => {
  // Regression in TanStack Start RC1: loadEnv now keeps the VITE_ prefix, so we
  // manually clear the prefix until upstream restores the previous behaviour.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));

  return defineConfig({
    server: {
      port: 3000,
      allowedHosts: ['db15f87f452b.ngrok-free.app'],
    },
    ssr: {
      // Externalize pg and @mastra/pg to avoid ESM/CJS interop TDZ errors
      // The 'pg' package is CommonJS, and bundling it causes "Cannot access 'pg' before initialization"
      // sharp: native .node binary (canvas asset thumbnails) — bundling traces/copies it
      // incorrectly (native addon ends up missing from .output entirely); externalizing
      // makes the SSR build resolve it via normal node_modules require at runtime instead.
      external: ['pg', '@mastra/pg', 'playwright', 'sharp'],
    },
    build: {
      // Increase chunk size warning limit to accommodate i18n content files
      // Reference: https://github.com/vitejs/vite/discussions/9440
      chunkSizeWarningLimit: 1000, // 1MB instead of default 500KB
      rollupOptions: {
        // Exclude standalone scripts from the build (they have shebangs that break esbuild)
        external: [/ws-server\.mjs$/, /ws-query-worker\.mjs$/, 'playwright', 'sharp'],
      },
    },
    plugins: [
      intlayerProxy(),
      nitro(),
      tsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
      intlayer(),
      // WebSocket server: handled by Nitro plugin (server/plugins/websocket.mjs)
      // Dev mode: start manually with "node ws-server.mjs"
      tanstackStart({
        router: {
          routeFileIgnorePattern:
            '.content.(ts|tsx|js|mjs|cjs|jsx|json|jsonc|json5)$',
        },
      }),
      viteReact(),
      Icons({
        compiler: 'jsx',
        jsx: 'react',
        autoInstall: true,
      }),
      tailwindcss(),
      browserEcho({
        // TanStack Start specific configuration
        injectHtml: false, // TanStack Start doesn't use index.html
        stackMode: 'condensed', // Better stack traces
        colors: true,
        fileLog: {
          enabled: false, // Enable file logging to logs/frontend
        },
        networkLogs: {
          enabled: true,
          bodies: {
            request: true,
            response: true,
          },
        },
      }),
    ],
  });
};
