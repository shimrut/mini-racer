import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedis = {
    hSetNX: vi.fn(),
    hIncrBy: vi.fn(),
    hGetAll: vi.fn(),
    expire: vi.fn(),
};

vi.mock('@devvit/redis', () => ({ redis: mockRedis }));

describe('server analytics store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.hSetNX.mockResolvedValue(1);
        mockRedis.hIncrBy.mockResolvedValue(1);
        mockRedis.hGetAll.mockResolvedValue({});
        mockRedis.expire.mockResolvedValue(true);
    });

    it('records game open and close session counters', async () => {
        const { submitServerAnalyticsEvent } = await import('../src/server/analytics-store.ts');

        await submitServerAnalyticsEvent({
            eventName: 'game_opened',
            playerId: 'browser-player',
            sessionId: 'session-1',
            payload: {
                clientPlatform: 'ios',
                clientVersion: '2026.12',
                language: 'en-US',
                timezone: 'America/New_York',
                screenBucket: 'sm',
                orientation: 'portrait',
            },
            context: { redditUsername: null },
        });
        await submitServerAnalyticsEvent({
            eventName: 'game_closed',
            playerId: 'browser-player',
            sessionId: 'session-1',
            payload: { durationSec: 12.345 },
            context: { redditUsername: null },
        });
        await submitServerAnalyticsEvent({
            eventName: 'game_playtime_chunk',
            playerId: 'browser-player',
            sessionId: 'session-1',
            payload: { durationSec: 12.345 },
            context: { redditUsername: null },
        });

        expect(mockRedis.hSetNX).toHaveBeenCalledWith(
            expect.stringContaining(':players'),
            'guest:browser-player',
            '1',
        );
        expect(mockRedis.hSetNX).toHaveBeenCalledWith(
            expect.stringContaining(':sessions'),
            'session-1',
            '1',
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'sessions',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'context:platform:ios',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'context:client_version:2026.12',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'context:language:en-us',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'context:timezone:america/new_york',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'context:screen_bucket:sm',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'context:orientation:portrait',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'game_session_duration_ms_total',
            12345,
        );
    });

    it('records race start source, track play, end cause, and restart source', async () => {
        const { submitServerAnalyticsEvent } = await import('../src/server/analytics-store.ts');

        await submitServerAnalyticsEvent({
            eventName: 'race_started',
            playerId: 'browser-player',
            sessionId: 'session-1',
            payload: {
                source: 'leaderboard_modal',
                trackKey: 'circuit',
            },
        });
        await submitServerAnalyticsEvent({
            eventName: 'race_ended',
            playerId: 'browser-player',
            sessionId: 'session-1',
            payload: {
                cause: 'crash',
                trackKey: 'circuit',
                runTimeSec: 8.2,
            },
        });
        await submitServerAnalyticsEvent({
            eventName: 'race_restarted',
            playerId: 'browser-player',
            sessionId: 'session-1',
            payload: {
                source: 'auto_restart_after_collision',
                trackKey: 'circuit',
            },
        });

        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'race_started:source:leaderboard_modal',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'track:circuit:played',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'race_ended:cause:crash',
            1,
        );
        expect(mockRedis.hIncrBy).toHaveBeenCalledWith(
            expect.stringContaining(':counters'),
            'race_restarted:source:auto_restart_after_collision',
            1,
        );
    });

    it('returns a dated summary from daily Redis counters', async () => {
        const { getServerAnalyticsSummary } = await import('../src/server/analytics-store.ts');
        mockRedis.hGetAll.mockResolvedValue({
            active_players: '3',
            sessions: '4',
            game_session_duration_ms_total: '90000',
            'context:platform:android': '2',
            'context:client_version:2026.12': '2',
            'context:language:en-us': '3',
            'context:timezone:europe/bucharest': '2',
            'context:screen_bucket:md': '3',
            'context:orientation:landscape': '2',
            race_started: '9',
            'race_started:source:main_menu': '5',
            'race_ended:cause:crash': '2',
            'race_ended:cause:finish': '7',
            'race_restarted:source:improve_restart_after_win': '4',
            'track:circuit:played': '6',
            'track:circuit:race_ended:cause:finish': '5',
        });

        const summary = await getServerAnalyticsSummary({
            from: '2026-06-06',
            to: '2026-06-06',
        });

        expect(summary.days).toHaveLength(1);
        expect(summary.days[0]).toMatchObject({
            date: '2026-06-06',
            activePlayers: 3,
            sessions: 4,
            totalPlaytimeMs: 90000,
            context: {
                platforms: { android: 2 },
                clientVersions: { '2026.12': 2 },
                languages: { 'en-us': 3 },
                timezones: { 'europe/bucharest': 2 },
                screenBuckets: { md: 3 },
                orientations: { landscape: 2 },
            },
            raceStarts: expect.objectContaining({
                total: 9,
                mainMenu: 5,
            }),
            raceEnds: expect.objectContaining({
                crash: 2,
                finish: 7,
            }),
            restarts: expect.objectContaining({
                improveWin: 4,
            }),
            tracks: {
                circuit: expect.objectContaining({
                    played: 6,
                    raceEnds: { finish: 5 },
                }),
            },
        });
    });

    it('returns a rolling 24h summary with unique players and sessions', async () => {
        const { getServerAnalyticsSummary } = await import('../src/server/analytics-store.ts');
        mockRedis.hGetAll.mockImplementation(async (key) => {
            if (key.includes(':players')) {
                return key.includes('T0') ? { player_a: '1' } : { player_a: '1', player_b: '1' };
            }
            if (key.includes(':sessions')) {
                return key.includes('T0') ? { session_a: '1' } : { session_a: '1', session_b: '1' };
            }
            return {
                active_players: '1',
                sessions: '1',
                race_started: '2',
                'race_ended:cause:finish': '1',
            };
        });

        const summary = await getServerAnalyticsSummary({ range: 'last24h' });

        expect(summary.granularity).toBe('hour');
        expect(summary.label).toBe('Last 24h');
        expect(summary.days).toHaveLength(24);
        expect(summary.totals).toMatchObject({
            activePlayers: 2,
            sessions: 2,
            raceStarts: expect.objectContaining({ total: 48 }),
            raceEnds: expect.objectContaining({ finish: 24 }),
        });
    });
});
