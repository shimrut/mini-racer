import { getCombinedMedalStackTiers } from '../medals/medal-timing.js';
import { hasTrack } from '../track/catalog.js';
import { getCampaignFinalStage, getCampaignSeries } from './manifest.js';

export function formatCampaignStageLabel(stage) {
    const number = typeof stage?.numberLabel === 'string' && stage.numberLabel.trim()
        ? stage.numberLabel.trim()
        : null;
    return number ? `Stage ${number}` : 'Stage';
}

function buildLockMeter(stage) {
    const progress = stage.unlocked ? null : stage.unlockProgress;
    if (!progress || progress.medalTotal >= progress.requiredMedals) return null;
    const { medalTotal, requiredMedals } = progress;
    return {
        label: 'Medals',
        remainingMedals: Math.max(0, requiredMedals - medalTotal),
        ratio: Math.max(0, Math.min(1, medalTotal / requiredMedals)),
    };
}

// A live series without a published final stage gets more stages later.
export function campaignSeriesGetsMoreStages(seriesId) {
    return Boolean(getCampaignSeries(seriesId)) && !getCampaignFinalStage(seriesId);
}

// The stage after the last one of such a series, for the stage rail and the Tracks list.
export function buildCampaignMoreStagesStage(seriesId) {
    return { id: `${seriesId}-more`, placeholder: true, unlocked: false, trackName: 'In design' };
}

function buildMoreStagesCard(seriesId) {
    const stage = buildCampaignMoreStagesStage(seriesId);
    return {
        challengeId: stage.id,
        challenge: stage,
        trackName: stage.trackName,
        placeholder: true,
        locked: false,
    };
}

export function buildCampaignCarouselCards(campaignState = {}) {
    const stages = Array.isArray(campaignState?.stages) ? campaignState.stages : [];
    const cards = [];

    for (const stage of stages) {
        if (!stage?.id || !stage.trackKey || !hasTrack(stage.trackKey)) continue;

        cards.push({
            challengeId: stage.id,
            challenge: stage,
            trackKey: stage.trackKey,
            trackName: stage.trackName,
            skin: null,
            isCurrent: Boolean(stage.isNext && stage.unlocked),
            laps: stage.laps,
            bestLabel: stage.bestTimeMs === null ? null : stage.bestTimeLabel,
            verificationError: stage.verificationError || null,
            medal: stage.medal || null,
            medalTiers: getCombinedMedalStackTiers(stage.trackKey, stage.medal || null),
            rankLabel: Number.isInteger(stage.playerRank) && stage.playerRank > 0
                ? `#${stage.playerRank}`
                : null,
            rankPending: stage.standingsResolved === false,
            locked: !stage.unlocked,
            lockedLabel: stage.unlockRequirementLabel || null,
            unlockRequirements: Array.isArray(stage.unlockRequirements)
                ? stage.unlockRequirements
                : [],
            lockMeter: buildLockMeter(stage),
        });
    }

    const seriesId = campaignState?.seriesId;
    if (cards.length && campaignSeriesGetsMoreStages(seriesId)) {
        cards.push(buildMoreStagesCard(seriesId));
    }
    return cards;
}
