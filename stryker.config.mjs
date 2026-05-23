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
        'game/race/run-policy.js',
        'game/race/result-flow.js',
        'game/physics-metrics.js',
        'game/daily-challenge/storage.js',
        'game/storage.js',
        'game/race/ring-buffer.js',
        'game/race/simulation.js',
        'game/track/runtime.js',
        'game/daily-challenge/service.js',
        'game/scoreboard/service.js',
        'game/services/share.js',
        'game/services/shared-client.js',
        'game/scoreboard/verification-queue.js'
    ],
    ignorePatterns: [
        'analyses/**',
        'docs/**',
        'downloaded tracks/**',
        'public/**',
        'site/**',

        'tools/**',
        '*.css',
        '*.html',
        '*.png',
        '*.csv'
    ]
};
