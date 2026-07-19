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

        // Shared client identity helpers used by store/share
        'game/shared/leaderboard-identity.js',

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
        'src/server/moderator-access.ts',

        // Redis ownership + post/podium publication integrity
        'src/server/redis-lock.ts',
        'src/server/redis-compressed-value.ts',
        'src/server/daily-gp-post-store.ts',
        'src/server/daily-podium-post-store.ts',
        'src/server/daily-podium-service.ts',
        'src/server/daily-post-service.ts',
        'src/server/daily-autopost-store.ts',
        'src/server/daily-podium-autopost-store.ts',
        'src/server/daily-gp-history-backfill.ts'
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
