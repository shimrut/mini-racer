import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';
import { DEBUG_MODULE_STUBS } from './tools/debug-module-stubs.js';

// Client source maps go next to dist/client, unlinked ('hidden'); load one in devtools to read a live error.
const CLIENT_SOURCEMAP_DIR = fileURLToPath(new URL('./dist/client-sourcemaps', import.meta.url));

export function validateWebviewEntrypoints(entrypoints) {
    const entries = [...new Set(Object.values(entrypoints).map((entry) => entry.entry))];
    return {
        name: 'mini-racer-validate-webview-entrypoints',
        applyToEnvironment: (environment) => environment.name === 'client',
        generateBundle: {
            order: 'post',
            handler(_options, bundle) {
                const missing = entries.filter((entry) => !bundle[entry]);
                if (missing.length) this.error(`Missing WebView entrypoints in bundle: ${missing.join(', ')}`);
            },
        },
        writeBundle: {
            order: 'post',
            handler(options) {
                const missing = entries.filter((entry) => !existsSync(path.join(options.dir, entry)));
                if (missing.length) this.error(`Missing WebView entrypoints on disk: ${missing.join(', ')}`);
            },
        },
    };
}

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

function keepClientSourceMapsLocal() {
    return {
        name: 'mini-racer-keep-client-source-maps-local',
        applyToEnvironment: (environment) => environment.name === 'client',
        buildStart() {
            rmSync(CLIENT_SOURCEMAP_DIR, { recursive: true, force: true });
        },
        writeBundle(options) {
            const maps = readdirSync(options.dir, { recursive: true })
                .filter((file) => String(file).endsWith('.map'));
            for (const file of maps) {
                const target = path.join(CLIENT_SOURCEMAP_DIR, file);
                mkdirSync(path.dirname(target), { recursive: true });
                renameSync(path.join(options.dir, file), target);
            }
        },
    };
}

export default defineConfig({
    root: '.',
    plugins: [
        stripDebugModules(),
        keepClientSourceMapsLocal(),
        validateWebviewEntrypoints(JSON.parse(
            readFileSync(new URL('./devvit.json', import.meta.url), 'utf8'),
        ).post.entrypoints),
        devvit({
            client: {
                build: {
                    chunkSizeWarningLimit: 2000,
                    sourcemap: 'hidden',
                    rollupOptions: {
                        output: {
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
