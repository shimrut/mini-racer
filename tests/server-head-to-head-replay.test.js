import { describe, expect, it } from 'vitest';
import {
    HEAD_TO_HEAD_REPLAY_FORMAT,
    HEAD_TO_HEAD_REPLAY_MARKER,
    decodeHeadToHeadReplay,
    encodeHeadToHeadReplay,
    formatHeadToHeadTextFallback,
} from '../src/server/head-to-head-replay.ts';

const postData = {
    postType: 'head-to-head',
    challengeId: 'challenge-1',
    campaignId: 'numbered-v1',
    raceId: 'numbered-v1-01',
    challengerUsername: 'RaceFan',
    challengerAvatarUrl: null,
    trackKey: 'numberOne',
    lapCount: 2,
    targetTimeMs: 25_640,
    medal: 'gold',
    rulesRevision: 1,
    trackFingerprint: 'track-fingerprint',
    createdAt: '2026-07-23T12:00:00.000Z',
};

const ghost = {
    schemaVersion: 2,
    sampleIntervalMs: 50,
    finishTimeMs: 25_640,
    origin: [100, 200, 300],
    deltas: [1, 2, 3, -1, 0, 2],
};

describe('head-to-head replay body', () => {
    it('keeps the human copy first and round-trips the compressed replay payload', () => {
        const encoded = encodeHeadToHeadReplay(postData, ghost);
        const immutablePostData = { ...postData, replayDataHash: encoded.hash };
        const text = formatHeadToHeadTextFallback(immutablePostData, ghost);

        expect(text.indexOf('# Head to Head · RaceFan')).toBeLessThan(
            text.indexOf(HEAD_TO_HEAD_REPLAY_MARKER),
        );
        expect(text).toContain('Beat **25.640** on **Number One** (2 laps).');
        expect(text).toContain(HEAD_TO_HEAD_REPLAY_FORMAT);
        expect(text.length).toBeLessThan(40_000);
        expect(decodeHeadToHeadReplay(text, immutablePostData).decoded).toMatchObject({
            hash: encoded.hash,
            envelope: {
                challengeId: 'challenge-1',
                targetTimeMs: 25_640,
                ghost,
            },
        });
    });

    it('fails closed when the body or immutable post data is changed', () => {
        const encoded = encodeHeadToHeadReplay(postData, ghost);
        const immutablePostData = { ...postData, replayDataHash: encoded.hash };
        const text = formatHeadToHeadTextFallback(immutablePostData, ghost);
        const last = encoded.token.at(-1);
        const tamperedToken = `${encoded.token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;

        expect(decodeHeadToHeadReplay(
            text.replace(encoded.token, tamperedToken),
            immutablePostData,
        ).decoded).toBeNull();
        expect(decodeHeadToHeadReplay(
            text.replace('25.640', '25.641'),
            immutablePostData,
        ).decoded).not.toBeNull();
        expect(decodeHeadToHeadReplay(
            text,
            { ...immutablePostData, targetTimeMs: 25_641 },
        ).decoded).toBeNull();
        expect(decodeHeadToHeadReplay(
            text.replace(HEAD_TO_HEAD_REPLAY_FORMAT, 'MINIRACER-HEAD-TO-HEAD-REPLAY-V0'),
            immutablePostData,
        ).decoded).toBeNull();
    });

    it('round-trips a Daily origin without Campaign fields', () => {
        const dailyPostData = {
            ...postData,
            challengeId: 'daily-gp-2026-07-23',
            campaignId: undefined,
            raceId: undefined,
            origin: {
                mode: 'daily',
                challengeId: 'daily-gp-2026-07-23',
            },
        };
        const encoded = encodeHeadToHeadReplay(dailyPostData, ghost);
        const immutablePostData = { ...dailyPostData, replayDataHash: encoded.hash };
        const decoded = decodeHeadToHeadReplay(
            formatHeadToHeadTextFallback(immutablePostData, ghost),
            immutablePostData,
        );

        expect(decoded?.decoded?.envelope).toMatchObject({
            challengeId: 'daily-gp-2026-07-23',
            origin: {
                mode: 'daily',
                challengeId: 'daily-gp-2026-07-23',
            },
        });
        expect(decoded?.decoded?.envelope).not.toHaveProperty('campaignId');
        expect(decoded?.decoded?.envelope).not.toHaveProperty('raceId');
    });
});
