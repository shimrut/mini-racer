import { describe, expect, it } from 'vitest';
import {
    DAILY_PODIUM_REPLAY_FORMAT,
    DAILY_PODIUM_REPLAY_MARKER,
    decodeDailyPodiumReplay,
    encodeDailyPodiumReplay,
    resolveDailyPodiumReplayFromPost,
} from '../src/server/daily-podium-replay.ts';

const ghost = {
    schemaVersion: 2,
    sampleIntervalMs: 50,
    finishTimeMs: 50,
    origin: [100, 200, 300],
    deltas: [1, 2, 3],
};

function encodeStandard() {
    return encodeDailyPodiumReplay({
        challengeId: 'daily-gp-2026-08-21',
        trackKey: 'circuit',
        lapCount: 1,
        trackFingerprint: 'track-fingerprint',
        ghosts: [
            { rank: 1, ghost },
            { rank: 2, ghost: null },
            { rank: 3, ghost: null },
        ],
    });
}

describe('daily podium replay body', () => {
    it('round-trips compressed ghosts without player ids', () => {
        const encoded = encodeStandard();
        const text = [
            '# Mini Racer Final Podium',
            '',
            DAILY_PODIUM_REPLAY_MARKER,
            '',
            '```text',
            encoded.token,
            '```',
        ].join('\n');

        expect(text.length).toBeLessThan(40_000);
        expect(JSON.stringify(encoded.envelope)).not.toContain('playerId');
        expect(decodeDailyPodiumReplay(text, {
            challengeId: 'daily-gp-2026-08-21',
            lapCount: 1,
            replayDataHash: encoded.hash,
        }).decoded).toMatchObject({
            hash: encoded.hash,
            envelope: {
                format: DAILY_PODIUM_REPLAY_FORMAT,
                trackKey: 'circuit',
                ghosts: [
                    { rank: 1, ghost },
                    { rank: 2, ghost: null },
                    { rank: 3, ghost: null },
                ],
            },
        });
    });

    it('fails closed when the hash or challenge changes', () => {
        const encoded = encodeStandard();
        const text = `${DAILY_PODIUM_REPLAY_MARKER}\n${encoded.token}`;
        expect(decodeDailyPodiumReplay(text, {
            challengeId: 'daily-gp-2026-08-21',
            replayDataHash: '0'.repeat(64),
        }).decoded).toBeNull();
        expect(decodeDailyPodiumReplay(text, {
            challengeId: 'daily-gp-2026-08-22',
            replayDataHash: encoded.hash,
        }).decoded).toBeNull();
    });

    it('reads ghosts from a Reddit post fallback body', () => {
        const encoded = encodeStandard();
        const envelope = resolveDailyPodiumReplayFromPost({
            selftext: `${DAILY_PODIUM_REPLAY_MARKER}\n${encoded.token}`,
        }, {
            challengeId: 'daily-gp-2026-08-21',
            podium: { lapCount: 1 },
            replayDataHash: encoded.hash,
        });
        expect(envelope?.ghosts[0].ghost).toEqual(ghost);
        expect(envelope?.trackKey).toBe('circuit');
    });
});
