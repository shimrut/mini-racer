import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
    captureGuestTransferGarageBaseline,
    cleanupGuestCarUnlockProgress,
    discardGuestCarUnlockProgress,
    getCarUnlockSnapshot,
    mergeGuestCarUnlockProgress,
    recordCompletedRace,
    recordHeadToHeadPost,
    recordHeadToHeadWin,
    retireEmptyGuestIdentity,
} from '../src/server/car-unlock-store.ts';
import { EXTRA_CAR_ASSETS } from '../game/car/car-unlock-policy.js';

function createRedisMock() {
    const hashes = new Map();
    const strings = new Map();
    const getHash = (key) => {
        if (!hashes.has(key)) hashes.set(key, new Map());
        return hashes.get(key);
    };
    const client = {
        hashes,
        strings,
        async get(key) {
            return strings.get(key) ?? null;
        },
        async set(key, value, options = {}) {
            if (options.nx && strings.has(key)) return '';
            strings.set(key, String(value));
            return 'OK';
        },
        async hGetAll(key) {
            return Object.fromEntries(getHash(key));
        },
        async hSetNX(key, field, value) {
            const hash = getHash(key);
            if (hash.has(field)) return 0;
            hash.set(field, String(value));
            return 1;
        },
        async hSet(key, fields) {
            const hash = getHash(key);
            for (const [field, value] of Object.entries(fields)) hash.set(field, String(value));
        },
        async del(key) {
            const removed = Number(hashes.delete(key)) + Number(strings.delete(key));
            return removed > 0 ? 1 : 0;
        },
        async expire() {
            return true;
        },
        async watch() {
            const commands = [];
            return {
                async multi() {},
                async unwatch() {},
                async discard() {},
                async hSet(...args) { commands.push(() => client.hSet(...args)); },
                async set(...args) { commands.push(() => client.set(...args)); },
                async del(...args) { commands.push(() => client.del(...args)); },
                async expire(...args) { commands.push(() => client.expire(...args)); },
                async exec() {
                    if (client.abortNextExec) {
                        client.abortNextExec = false;
                        return [];
                    }
                    const results = [];
                    for (const command of commands) results.push(await command());
                    return results;
                },
            };
        },
    };
    return client;
}

function promotionLockKey(playerId) {
    const playerHash = createHash('sha256').update(playerId, 'utf8').digest('base64url');
    return `miniracer:car-unlocks:promotion:v1:${playerHash}:lock`;
}

describe('server car unlock store', () => {
    let client;

    beforeEach(() => {
        client = createRedisMock();
    });

    it('permanently records race completion', async () => {
        await recordCompletedRace('guest:driver', client);
        await recordCompletedRace('guest:driver', client);

        const snapshot = await getCarUnlockSnapshot('guest:driver', {}, client);
        expect(snapshot.progress.completedRace).toBe(1);
        expect(snapshot.unlockedAssets).toContain(EXTRA_CAR_ASSETS.crimson);
    });

    it('accepts retained race evidence while an old account is backfilled', async () => {
        const snapshot = await getCarUnlockSnapshot(
            'reddit:returning-driver',
            {},
            client,
            true,
        );

        expect(snapshot.progress.completedRace).toBe(1);
        expect(snapshot.unlockedAssets).toContain(EXTRA_CAR_ASSETS.crimson);
    });

    it('deduplicates posted tracks and unlocks Plasma on the fifth unique track', async () => {
        for (let index = 0; index < 5; index += 1) {
            await recordHeadToHeadPost('reddit:driver', `track-${index}`, client);
            await recordHeadToHeadPost('reddit:driver', `track-${index}`, client);
        }

        const snapshot = await getCarUnlockSnapshot('reddit:driver', {}, client);
        expect(snapshot.progress.headToHeadTracksPosted).toBe(5);
        expect(snapshot.unlockedAssets).toContain(EXTRA_CAR_ASSETS.fuchsia);
        expect(snapshot.unlockedAssets).toContain(EXTRA_CAR_ASSETS.plasma);
    });

    it('deduplicates challenge wins and unlocks Onyx on the tenth win', async () => {
        for (let index = 0; index < 10; index += 1) {
            await recordHeadToHeadWin('reddit:driver', `challenge-${index}`, client);
            await recordHeadToHeadWin('reddit:driver', `challenge-${index}`, client);
        }

        const snapshot = await getCarUnlockSnapshot('reddit:driver', {}, client);
        expect(snapshot.progress.headToHeadWins).toBe(10);
        expect(snapshot.unlockedAssets).toContain(EXTRA_CAR_ASSETS.lime);
        expect(snapshot.unlockedAssets).toContain(EXTRA_CAR_ASSETS.onyx);
    });

    it('merges guest unlock events into the Reddit identity without revoking either side', async () => {
        await recordCompletedRace('guest:driver', client);
        await recordHeadToHeadWin('reddit:driver', 'challenge-existing', client);

        expect(await mergeGuestCarUnlockProgress({
            guestPlayerId: 'guest:driver',
            redditPlayerId: 'reddit:driver',
            client,
        })).toBe(true);

        const snapshot = await getCarUnlockSnapshot('reddit:driver', {}, client);
        expect(snapshot.progress.completedRace).toBe(1);
        expect(snapshot.progress.headToHeadWins).toBe(1);
        expect(snapshot.unlockedAssets).toContain(EXTRA_CAR_ASSETS.crimson);
        expect(snapshot.unlockedAssets).toContain(EXTRA_CAR_ASSETS.lime);
        expect(await getCarUnlockSnapshot('guest:driver', {}, client))
            .toMatchObject({ progress: { completedRace: 0 } });
    });

    it('redirects an achievement that arrives while guest promotion is completing', async () => {
        await recordCompletedRace('guest:driver', client);
        await recordHeadToHeadPost('reddit:driver', 'existing-track', client);
        const defaultHGetAll = client.hGetAll.bind(client);
        let releasePromotionRead;
        const promotionRead = new Promise((resolve) => { releasePromotionRead = resolve; });
        let promotionReadStarted;
        const promotionStarted = new Promise((resolve) => { promotionReadStarted = resolve; });
        client.hGetAll = async (key) => {
            const fields = await defaultHGetAll(key);
            if (Object.keys(fields).includes('race:completed')) {
                promotionReadStarted();
                await promotionRead;
            }
            return fields;
        };

        const promotion = mergeGuestCarUnlockProgress({
            guestPlayerId: 'guest:driver',
            redditPlayerId: 'reddit:driver',
            client,
        });
        await promotionStarted;
        const concurrentWin = recordHeadToHeadWin('guest:driver', 'challenge-race', client);
        releasePromotionRead();
        await Promise.all([promotion, concurrentWin]);

        const redditSnapshot = await getCarUnlockSnapshot('reddit:driver', {}, client);
        expect(redditSnapshot.progress.completedRace).toBe(1);
        expect(redditSnapshot.progress.headToHeadWins).toBe(1);
        expect(redditSnapshot.progress.headToHeadTracksPosted).toBe(1);
        expect(await getCarUnlockSnapshot('guest:driver', {}, client))
            .toMatchObject({ progress: { completedRace: 0, headToHeadWins: 0 } });
    });

    it('keeps the guest source intact when the atomic promotion transaction is interrupted', async () => {
        await recordCompletedRace('guest:driver', client);
        await recordHeadToHeadWin('reddit:driver', 'existing-win', client);
        client.abortNextExec = true;

        await expect(mergeGuestCarUnlockProgress({
            guestPlayerId: 'guest:driver',
            redditPlayerId: 'reddit:driver',
            client,
        })).rejects.toThrow('Car unlock promotion was interrupted.');
        expect((await getCarUnlockSnapshot('guest:driver', {}, client)).progress.completedRace).toBe(1);

        await expect(mergeGuestCarUnlockProgress({
            guestPlayerId: 'guest:driver',
            redditPlayerId: 'reddit:driver',
            client,
        })).resolves.toBe(true);
        const redditSnapshot = await getCarUnlockSnapshot('reddit:driver', {}, client);
        expect(redditSnapshot.progress.completedRace).toBe(1);
        expect(redditSnapshot.progress.headToHeadWins).toBe(1);
    });

    it('does not replace account unlocks while the account writer owns its lock', async () => {
        await recordCompletedRace('guest:driver', client);
        await recordHeadToHeadWin('reddit:driver', 'account-win', client);
        await client.set(promotionLockKey('reddit:driver'), 'account-writer');

        await expect(mergeGuestCarUnlockProgress({
            guestPlayerId: 'guest:driver',
            redditPlayerId: 'reddit:driver',
            client,
            replace: true,
        })).rejects.toMatchObject({
            statusCode: 503,
            reason: 'progress_selection_retryable',
        });

        expect((await getCarUnlockSnapshot('guest:driver', {}, client)).progress.completedRace).toBe(1);
        expect((await getCarUnlockSnapshot('reddit:driver', {}, client)).progress.headToHeadWins).toBe(1);
    });
});

describe('every Garage transfer path reports contention as retryable', () => {
    let client;

    beforeEach(() => {
        client = createRedisMock();
    });

    const RETRYABLE = { statusCode: 503, reason: 'progress_selection_retryable' };

    /**
     * Contention is ordinary and the browser's retry clears it. A path that lets the raw busy error
     * out answers 500 with a stack trace instead, which reads as an unclassified fault.
     */
    it('translates it when preparation freezes the account baseline', async () => {
        await client.set(promotionLockKey('reddit:driver'), 'account-writer');
        await expect(captureGuestTransferGarageBaseline(
            'reddit:driver', 'guest-transfer:x', client,
        )).rejects.toMatchObject(RETRYABLE);
    });

    it('translates it when cleanup removes the guest Garage', async () => {
        await client.set(promotionLockKey('guest:driver'), 'guest-writer');
        await expect(cleanupGuestCarUnlockProgress({
            guestPlayerId: 'guest:driver', redditPlayerId: 'reddit:driver', client,
        })).rejects.toMatchObject(RETRYABLE);
    });

    it('translates it when an empty guest is retired', async () => {
        await client.set(promotionLockKey('guest:driver'), 'guest-writer');
        await expect(retireEmptyGuestIdentity({
            guestPlayerId: 'guest:driver', redditPlayerId: 'reddit:driver', client,
        })).rejects.toMatchObject(RETRYABLE);
    });

    it('still translates it on the discard path', async () => {
        await client.set(promotionLockKey('guest:driver'), 'guest-writer');
        await expect(discardGuestCarUnlockProgress({
            guestPlayerId: 'guest:driver', redditPlayerId: 'reddit:driver', client,
        })).rejects.toMatchObject(RETRYABLE);
    });
});
