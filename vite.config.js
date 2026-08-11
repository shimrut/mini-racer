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
                            sourcemapFileNames: '[name]-[hash].js.map'
                        }
                    }
                }
            }
        })
    ]
});
