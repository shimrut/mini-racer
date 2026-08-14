import { defineConfig } from 'vite';
import { devvit } from '@devvit/start/vite';

export default defineConfig({
    root: '.',
    plugins: [
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
