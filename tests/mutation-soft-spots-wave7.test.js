import { describe, expect, it } from 'vitest';
import {
    normalizeLimit,
    normalizeOffset,
    normalizePlayerPreferences,
    parseStoredChallenge,
    parseStoredEntry,
} from '../src/server/daily-gp-store.ts';
import {
    parseStoredPlayerProfile,
    salvagePlayerPreferences,
} from '../src/server/competition-identity.ts';
import {
    formatDailyGpShareComment,
    getValidShareRequestContext,
    normalizeShareName,
    parseSharePreviewRecord,
    parseShareSharedResult,
} from '../src/server/daily-gp-share.ts';

const VALID_CHALLENGE = {
    id: 'daily-gp-2026-07-11',
    challengeDate: '2026-07-11',
    trackKey: 'circuit',
    startsAt: '2026-07-11T00:00:00.000Z',
    endsAt: '2026-07-12T00:00:00.000Z',
    availableUntil: '2026-07-18T00:00:00.000Z',
};

const VALID_ENTRY = {
    playerId: 'reddit:player',
    trackKey: 'circuit',
    bestTimeMs: 12345,
    updatedAt: '2026-07-11T12:00:00.000Z',
};

const VALID_PROFILE = {
    playerId: 'reddit:profile',
};

const VALID_PREVIEW = {
    username: 'RaceFan',
    subredditName: 'MiniRacer',
    challengeId: 'daily-gp-2026-07-11',
    source: 'finish',
    bestTimeMs: 42380,
    commentText: 'I set a lap.',
    createdAt: '2026-07-11T12:00:00.000Z',
};

const VALID_SHARED = {
    commentId: 't1_abc123',
    commentUrl: 'https://reddit.com/r/miniracer/comments/daily/result',
    commentText: 'I set a lap.',
    username: 'RaceFan',
    createdAt: '2026-07-11T12:00:00.000Z',
};

describe('wave7 store parse helpers — direct coercion', () => {
    it('parseStoredChallenge rejects nullish, non-json, and non-object payloads', () => {
        expect(parseStoredChallenge(null)).toBeNull();
        expect(parseStoredChallenge(undefined)).toBeNull();
        expect(parseStoredChallenge('')).toBeNull();
        expect(parseStoredChallenge('not-json')).toBeNull();
        expect(parseStoredChallenge('[]')).toBeNull();
        expect(parseStoredChallenge('null')).toBeNull();
    });

    it('parseStoredChallenge coerces non-string id and challengeDate to empty and rejects', () => {
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            id: 42,
        }))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            challengeDate: null,
        }))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            challengeDate: '',
        }))).toBeNull();
    });

    it('parseStoredChallenge coerces non-string trackKey to empty and rejects unknown tracks', () => {
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            trackKey: 7,
        }))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            trackKey: '',
        }))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            trackKey: 'not-a-real-track',
        }))).toBeNull();
    });

    it('parseStoredChallenge coerces non-string date fields to empty and rejects invalid timestamps', () => {
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            startsAt: false,
        }))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            endsAt: '',
        }))).toBeNull();
        expect(parseStoredChallenge(JSON.stringify({
            ...VALID_CHALLENGE,
            availableUntil: 'not-a-date',
        }))).toBeNull();
    });

    it('parseStoredChallenge accepts a valid payload with exact coerced fields', () => {
        expect(parseStoredChallenge(JSON.stringify(VALID_CHALLENGE))).toEqual({
            id: VALID_CHALLENGE.id,
            challengeDate: VALID_CHALLENGE.challengeDate,
            trackKey: VALID_CHALLENGE.trackKey,
            startsAt: VALID_CHALLENGE.startsAt,
            endsAt: VALID_CHALLENGE.endsAt,
            availableUntil: VALID_CHALLENGE.availableUntil,
            status: 'active',
            rulesRevision: 0,
            objectiveType: 'single_lap_fastest',
            objectiveParams: { lapCount: 1 },
            skin: 'default',
        });
    });

    it('parseStoredEntry rejects nullish raw and required-field type mismatches', () => {
        expect(parseStoredEntry(null)).toBeNull();
        expect(parseStoredEntry(undefined)).toBeNull();
        expect(parseStoredEntry('')).toBeNull();
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            playerId: 1,
        }))).toBeNull();
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            playerId: '',
        }))).toBeNull();
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            bestTimeMs: 'fast',
        }))).toBeNull();
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            updatedAt: 0,
        }))).toBeNull();
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            updatedAt: '',
        }))).toBeNull();
    });

    it('parseStoredEntry coerces trackKey fallbacks and strict-replay metadata', () => {
        expect(parseStoredEntry(JSON.stringify({
            playerId: 'reddit:missing-track',
            bestTimeMs: 9000,
            updatedAt: '2026-07-11T00:00:00.000Z',
        }), 'circuit')).toMatchObject({
            trackKey: 'circuit',
            validationMethod: undefined,
            strictReplayFailureReason: null,
        });
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            trackKey: '',
            validationMethod: 'strict-replay',
            strictReplayFailureReason: 'checksum',
        }), 'circuit')).toMatchObject({
            trackKey: 'circuit',
            validationMethod: 'strict-replay',
            strictReplayFailureReason: 'checksum',
        });
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            trackKey: '',
            validationMethod: 'strict-replay',
            strictReplayFailureReason: 'checksum',
        }))).toMatchObject({
            trackKey: '',
            validationMethod: 'strict-replay',
            strictReplayFailureReason: 'checksum',
        });
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            strictReplayFailureReason: 42,
        }))).toMatchObject({
            strictReplayFailureReason: null,
        });
        expect(parseStoredEntry(JSON.stringify({
            ...VALID_ENTRY,
            trackKey: 'desertBridge',
        }), 'circuit')).toBeNull();
    });

    it('parseStoredPlayerProfile coerces timestamps, flags, and preferences', () => {
        const epoch = new Date(0).toISOString();

        expect(parseStoredPlayerProfile(null)).toBeNull();
        expect(parseStoredPlayerProfile(JSON.stringify({
            playerId: 1,
        }))).toBeNull();
        expect(parseStoredPlayerProfile(JSON.stringify({
            playerId: 'reddit:blank-ts',
            firstSeenAt: '',
            lastSeenAt: '',
            updatedAt: '',
        }))).toMatchObject({
            firstSeenAt: epoch,
        });
        expect(parseStoredPlayerProfile(JSON.stringify({
            playerId: 'reddit:old-stamps',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        }))).not.toHaveProperty('lastSeenAt');
        expect(parseStoredPlayerProfile(JSON.stringify({
            ...VALID_PROFILE,
            hasSeenGame: false,
            hasAnyData: true,
            preferences: {
                carSkin: 'red',
                trailId: 'spark',
                musicEnabled: true,
                carAudioEnabled: false,
                crashAutoRestartEnabled: true,
                crashRestartDelaySec: 0.5,
            },
        }))).toMatchObject({
            hasSeenGame: false,
            hasAnyData: true,
            preferences: {
                carSkin: 'red',
                trailId: 'spark',
                musicEnabled: true,
                carAudioEnabled: false,
                crashAutoRestartEnabled: true,
                crashRestartDelaySec: 0.5,
                pbGhostEnabled: true,
                pausePlacement: 'timer',
                pauseOnTimerEnabled: true,
                hideHudEnabled: false,
            },
        });
        expect(parseStoredPlayerProfile(JSON.stringify({
            ...VALID_PROFILE,
            preferences: {
                carSkin: '',
                trailId: 'spark',
                musicEnabled: true,
                carAudioEnabled: false,
                crashAutoRestartEnabled: true,
                crashRestartDelaySec: 0.5,
            },
        }))).toMatchObject({
            preferences: {
                carSkin: 'assets/cars/mr_mr_red.webp',
                trailId: 'spark',
                carAudioEnabled: false,
            },
        });
        expect(parseStoredPlayerProfile(JSON.stringify({
            ...VALID_PROFILE,
            preferences: 'nope',
        }))).toMatchObject({
            preferences: null,
        });
    });

    it('normalizeLimit and normalizeOffset clamp pagination inputs', () => {
        expect(normalizeLimit(undefined)).toBe(10);
        expect(normalizeLimit(NaN)).toBe(10);
        expect(normalizeLimit(0)).toBe(1);
        expect(normalizeLimit(0.9)).toBe(1);
        expect(normalizeLimit(50)).toBe(50);
        expect(normalizeLimit(200)).toBe(100);
        expect(normalizeLimit(12)).toBe(12);
        expect(normalizeLimit('12')).toBe(10);

        expect(normalizeOffset(undefined)).toBe(0);
        expect(normalizeOffset(NaN)).toBe(0);
        expect(normalizeOffset(-3)).toBe(0);
        expect(normalizeOffset(4.8)).toBe(4);
        expect(normalizeOffset(9)).toBe(9);
        expect(normalizeOffset('9')).toBe(0);
    });

    it('normalizePlayerPreferences rejects malformed preference objects', () => {
        expect(normalizePlayerPreferences(null)).toBeNull();
        expect(normalizePlayerPreferences('prefs')).toBeNull();
        expect(normalizePlayerPreferences({
            carSkin: '',
            trailId: 'spark',
            musicEnabled: true,
            carAudioEnabled: true,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.5,
        })).toBeNull();
        expect(normalizePlayerPreferences({
            carSkin: 'red',
            trailId: '',
            musicEnabled: true,
            carAudioEnabled: true,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.5,
        })).toBeNull();
        expect(normalizePlayerPreferences({
            carSkin: 'x'.repeat(161),
            trailId: 'spark',
            musicEnabled: true,
            carAudioEnabled: true,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.5,
        })).toBeNull();
        expect(normalizePlayerPreferences({
            carSkin: 'red',
            trailId: 'spark',
            musicEnabled: 'yes',
            carAudioEnabled: true,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.5,
        })).toBeNull();
        expect(normalizePlayerPreferences({
            carSkin: 'red',
            trailId: 'spark',
            musicEnabled: true,
            carAudioEnabled: true,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 1.1,
        })).toBeNull();
        expect(normalizePlayerPreferences({
            carSkin: 'red',
            trailId: 'spark',
            musicEnabled: true,
            carAudioEnabled: true,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.55,
            pbGhostEnabled: false,
        })).toEqual({
            carSkin: 'red',
            trailId: 'spark',
            musicEnabled: true,
            carAudioEnabled: true,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.6,
            pbGhostEnabled: false,
            pausePlacement: 'timer',
            pauseOnTimerEnabled: true,
            hideHudEnabled: false,
        });
    });

    it('salvagePlayerPreferences defaults only the fields it cannot read', () => {
        expect(salvagePlayerPreferences(null)).toBeNull();
        expect(salvagePlayerPreferences('prefs')).toBeNull();
        expect(salvagePlayerPreferences({
            carSkin: 'assets/cars/mr_extra_crimson.webp',
            trailId: 'gold',
            musicEnabled: 'not-a-boolean',
            carAudioEnabled: false,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.8,
            pbGhostEnabled: false,
        })).toEqual({
            carSkin: 'assets/cars/mr_extra_crimson.webp',
            trailId: 'gold',
            musicEnabled: true,
            carAudioEnabled: false,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.8,
            pbGhostEnabled: false,
            pausePlacement: 'timer',
            pauseOnTimerEnabled: true,
            hideHudEnabled: false,
        });
    });

    it('keeps a stored profile readable when one preference stops validating', () => {
        const profile = parseStoredPlayerProfile(JSON.stringify({
            playerId: 'guest:preference-drift',
            leaderboardIdentity: 'constructed',
            hasSeenGame: true,
            hasAnyData: true,
            firstSeenAt: '2026-07-01T00:00:00.000Z',
            lastSeenAt: '2026-07-02T00:00:00.000Z',
            updatedAt: '2026-07-02T00:00:00.000Z',
            preferences: {
                carSkin: 'assets/cars/mr_extra_crimson.webp',
                trailId: 'gold',
                musicEnabled: false,
                carAudioEnabled: true,
                crashAutoRestartEnabled: true,
                crashRestartDelaySec: 9,
                pbGhostEnabled: true,
            },
        }));

        expect(profile.preferences).toEqual({
            carSkin: 'assets/cars/mr_extra_crimson.webp',
            trailId: 'gold',
            musicEnabled: false,
            carAudioEnabled: true,
            crashAutoRestartEnabled: true,
            crashRestartDelaySec: 0.5,
            pbGhostEnabled: true,
            pausePlacement: 'timer',
            pauseOnTimerEnabled: true,
            hideHudEnabled: false,
        });
    });
});

describe('wave7 share normalize helpers — direct coercion', () => {
    it('normalizeShareName trims and lowercases', () => {
        expect(normalizeShareName('  MiniRacer  ')).toBe('miniracer');
        expect(normalizeShareName('RaceFan')).toBe('racefan');
    });

    it('parseSharePreviewRecord rejects nullish raw and required-field type mismatches', () => {
        expect(parseSharePreviewRecord(null)).toBeNull();
        expect(parseSharePreviewRecord('')).toBeNull();
        expect(parseSharePreviewRecord('not-json')).toBeNull();
        expect(parseSharePreviewRecord(JSON.stringify({
            ...VALID_PREVIEW,
            username: 1,
        }))).toBeNull();
        expect(parseSharePreviewRecord(JSON.stringify({
            ...VALID_PREVIEW,
            subredditName: '',
        }))).toMatchObject({
            subredditName: '',
        });
        expect(parseSharePreviewRecord(JSON.stringify({
            ...VALID_PREVIEW,
            source: 'lobby',
        }))).toBeNull();
        expect(parseSharePreviewRecord(JSON.stringify({
            ...VALID_PREVIEW,
            bestTimeMs: 'slow',
        }))).toBeNull();
        expect(parseSharePreviewRecord(JSON.stringify({
            ...VALID_PREVIEW,
            commentText: null,
        }))).toBeNull();
    });

    it('parseSharePreviewRecord accepts finish and standings sources', () => {
        expect(parseSharePreviewRecord(JSON.stringify(VALID_PREVIEW))).toEqual({
            ...VALID_PREVIEW,
            lapCount: 1,
        });
        expect(parseSharePreviewRecord(JSON.stringify({
            ...VALID_PREVIEW,
            source: 'standings',
        }))).toMatchObject({ source: 'standings' });
    });

    it('parseShareSharedResult rejects invalid comment ids and missing fields', () => {
        expect(parseShareSharedResult(null)).toBeNull();
        expect(parseShareSharedResult(JSON.stringify({
            ...VALID_SHARED,
            commentId: 't3_post',
        }))).toBeNull();
        expect(parseShareSharedResult(JSON.stringify({
            ...VALID_SHARED,
            commentUrl: 1,
        }))).toBeNull();
        expect(parseShareSharedResult(JSON.stringify({
            ...VALID_SHARED,
            commentText: '',
        }))).toMatchObject({
            commentText: '',
        });
        expect(parseShareSharedResult(JSON.stringify({
            ...VALID_SHARED,
            username: null,
        }))).toBeNull();
    });

    it('parseShareSharedResult accepts a valid shared-result payload', () => {
        expect(parseShareSharedResult(JSON.stringify(VALID_SHARED))).toEqual(VALID_SHARED);
    });

    it('getValidShareRequestContext trims strings and nulls blank preferredPostUrl', () => {
        expect(getValidShareRequestContext({})).toBeNull();
        expect(getValidShareRequestContext({
            username: '  ',
            subredditName: 'MiniRacer',
            appSlug: 'mini-racer',
        })).toBeNull();
        expect(getValidShareRequestContext({
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            appSlug: 'mini-racer',
            preferredPostUrl: '   ',
        })).toEqual({
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            appSlug: 'mini-racer',
            preferredPostUrl: null,
        });
        expect(getValidShareRequestContext({
            username: '  RaceFan ',
            subredditName: ' MiniRacer ',
            appSlug: ' mini-racer ',
            preferredPostUrl: ' https://reddit.com/post ',
        })).toEqual({
            username: 'RaceFan',
            subredditName: 'MiniRacer',
            appSlug: 'mini-racer',
            preferredPostUrl: 'https://reddit.com/post',
        });
    });

    it('formatDailyGpShareComment uses medal copy and lap-time formatting', () => {
        expect(formatDailyGpShareComment(42380, null, 'Circuit')).toBe(
            'I set a 42.380 lap in Circuit. 🏁',
        );
        expect(formatDailyGpShareComment(5000, 'gold', '')).toBe(
            'I earned the Gold medal 🥇 with a 05.000 lap in Mini Racer.',
        );
        expect(formatDailyGpShareComment(989, 'silver', 'Desert')).toBe(
            'I earned the Silver medal 🥈 with a 00.989 lap in Desert.',
        );
        expect(formatDailyGpShareComment(10050, 'bronze', 'Track')).toBe(
            'I earned the Bronze medal 🥉 with a 10.050 lap in Track.',
        );
        expect(formatDailyGpShareComment(10040, 'author', 'Track')).toBe(
            'I earned the Author medal 🏆 with a 10.040 lap in Track.',
        );
    });
});
