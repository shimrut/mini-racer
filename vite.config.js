import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';
import { DEBUG_MODULE_STUBS } from './tools/debug-module-stubs.js';

// Swap each developer-tooling module for its no-op stub so the code is not in
// the bundle to reach. See `tools/debug-module-stubs.js` for why a runtime gate
// cannot do this. `npm test` and local runs load the real modules.
function stripDebugModules() {
    return {
        name: 'mini-racer-strip-debug-modules',
        enforce: 'pre',
        resolveId(source) {
            if (source.endsWith('.stub.js')) return null;
            const match = DEBUG_MODULE_STUBS.find((entry) => source.endsWith(entry.suffix));
            return match ? match.stubPath : null;
        },
    };
}

export default defineConfig({
    root: '.',
    plugins: [
        stripDebugModules(),
        devvit({
            client: {
                build: {
                    chunkSizeWarningLimit: 2000,
                    rollupOptions: {
                        output: {
                            // Hash filenames so every importer resolves one canonical module URL.
                            entryFileNames: '[name]-[hash].js',
                            chunkFileNames: '[name]-[hash].js',
                            assetFileNames: (asset) => {
                                const names = asset.names ?? (asset.name ? [asset.name] : []);
                                return names.some((name) => name.endsWith('.css'))
                                    ? '[name]-[hash][extname]'
                                    : '[name][extname]';
                            },
                            sourcemapFileNames: '[name]-[hash].js.map'
                        }
                    }
                }
            }
        })
    ]
});
