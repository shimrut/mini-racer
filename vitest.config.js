import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.js'],
        globalSetup: ['./tools/vitest-global-setup.js']
    }
});
