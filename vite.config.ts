import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** Files from public/ that the service worker should also keep offline. */
const PUBLIC_FILES = ['/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

/**
 * Builds the service worker from src/sw/sw.js after Vite has bundled the app.
 * Vite gives every JS/CSS file a content hash in its name, so we inject the
 * final list of files (and a version derived from their contents) into the
 * worker. When anything in the app changes, sw.js changes too, and the
 * browser installs the new version.
 */
function serviceWorker(): Plugin {
  return {
    name: 'crowdmate-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      // Precache only what the visitor screens need: the entry chunk and
      // everything it imports statically (plus their CSS). Staff screens and
      // the QR library load on demand and are cached the first time they're used.
      const needed = new Set<string>();
      const visit = (fileName: string) => {
        const item = bundle[fileName];
        if (!item || needed.has(fileName)) return;
        needed.add(fileName);
        if (item.type !== 'chunk') return;
        for (const css of item.viteMetadata?.importedCss ?? []) needed.add(css);
        for (const imported of item.imports) visit(imported);
      };
      for (const item of Object.values(bundle)) if (item.type === 'chunk' && item.isEntry) visit(item.fileName);
      const files = [...needed]
        .filter((name) => name !== 'index.html')
        .map((name) => `/${name}`)
        .sort();
      const hash = createHash('sha256');
      for (const item of Object.values(bundle)) {
        hash.update(item.fileName);
        hash.update(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source));
      }
      const version = hash.digest('hex').slice(0, 12);
      const template = readFileSync(fileURLToPath(new URL('./src/sw/sw.js', import.meta.url)), 'utf8');
      const source = template
        .replace('__CROWDMATE_VERSION__', version)
        .replace('__CROWDMATE_PRECACHE__', JSON.stringify(['/', ...PUBLIC_FILES, ...files]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Warn during build if any chunk grows past 250 kB (our size budget).
    chunkSizeWarningLimit: 250,
    rolldownOptions: {
      output: {
        // React rarely changes, so it gets its own long-cached file. An app
        // update then downloads only our code, not React again.
        codeSplitting: {
          groups: [{ name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
});
