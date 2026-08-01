import { GENERATED_PLAYER_SELECTABLE_CAR_ASSETS } from './generated-player-selectable-car-assets.js';

export const STOCK_CAR_ASSET_NAME = 'assets/cars/mr_mr_red.webp';

export const EXTRA_CAR_ASSETS = Object.freeze({
    arctic: 'assets/cars/mr_extra_arctic.webp',
    blaze: 'assets/cars/mr_extra_blaze.webp',
    cobalt: 'assets/cars/mr_extra_cobalt.webp',
    crimson: 'assets/cars/mr_extra_crimson.webp',
    fuchsia: 'assets/cars/mr_extra_fuchsia.webp',
    gold: 'assets/cars/mr_extra_gold.webp',
    lime: 'assets/cars/mr_extra_lime.webp',
    onyx: 'assets/cars/mr_extra_onyx.webp',
    plasma: 'assets/cars/mr_extra_plasma.webp',
    surge: 'assets/cars/mr_extra_surge.webp',
});

export const CAR_UNLOCK_REQUIREMENTS = Object.freeze({
    [EXTRA_CAR_ASSETS.crimson]: Object.freeze({
        progressKey: 'completedRace',
        required: 1,
        label: 'Complete any race',
    }),
    [EXTRA_CAR_ASSETS.gold]: Object.freeze({
        progressKey: 'campaignGoldOrBetter',
        required: 5,
        label: 'Earn Gold or Author on 5 Campaign stages',
    }),
    [EXTRA_CAR_ASSETS.blaze]: Object.freeze({
        progressKey: 'campaignGoldOrBetter',
        required: 10,
        label: 'Earn Gold or Author on 10 Campaign stages',
    }),
    [EXTRA_CAR_ASSETS.surge]: Object.freeze({
        progressKey: 'campaignAuthor',
        required: 5,
        label: 'Earn Author on 5 Campaign stages',
    }),
    [EXTRA_CAR_ASSETS.arctic]: Object.freeze({
        progressKey: 'campaignAuthor',
        required: 10,
        label: 'Earn Author on 10 Campaign stages',
    }),
    [EXTRA_CAR_ASSETS.fuchsia]: Object.freeze({
        progressKey: 'headToHeadTracksPosted',
        required: 1,
        label: 'Post your first Head to Head',
    }),
    [EXTRA_CAR_ASSETS.plasma]: Object.freeze({
        progressKey: 'headToHeadTracksPosted',
        required: 5,
        label: 'Post on 5 different tracks',
    }),
    [EXTRA_CAR_ASSETS.lime]: Object.freeze({
        progressKey: 'headToHeadWins',
        required: 1,
        label: 'Win your first Head to Head',
    }),
    [EXTRA_CAR_ASSETS.onyx]: Object.freeze({
        progressKey: 'headToHeadWins',
        required: 10,
        label: 'Win 10 Head to Heads',
    }),
});

const PLAYER_ASSET_SET = new Set(GENERATED_PLAYER_SELECTABLE_CAR_ASSETS);

function normalizeCount(value, max = Number.MAX_SAFE_INTEGER) {
    const count = Number(value);
    return Number.isFinite(count)
        ? Math.min(max, Math.max(0, Math.trunc(count)))
        : 0;
}

export function normalizeCarUnlockProgress(value) {
    const progress = value && typeof value === 'object' ? value : {};
    return {
        completedRace: normalizeCount(progress.completedRace, 1),
        campaignGoldOrBetter: normalizeCount(progress.campaignGoldOrBetter, 10),
        campaignAuthor: normalizeCount(progress.campaignAuthor, 10),
        headToHeadTracksPosted: normalizeCount(progress.headToHeadTracksPosted, 10),
        headToHeadWins: normalizeCount(progress.headToHeadWins),
    };
}

export function countCampaignUnlockMedals(resultsByRaceId) {
    const rows = resultsByRaceId && typeof resultsByRaceId === 'object'
        ? Object.values(resultsByRaceId)
        : [];
    let campaignGoldOrBetter = 0;
    let campaignAuthor = 0;
    for (const row of rows) {
        const medal = row?.medal;
        if (medal === 'gold' || medal === 'author') campaignGoldOrBetter += 1;
        if (medal === 'author') campaignAuthor += 1;
    }
    return {
        campaignGoldOrBetter: Math.min(10, campaignGoldOrBetter),
        campaignAuthor: Math.min(10, campaignAuthor),
    };
}

export function buildCarUnlockSnapshot({
    completedRace = false,
    postedTrackKeys = [],
    wonChallengeIds = [],
    campaignResultsByRaceId = {},
} = {}) {
    const campaign = countCampaignUnlockMedals(campaignResultsByRaceId);
    const hasCampaignResult = campaignResultsByRaceId
        && typeof campaignResultsByRaceId === 'object'
        && Object.values(campaignResultsByRaceId)
            .some((result) => result && typeof result === 'object');
    const progress = normalizeCarUnlockProgress({
        completedRace: (completedRace || hasCampaignResult) ? 1 : 0,
        ...campaign,
        headToHeadTracksPosted: new Set(postedTrackKeys).size,
        headToHeadWins: new Set(wonChallengeIds).size,
    });
    const unlockedAssets = GENERATED_PLAYER_SELECTABLE_CAR_ASSETS.filter((assetName) => {
        const requirement = CAR_UNLOCK_REQUIREMENTS[assetName];
        return !requirement || progress[requirement.progressKey] >= requirement.required;
    });
    return {
        unlockedAssets,
        progress,
    };
}

export function normalizeCarUnlockSnapshot(value) {
    const unlocked = new Set(
        Array.isArray(value?.unlockedAssets)
            ? value.unlockedAssets.filter((assetName) => PLAYER_ASSET_SET.has(assetName))
            : [],
    );
    for (const assetName of GENERATED_PLAYER_SELECTABLE_CAR_ASSETS) {
        if (!CAR_UNLOCK_REQUIREMENTS[assetName]) unlocked.add(assetName);
    }
    return {
        unlockedAssets: GENERATED_PLAYER_SELECTABLE_CAR_ASSETS.filter((assetName) => unlocked.has(assetName)),
        progress: normalizeCarUnlockProgress(value?.progress),
    };
}

export function isPlayerCarAsset(assetName) {
    return PLAYER_ASSET_SET.has(assetName);
}

export function isCarAssetUnlocked(assetName, snapshot) {
    if (!isPlayerCarAsset(assetName)) return false;
    return normalizeCarUnlockSnapshot(snapshot).unlockedAssets.includes(assetName);
}

export function getCarUnlockRequirementProgress(assetName, snapshot) {
    const requirement = CAR_UNLOCK_REQUIREMENTS[assetName];
    if (!requirement) return null;
    const progress = normalizeCarUnlockSnapshot(snapshot).progress;
    const current = Math.min(requirement.required, progress[requirement.progressKey] ?? 0);
    return {
        ...requirement,
        current,
        ratio: requirement.required > 0 ? current / requirement.required : 1,
        unlocked: current >= requirement.required,
    };
}

export function formatCarUnlockRequirement(assetName, snapshot) {
    const status = getCarUnlockRequirementProgress(assetName, snapshot);
    if (!status) return '';
    if (status.unlocked) return 'Unlocked';
    if (status.required === 1) return status.label;
    return `${status.label} · ${status.current}/${status.required}`;
}

export const DEFAULT_CAR_UNLOCK_SNAPSHOT = Object.freeze(
    normalizeCarUnlockSnapshot(buildCarUnlockSnapshot()),
);
