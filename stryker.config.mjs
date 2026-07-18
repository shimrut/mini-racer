/**
 * @type {import('@stryker-mutator/api/core').StrykerOptions}
 */
export default {
    testRunner: 'vitest',
    packageManager: 'npm',
    coverageAnalysis: 'perTest',
    reporters: ['progress', 'clear-text', 'html'],
    thresholds: {
        high: 80,
        low: 60,
        break: null
    },
    vitest: {
        configFile: 'vitest.config.js',
        related: true
    },
    mutate: [
        // Client race / scoreboard core
        'game/race/run-policy.js',
        'game/race/result-flow.js',
        'game/race/ring-buffer.js',
        'game/race/simulation.js',
        'game/race/replay.js',
        'game/track/runtime.js',
        'game/car/handling.js',
        'game/daily-challenge/storage.js',
        'game/daily-challenge/service.js',
        'game/storage.js',
        'game/scoreboard/service.js',
        'game/scoreboard/verification-queue.js',
        'game/scoreboard/snapshot.js',
        'game/shared/checkpoint-times.js',

        // Server integrity / auth / Redis
        'src/server/daily-gp-store.ts',
        'src/server/replay-validator.ts',
        'src/server/player-token.ts',
        'src/server/request-rate-limit-identity.ts',
        'src/server/pb-ghost-trace.ts',
        'src/server/daily-gp-model.ts',
        'src/server/daily-gp-share.ts',
        'src/server/pb-ghost-store.ts',
        'src/server/post-bound-challenge.ts',
        'src/server/moderator-access.ts'
    ],
    ignorePatterns: [
        '.cursor',
        'analyses/**',
        'docs/**',
        'downloaded tracks/**',
        'site/**',

        '*.css',
        '*.html',
        '*.png',
        '*.csv'
    ]
};
