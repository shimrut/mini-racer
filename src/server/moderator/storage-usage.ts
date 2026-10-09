import { redis } from '@devvit/redis';
import { CAMPAIGN_LIVE_STAGES, CAMPAIGN_SERIES } from '../../../game/campaign/manifest.js';
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
    summaryKey,
} from './analytics-store.js';
import { campaignProgressKeys } from '../campaign/campaign-progress-key.js';
import { campaignAggregateKeys } from '../campaign/campaign-aggregate-store.js';
import { carUnlockHashKey } from '../player/car-unlock-store.js';
import { LAST_RACED_BUCKET_KEYS } from '../player/last-raced.js';
import { createRedisPlayerProfileKey } from '../competition/competition-identity.js';
import { toCampaignCompetition } from '../competition/competition.js';
import { DAILY_AUTPOST_SUBREDDITS_KEY } from '../daily/daily-autopost-store.js';
import {
    createDailyChallengeId,
    createRedisChallengeEntryHashKey,
    createRedisChallengeLeaderboardKey,
    createRedisChallengeStandingsRevisionKey,
    DAILY_GP_CHALLENGE_HISTORY_HASH_KEY,
} from '../daily/daily-gp-model.js';
import { createPostRecordKey } from '../daily/daily-gp-post-store.js';
import { DAILY_PODIUM_AUTOPOST_SUBREDDITS_KEY } from '../podium/daily-podium-autopost-store.js';
import { createPodiumPostRecordKey } from '../podium/daily-podium-post-store.js';
import {
    headToHeadCatalogAllKey,
    headToHeadCatalogBandKeys,
    headToHeadCatalogCardsKey,
} from '../head-to-head/head-to-head-catalog.js';
import { LAUNCHER_POSTS_KEY } from '../posts/launcher-post-store.js';
import { MOD_ANALYTICS_POSTS_KEY } from './moderator-analytics-post.js';
import { challengeCollectionKey } from '../competition/pb-ghost-store.js';
import { readDailyGhostArchiveDayStates } from '../daily/daily-ghost-archive.js';
import { readContextSubredditName } from '../request/request-context.js';
import {
    STORED_TRACKS_INDEX_KEY,
    STORED_TRACKS_REVISION_KEY,
    storedTrackRecordKey,
} from '../tracks/track-store.js';
import { cacheSharedJson } from '../redis/shared-cache.js';
import {
    challengeAnalyticsCountsKey,
    challengeAnalyticsViewersKey,
    challengeTrackAnalyticsCountsKey,
    challengeTrackAnalyticsIndexKey,
    challengeTrackAnalyticsRetentionDates,
    challengeTrackAnalyticsViewersKey,
} from './challenge-analytics-store.js';
import { challengeAnalyticsMigrationKeys } from './challenge-analytics-migration.js';

const SAMPLED_KEYS_PER_GROUP = 5;
const SAMPLED_ROWS_PER_KEY = 20;
const SAMPLED_PLAYERS = 40;
const SAMPLED_TRACKS = 60;
const READ_CONCURRENCY = 8;
const SORTED_SET_SCORE_BYTES = 8;
const STORAGE_USAGE_CACHE_TTL_SECONDS = 5 * 60;
// Daily boards only grow; ghost and leaderboard families sample a spread of days and scale up.
const SAMPLED_DAILY_DAYS = 60;

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
};

type KeyGroup = {
    id: string;
    label: string;
    detail: string;
    strings: string[];
    hashes: string[];
    sortedSets: string[];
    // The part stands for this many times its size (a sample of Daily days).
    scale?: number;
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
    const scale = group.scale ?? 1;
    return {
        id: group.id,
        label: group.label,
        detail: group.detail,
        bytes: Math.round(tally.bytes * scale),
        keys: Math.round(tally.keys * scale),
        rows: Math.round(tally.rows * scale),
        estimated: tally.estimated || (scale > 1 && tally.keys > 0),
    };
}

// Adds up the parts measured under one family id, in first-seen order.
function mergeGroupParts(parts: readonly StorageUsageGroup[]): StorageUsageGroup[] {
    const merged = new Map<string, StorageUsageGroup>();
    for (const part of parts) {
        const known = merged.get(part.id);
        merged.set(part.id, known
            ? {
                ...known,
                bytes: known.bytes + part.bytes,
                keys: known.keys + part.keys,
                rows: known.rows + part.rows,
                estimated: known.estimated || part.estimated,
            }
            : part);
    }
    return [...merged.values()];
}

// Every stored Daily day, oldest first, or the analytics window if the list cannot be read.
async function readStoredDailyChallengeIds(fallback: readonly string[]): Promise<string[]> {
    try {
        const ids = (await redis.hKeys(DAILY_GP_CHALLENGE_HISTORY_HASH_KEY))
            .filter((id) => id.startsWith('daily-gp-'))
            .sort();
        return ids.length > 0 ? ids : [...fallback];
    } catch (_error) {
        return [...fallback];
    }
}

const PLAYER_RECORDS_GROUP = {
    id: 'players',
    label: 'Player records',
    detail: 'Profile, Campaign progress and car unlocks, per signed-in player',
} as const;

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
            ...campaignProgressKeys(playerId),
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

const TRACKS_GROUP = {
    id: 'tracks',
    label: 'Tracks',
    detail: 'Every track saved in the Creator or copied from the app: shape, medal times and checks',
} as const;

// Samples a spread of track records and scales to all; the list itself is measured as usual.
async function measureTracks(): Promise<StorageUsageGroup> {
    let trackKeys: string[] = [];
    try {
        trackKeys = await redis.hKeys(STORED_TRACKS_INDEX_KEY);
    } catch (_error) {
        trackKeys = [];
    }
    const sampled = pickSpread(trackKeys, SAMPLED_TRACKS);
    const parts = await Promise.all([
        measureKeyGroup({
            ...TRACKS_GROUP,
            strings: sampled.map((trackKey) => storedTrackRecordKey(trackKey)),
            hashes: [],
            sortedSets: [],
            scale: sampled.length > 0 ? trackKeys.length / sampled.length : 1,
        }),
        measureKeyGroup({
            ...TRACKS_GROUP,
            strings: [STORED_TRACKS_REVISION_KEY],
            hashes: [STORED_TRACKS_INDEX_KEY],
            sortedSets: [],
        }),
    ]);
    return mergeGroupParts(parts)[0];
}

async function readLedgerSample(ledgerKey: string): Promise<string[]> {
    try {
        return pickSpread(await redis.hKeys(ledgerKey), SAMPLED_PLAYERS);
    } catch (_error) {
        return [];
    }
}

async function measureLegacyChallengeAnalytics(subredditName: string): Promise<StorageUsageGroup[]> {
    const countsKey = challengeAnalyticsCountsKey(subredditName);
    let postIds: string[] = [];
    try {
        postIds = [...new Set((await redis.hKeys(countsKey))
            .filter((field) => field.startsWith('views:') || field.startsWith('clicks:'))
            .map((field) => field.slice(field.indexOf(':') + 1)))];
    } catch (_error) {
        postIds = [];
    }
    const sampled = pickSpread(postIds, SAMPLED_PLAYERS);
    const description = {
        id: 'analytics',
        label: 'Analytics',
        detail: 'This page: daily player marks, summary totals, cohort starts, account ledger, and challenge views/clicks',
    };
    return await Promise.all([
        measureKeyGroup({ ...description, strings: [], hashes: [countsKey], sortedSets: [] }),
        measureKeyGroup({
            ...description,
            strings: [],
            hashes: sampled.map((postId) => challengeAnalyticsViewersKey(subredditName, postId)),
            sortedSets: [],
            scale: sampled.length ? postIds.length / sampled.length : 1,
        }),
    ]);
}

async function measureChallengeAnalytics(subredditName: string, now: Date): Promise<StorageUsageGroup[]> {
    const description = {
        id: 'analytics',
        label: 'Analytics',
        detail: 'This page: player activity, cohorts, account ledger, and challenge views/clicks by track',
    };
    const periods = [null, ...challengeTrackAnalyticsRetentionDates(now)];
    const migrationKeys = challengeAnalyticsMigrationKeys(subredditName);
    const parts = await Promise.all([
        measureLegacyChallengeAnalytics(subredditName),
        Promise.all(periods.map(async (date) => {
            const countsKey = challengeTrackAnalyticsCountsKey(subredditName, date);
            let tracks: string[] = [];
            try {
                tracks = [...new Set((await redis.hKeys(countsKey))
                    .filter((field) => /^(views|accept-clicks|own-opens):/.test(field))
                    .map((field) => field.slice(field.indexOf(':') + 1)))];
            } catch (_error) {
                tracks = [];
            }
            const sampled = pickSpread(tracks, SAMPLED_TRACKS);
            return await Promise.all([
                measureKeyGroup({ ...description, strings: [], hashes: [countsKey], sortedSets: [] }),
                measureKeyGroup({
                    ...description,
                    strings: [],
                    hashes: sampled.map((trackKey) => challengeTrackAnalyticsViewersKey(subredditName, trackKey, date)),
                    sortedSets: [],
                    scale: sampled.length ? tracks.length / sampled.length : 1,
                }),
            ]);
        })),
        measureKeyGroup({
            ...description,
            strings: [migrationKeys.complete],
            hashes: [migrationKeys.receipts],
            sortedSets: [challengeTrackAnalyticsIndexKey(subredditName)],
        }),
    ]);
    return [
        ...parts[0],
        ...parts[1].flat(),
        parts[2],
    ];
}

function buildKeyGroups({
    subredditName,
    now,
    storedDailyChallengeIds,
    archiveDayStates,
}: {
    subredditName: string;
    now: Date;
    // Every stored Daily day; the analytics window when not given.
    storedDailyChallengeIds?: readonly string[];
    // The ghost move's state of each day it touched.
    archiveDayStates?: ReadonlyMap<string, string>;
}): KeyGroup[] {
    const scope = analyticsScope(subredditName);
    const { dates, months } = analyticsRetentionWindow(now);
    // Post records still expire with the analytics window.
    const challengeIds = dates.map((date) => createDailyChallengeId(date));
    const storedDays = storedDailyChallengeIds ?? challengeIds;
    const sampledDays = pickSpread(storedDays, SAMPLED_DAILY_DAYS);
    const dailyScale = sampledDays.length > 0 ? storedDays.length / sampledDays.length : 1;
    const campaigns = CAMPAIGN_LIVE_STAGES.map((stage) => toCampaignCompetition(stage.seriesId, stage));
    const aggregates = CAMPAIGN_SERIES.map((series) => campaignAggregateKeys(series.id));
    const guestExpiryKeys = [...new Set(
        campaigns.flatMap((competition) => (competition.guestExpiryKey ? [competition.guestExpiryKey] : [])),
    )];
    const ghosts = {
        id: 'ghosts',
        label: 'Ghost replays',
        detail: 'One saved run per player per race, compressed',
    };
    const leaderboards = {
        id: 'leaderboards',
        label: 'Leaderboards',
        detail: 'Standings order, the row behind each place, and the change counter',
    };

    // Moved, moving and full-ghost days are sampled apart, so one kind cannot set another's row size.
    const ghostDayGroups = archiveDayStates
        ? [
            storedDays.filter((day) => archiveDayStates.get(day) === 'done'),
            storedDays.filter((day) => ['moving', 'waiting', 'restoring'].includes(archiveDayStates.get(day) ?? '')),
            storedDays.filter((day) => !archiveDayStates.has(day) || archiveDayStates.get(day) === 'restored'),
        ]
        : [storedDays];
    const ghostDayParts = ghostDayGroups
        .filter((group) => group.length > 0)
        .map((group) => {
            const sampled = pickSpread(group, SAMPLED_DAILY_DAYS);
            return {
                ...ghosts,
                strings: [],
                hashes: sampled.map((challengeId) => challengeCollectionKey(challengeId)),
                sortedSets: [],
                scale: group.length / sampled.length,
            };
        });

    return [
        ...ghostDayParts,
        {
            ...ghosts,
            strings: [],
            hashes: campaigns.map((competition) => competition.pbHashKey),
            sortedSets: [],
        },
        {
            ...leaderboards,
            strings: sampledDays.map((challengeId) => createRedisChallengeStandingsRevisionKey(challengeId)),
            hashes: sampledDays.map((challengeId) => createRedisChallengeEntryHashKey(challengeId)),
            sortedSets: sampledDays.map((challengeId) => createRedisChallengeLeaderboardKey(challengeId)),
            scale: dailyScale,
        },
        {
            ...leaderboards,
            strings: [
                ...campaigns.map((competition) => competition.standingsRevisionKey),
                ...aggregates.flatMap((keys) => [keys.revision, keys.fillState, keys.fillReady, keys.fillLock]),
            ],
            hashes: campaigns.map((competition) => competition.entryHashKey),
            sortedSets: [
                ...campaigns.map((competition) => competition.leaderboardKey),
                ...aggregates.map((keys) => keys.leaderboard),
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
            detail: 'This page: player activity, cohorts, account ledger, and challenge views/clicks by track',
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
                summaryKey(scope),
                firstSeenKey(scope),
                cohortStartsKey(scope),
            ],
            sortedSets: [],
        },
        {
            id: 'last-raced',
            label: 'Last race days',
            detail: 'The day each player last raced, which the Campaign ghost move reads',
            strings: [],
            hashes: [...LAST_RACED_BUCKET_KEYS],
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

function readSubredditName(subredditName?: unknown): string {
    const named = typeof subredditName === 'string' ? subredditName.trim() : '';
    if (named) return named;
    try {
        return readContextSubredditName() || '';
    } catch (_error) {
        return '';
    }
}

// Not counted: short-lived locks, limits, links and H2H keys; signed-out guests; Creator data;
// ghost-move records; Redis per-key overhead.
async function walkStorage(subreddit: string, now: Date): Promise<StorageUsage> {
    const windowChallengeIds = analyticsRetentionWindow(now).dates.map((date) => createDailyChallengeId(date));
    const storedDailyChallengeIds = await readStoredDailyChallengeIds(windowChallengeIds);
    const archiveDayStates = await readDailyGhostArchiveDayStates().catch(() => undefined);
    const groups = mergeGroupParts(await Promise.all([
        ...buildKeyGroups({ subredditName: subreddit, now, storedDailyChallengeIds, archiveDayStates })
            .map((group) => measureKeyGroup(group)),
        measurePlayerRecords(analyticsScope(subreddit)),
        measureTracks(),
        ...await measureChallengeAnalytics(subreddit, now),
    ]));

    return {
        measuredAt: now.toISOString(),
        totalBytes: groups.reduce((bytes, group) => bytes + group.bytes, 0),
        groups: [...groups].sort((first, second) => second.bytes - first.bytes),
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
