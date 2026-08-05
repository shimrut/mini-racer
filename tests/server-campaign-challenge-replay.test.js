import { describe, expect, it } from 'vitest';
import {
    CAMPAIGN_CHALLENGE_REPLAY_FORMAT,
    CAMPAIGN_CHALLENGE_REPLAY_MARKER,
    decodeCampaignChallengeReplay,
    encodeCampaignChallengeReplay,
    formatCampaignChallengeTextFallback,
} from '../src/server/campaign-challenge-replay.ts';

const postData = {
    postType: 'campaign-challenge',
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

describe('campaign challenge replay body', () => {
    it('keeps the human copy first and round-trips the compressed replay payload', () => {
        const encoded = encodeCampaignChallengeReplay(postData, ghost);
        const immutablePostData = { ...postData, replayDataHash: encoded.hash };
        const text = formatCampaignChallengeTextFallback(immutablePostData, ghost);

        expect(text.indexOf('# Head to Head · RaceFan')).toBeLessThan(
            text.indexOf(CAMPAIGN_CHALLENGE_REPLAY_MARKER),
        );
        expect(text).toContain('Beat **25.640** on **Number One** (2 laps).');
        expect(text).toContain(CAMPAIGN_CHALLENGE_REPLAY_FORMAT);
        expect(text.length).toBeLessThan(40_000);
        expect(decodeCampaignChallengeReplay(text, immutablePostData)).toMatchObject({
            hash: encoded.hash,
            envelope: {
                challengeId: 'challenge-1',
                targetTimeMs: 25_640,
                ghost,
            },
        });
    });

    it('fails closed when the body or immutable post data is changed', () => {
        const encoded = encodeCampaignChallengeReplay(postData, ghost);
        const immutablePostData = { ...postData, replayDataHash: encoded.hash };
        const text = formatCampaignChallengeTextFallback(immutablePostData, ghost);
        const last = encoded.token.at(-1);
        const tamperedToken = `${encoded.token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;

        expect(decodeCampaignChallengeReplay(
            text.replace(encoded.token, tamperedToken),
            immutablePostData,
        )).toBeNull();
        expect(decodeCampaignChallengeReplay(
            text.replace('25.640', '25.641'),
            immutablePostData,
        )).not.toBeNull();
        expect(decodeCampaignChallengeReplay(
            text,
            { ...immutablePostData, targetTimeMs: 25_641 },
        )).toBeNull();
        expect(decodeCampaignChallengeReplay(
            text.replace(CAMPAIGN_CHALLENGE_REPLAY_FORMAT, 'MINIRACER-CHALLENGE-REPLAY-V0'),
            immutablePostData,
        )).toBeNull();
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
        const encoded = encodeCampaignChallengeReplay(dailyPostData, ghost);
        const immutablePostData = { ...dailyPostData, replayDataHash: encoded.hash };
        const decoded = decodeCampaignChallengeReplay(
            formatCampaignChallengeTextFallback(immutablePostData, ghost),
            immutablePostData,
        );

        expect(decoded?.envelope).toMatchObject({
            challengeId: 'daily-gp-2026-07-23',
            origin: {
                mode: 'daily',
                challengeId: 'daily-gp-2026-07-23',
            },
        });
        expect(decoded?.envelope).not.toHaveProperty('campaignId');
        expect(decoded?.envelope).not.toHaveProperty('raceId');
    });
});
