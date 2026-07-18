import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    resolve: {
        alias: {
            '@devvit/analytics/client/reddit': fileURLToPath(
                new URL('./tests/helpers/devvit-journeys-client-stub.js', import.meta.url),
            ),
        },
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.js'],
        globalSetup: ['./tools/vitest-global-setup.js']
    }
});
