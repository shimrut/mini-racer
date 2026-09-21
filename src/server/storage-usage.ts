import { redis } from '@devvit/redis';
import { CAMPAIGN_ID, CAMPAIGN_STAGES } from '../../game/campaign/manifest.js';
import {
    analyticsRetentionWindow,
    analyticsScope,
    cohortStartsKey,
    dayCountersKey,
    dayModePlayersKey,
    dayPlayersKey,
    firstSeenKey,
    monthCountersKey,
    monthModePlayersKey,
    monthPlayersKey,
} from './analytics-store.js';
import { campaignProgressKey } from './campaign-progress-key.js';
import { carUnlockHashKey } from './car-unlock-store.js';
import { createRedisPlayerProfileKey } from './competition-identity.js';
import { toCampaignCompetition } from './competition.js';
import { DAILY_AUTPOST_SUBREDDITS_KEY } from './daily-autopost-store.js';
import {
    createDailyChallengeId,
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    createRedisChallengeStandingsRevisionKey,
    DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
} from './daily-gp-model.js';
import { createPostRecordKey } from './daily-gp-post-store.js';
import { DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY } from './daily-podium-autopost-store.js';
import { createPodiumPostRecordKey } from './daily-podium-post-store.js';
import {
    headToHeadCatalogAllKey,
    headToHeadCatalogBandKeys,
    headToHeadCatalogCardsKey,
} from './head-to-head-catalog.js';
import { LAUNCHER_POSTS_KEY } from './launcher-post-store.js';
import { MOD_ANALYTICS_POSTS_KEY } from './moderator-analytics-post.js';
import { challengeCollectionKey } from './pb-ghost-store.js';
import { readContextSubredditName } from './request-context.js';
import { cacheSharedJson } from './shared-cache.js';

/**
 * Devvit's Redis gives an app no server figure — there is no INFO, no DBSIZE, and no way to
 * list keys — so nothing here can report how full the hosted instance is. What it can do is
 * walk the keys this app knows how to name and add up what they hold. Row counts come from
 * hLen and zCard, which move no payload; row sizes come from a small sample of each family,
 * so a hash of ghost replays is never pulled down in full to be weighed.
 */

const SAMPLED_KEYS_PER_GROUP = 5;
const SAMPLED_ROWS_PER_KEY = 20;
const SAMPLED_PLAYERS = 40;
const READ_CONCURRENCY = 8;
/** A sorted-set score is a double, whatever the member costs. */
const SORTED_SET_SCORE_BYTES = 8;
/** The walk costs hundreds of reads, so every moderator on the page shares one answer. */
const STORAGE_USAGE_CACHE_TTL_SECONDS = 5 * 60;

export type StorageUsageGroup = {
    id: string;
    label: string;
    detail: string;
    bytes: number;
    keys: number;
    rows: number;
    estimated: boolean;
};

export type StorageUsage = {
    measuredAt: string;
    totalBytes: number;
    groups: StorageUsageGroup[];
    notCounted: string[];
};

type KeyGroup = {
    id: string;
    label: string;
    detail: string;
    strings: string[];
    hashes: string[];
    sortedSets: string[];
};

type Tally = {
    bytes: number;
    keys: number;
    rows: number;
    estimated: boolean;
};

type RowSample = {
    bytes: number;
    rows: number;
};

const EMPTY_TALLY: Tally = { bytes: 0, keys: 0, rows: 0, estimated: false };

function addTallies(first: Tally, second: Tally): Tally {
    return {
        bytes: first.bytes + second.bytes,
        keys: first.keys + second.keys,
        rows: first.rows + second.rows,
        estimated: first.estimated || second.estimated,
    };
}

/** One slow key must not cost the whole report, so every read answers zero rather than throwing. */
async function readCount(read: () => Promise<number>): Promise<number> {
    try {
        const value = await read();
        return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    } catch (_error) {
        return 0;
    }
}

async function mapWithLimit<Item, Result>(
    items: readonly Item[],
    run: (item: Item) => Promise<Result>,
): Promise<Result[]> {
    const results: Result[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from(
        { length: Math.min(READ_CONCURRENCY, items.length) },
        async () => {
            while (next < items.length) {
                const index = next;
                next += 1;
                results[index] = await run(items[index]);
            }
        },
    ));
    return results;
}

/** Spread the sample across the list: the newest and the oldest day should both be in it. */
function pickSpread<Item>(items: readonly Item[], count: number): Item[] {
    if (items.length <= count) return [...items];
    const step = items.length / count;
    return Array.from({ length: count }, (_unused, index) => items[Math.floor(index * step)]);
}

async function measureStrings(keys: readonly string[]): Promise<Tally> {
    const lengths = await mapWithLimit(keys, (key) => readCount(() => redis.strLen(key)));
    return keys.reduce((tally, key, index) => (lengths[index] > 0
        ? {
            ...tally,
            bytes: tally.bytes + key.length + lengths[index],
            keys: tally.keys + 1,
            rows: tally.rows + 1,
        }
        : tally), EMPTY_TALLY);
}

async function sampleHashRows(key: string): Promise<RowSample> {
    try {
        const fields = pickSpread(await redis.hKeys(key), SAMPLED_ROWS_PER_KEY);
        if (fields.length === 0) return { bytes: 0, rows: 0 };
        const values = await redis.hMGet(key, fields);
        return {
            bytes: fields.reduce(
                (bytes, field, index) => bytes + field.length + (values[index]?.length ?? 0),
                0,
            ),
            rows: fields.length,
        };
    } catch (_error) {
        return { bytes: 0, rows: 0 };
    }
}

async function sampleSortedSetRows(key: string): Promise<RowSample> {
    try {
        const members = await redis.zRange(key, 0, SAMPLED_ROWS_PER_KEY - 1);
        return {
            bytes: members.reduce(
                (bytes, { member }) => bytes + member.length + SORTED_SET_SCORE_BYTES,
                0,
            ),
            rows: members.length,
        };
    } catch (_error) {
        return { bytes: 0, rows: 0 };
    }
}

/**
 * Counted keys are exact and free of payload; the bytes per row are the average of a sample
 * drawn from a handful of the keys, because the whole family is far too big to read.
 */
async function measureRowKeys(
    keys: readonly string[],
    countRows: (key: string) => Promise<number>,
    sampleRows: (key: string) => Promise<RowSample>,
): Promise<Tally> {
    const counted = await mapWithLimit(
        keys,
        async (key) => ({ key, rows: await countRows(key) }),
    );
    const present = counted.filter(({ rows }) => rows > 0);
    const totalRows = present.reduce((rows, entry) => rows + entry.rows, 0);
    const keyNameBytes = present.reduce((bytes, entry) => bytes + entry.key.length, 0);
    if (totalRows === 0) {
        return { ...EMPTY_TALLY, bytes: keyNameBytes, keys: present.length };
    }

    const sampled = pickSpread(present, SAMPLED_KEYS_PER_GROUP);
    const samples = await mapWithLimit(sampled, ({ key }) => sampleRows(key));
    const sample = samples.reduce(
        (total, entry) => ({ bytes: total.bytes + entry.bytes, rows: total.rows + entry.rows }),
        { bytes: 0, rows: 0 },
    );
    if (sample.rows === 0) {
        return { bytes: keyNameBytes, keys: present.length, rows: totalRows, estimated: true };
    }

    return {
        bytes: keyNameBytes + Math.round(totalRows * (sample.bytes / sample.rows)),
        keys: present.length,
        rows: totalRows,
        estimated: sample.rows < totalRows,
    };
}

async function measureKeyGroup(group: KeyGroup): Promise<StorageUsageGroup> {
    const [strings, hashes, sortedSets] = await Promise.all([
        measureStrings(group.strings),
        measureRowKeys(
            group.hashes,
            (key) => readCount(() => redis.hLen(key)),
            sampleHashRows,
        ),
        measureRowKeys(
            group.sortedSets,
            (key) => readCount(() => redis.zCard(key)),
            sampleSortedSetRows,
        ),
    ]);
    const tally = [hashes, sortedSets].reduce(addTallies, strings);
    return {
        id: group.id,
        label: group.label,
        detail: group.detail,
        bytes: tally.bytes,
        keys: tally.keys,
        rows: tally.rows,
        estimated: tally.estimated,
    };
}

const PLAYER_RECORDS_GROUP = {
    id: 'players',
    label: 'Player records',
    detail: 'Profile, Campaign progress and car unlocks, per signed-in player',
} as const;

/**
 * A player's profile, Campaign progress and car unlocks are filed under a hash of their ID,
 * so they can only be found by naming the player first. The analytics ledger is the one list
 * of signed-in players this app keeps, so it supplies both the sample and the population.
 */
async function measurePlayerRecords(scope: string): Promise<StorageUsageGroup> {
    const empty: StorageUsageGroup = { ...PLAYER_RECORDS_GROUP, bytes: 0, keys: 0, rows: 0, estimated: false };
    const ledgerKey = firstSeenKey(scope);
    const population = await readCount(() => redis.hLen(ledgerKey));
    if (population === 0) return empty;

    const playerIds = await readLedgerSample(ledgerKey);
    if (playerIds.length === 0) return { ...empty, estimated: true };

    const sample = await measureKeyGroup({
        ...PLAYER_RECORDS_GROUP,
        strings: playerIds.flatMap((playerId) => [
            createRedisPlayerProfileKey(playerId),
            campaignProgressKey(playerId),
        ]),
        hashes: playerIds.map((playerId) => carUnlockHashKey(playerId)),
        sortedSets: [],
    });

    const share = population / playerIds.length;
    return {
        ...PLAYER_RECORDS_GROUP,
        bytes: Math.round(sample.bytes * share),
        keys: Math.round(sample.keys * share),
        rows: Math.round(sample.rows * share),
        estimated: playerIds.length < population,
    };
}

async function readLedgerSample(ledgerKey: string): Promise<string[]> {
    try {
        return pickSpread(await redis.hKeys(ledgerKey), SAMPLED_PLAYERS);
    } catch (_error) {
        return [];
    }
}

function buildKeyGroups({
    subredditName,
    now,
}: {
    subredditName: string;
    now: Date;
}): KeyGroup[] {
    const scope = analyticsScope(subredditName);
    const { dates, months } = analyticsRetentionWindow(now);
    const challengeIds = dates.map((date) => createDailyChallengeId(date));
    const campaigns = CAMPAIGN_STAGES.map((stage) => toCampaignCompetition(CAMPAIGN_ID, stage));
    const guestExpiryKeys = [...new Set(
        campaigns.flatMap((competition) => (competition.guestExpiryKey ? [competition.guestExpiryKey] : [])),
    )];

    return [
        {
            id: 'ghosts',
            label: 'Ghost replays',
            detail: 'One saved run per player per race, compressed',
            strings: [],
            hashes: [
                ...challengeIds.map((challengeId) => challengeCollectionKey(challengeId)),
                ...campaigns.map((competition) => competition.pbHashKey),
            ],
            sortedSets: [],
        },
        {
            id: 'leaderboards',
            label: 'Leaderboards',
            detail: 'Standings order, the row behind each place, and the change counter',
            strings: [
                ...challengeIds.map((challengeId) => createRedisChallengeStandingsRevisionKey(challengeId)),
                ...campaigns.map((competition) => competition.standingsRevisionKey),
            ],
            hashes: [
                ...challengeIds.map((challengeId) => createRedisChallengeEntryHashKey(challengeId)),
                ...campaigns.map((competition) => competition.entryHashKey),
            ],
            sortedSets: [
                ...challengeIds.map((challengeId) => createRedisChallengeLeaderboardKey(challengeId)),
                ...campaigns.map((competition) => competition.leaderboardKey),
                ...guestExpiryKeys,
            ],
        },
        {
            id: 'challenges',
            label: 'Daily challenges',
            detail: 'The track, laps and rules of every challenge still on record',
            strings: [],
            hashes: [DAILY_GP_CHALLENGE_HISTORY_HASH_KEY],
            sortedSets: [],
        },
        {
            id: 'analytics',
            label: 'Analytics',
            detail: 'This page: daily player marks, race counters, cohort starts, and the account ledger',
            strings: [],
            hashes: [
                ...dates.flatMap((date) => [
                    dayPlayersKey(scope, date),
                    dayModePlayersKey(scope, date),
                    dayCountersKey(scope, date),
                ]),
                ...months.flatMap((month) => [
                    monthPlayersKey(scope, month),
                    monthModePlayersKey(scope, month),
                    monthCountersKey(scope, month),
                ]),
                firstSeenKey(scope),
                cohortStartsKey(scope),
            ],
            sortedSets: [],
        },
        {
            id: 'posts',
            label: 'Posts and settings',
            detail: 'Which post holds which challenge, autopost subscriptions, and the Head to Head challenge directory',
            strings: [
                ...challengeIds.map((challengeId) => createPostRecordKey(subredditName, challengeId)),
                ...challengeIds.map((challengeId) => createPodiumPostRecordKey(subredditName, challengeId)),
            ],
            hashes: [
                LAUNCHER_POSTS_KEY,
                MOD_ANALYTICS_POSTS_KEY,
                DAILY_AUTPOST_SUBREDDITS_KEY,
                DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY,
                headToHeadCatalogCardsKey(subredditName),
            ],
            sortedSets: [
                headToHeadCatalogAllKey(subredditName),
                ...headToHeadCatalogBandKeys(subredditName),
            ],
        },
    ];
}

const NOT_COUNTED = [
    'Head to Head create locks, 10-minute post identity, and share previews — short-lived, and none of them is listed anywhere.',
    'Locks, rate limits and share links — all short-lived, and none of them is listed anywhere.',
    'Signed-out guest records — a guest is only listed once they have Campaign progress.',
    'Redis adds its own overhead per key and per row on top of the stored data measured here.',
];

function readSubredditName(subredditName?: unknown): string {
    const named = typeof subredditName === 'string' ? subredditName.trim() : '';
    if (named) return named;
    try {
        return readContextSubredditName() || '';
    } catch (_error) {
        return '';
    }
}

async function walkStorage(subreddit: string, now: Date): Promise<StorageUsage> {
    const groups = await Promise.all([
        ...buildKeyGroups({ subredditName: subreddit, now }).map((group) => measureKeyGroup(group)),
        measurePlayerRecords(analyticsScope(subreddit)),
    ]);

    return {
        measuredAt: now.toISOString(),
        totalBytes: groups.reduce((bytes, group) => bytes + group.bytes, 0),
        groups: [...groups].sort((first, second) => second.bytes - first.bytes),
        notCounted: NOT_COUNTED,
    };
}

export async function getServerStorageUsage({
    subredditName,
    now = new Date(),
}: {
    subredditName?: unknown;
    now?: Date;
} = {}): Promise<StorageUsage> {
    const subreddit = readSubredditName(subredditName);
    return await cacheSharedJson(
        async () => await walkStorage(subreddit, now) as never,
        {
            key: `mini-racer:storage-usage:v1:${analyticsScope(subreddit)}`,
            ttl: STORAGE_USAGE_CACHE_TTL_SECONDS,
        },
    );
}
