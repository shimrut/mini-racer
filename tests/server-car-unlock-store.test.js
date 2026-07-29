import { beforeEach, describe, expect, it } from 'vitest';
import {
    getCarUnlockSnapshot,
    mergeGuestCarUnlockProgress,
    recordCompletedRace,
    recordHeadToHeadPost,
    recordHeadToHeadWin,
} from '../src/server/car-unlock-store.ts';
import { EXTRA_CAR_ASSETS } from '../game/car/car-unlock-policy.js';

function createRedisMock() {
    const hashes = new Map();
    const getHash = (key) => {
        if (!hashes.has(key)) hashes.set(key, new Map());
        return hashes.get(key);
    };
    return {
        hashes,
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
            return hashes.delete(key) ? 1 : 0;
        },
    };
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
});
