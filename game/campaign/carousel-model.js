import { getCombinedMedalStackTiers } from '../medals/medal-timing.js';
import { TRACKS } from '../track/tracks.js';
import { formatLapsLabel } from '../shared/laps-label.js';

export function formatCampaignStageLabel(stage) {
    const number = typeof stage?.numberLabel === 'string' && stage.numberLabel.trim()
        ? stage.numberLabel.trim()
        : null;
    return number ? `Stage ${number}` : 'Stage';
}

function buildMetaLabel(stage, lapsLabel) {
    if (!stage.unlocked) {
        if (stage.unlockProgress && !stage.unlockProgress.awaitingPreviousMedal) return lapsLabel;
        return stage.unlockRequirementLabel || 'Locked';
    }
    return stage.bestTimeMs === null
        ? lapsLabel
        : `${lapsLabel} · PB ${stage.bestTimeLabel}`;
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

export function buildCampaignCarouselCards(campaignState = {}) {
    const stages = Array.isArray(campaignState?.stages) ? campaignState.stages : [];
    const cards = [];

    for (const stage of stages) {
        if (!stage?.id || !stage.trackKey || !TRACKS[stage.trackKey]) continue;
        const lapsLabel = formatLapsLabel(stage.laps);

        cards.push({
            challengeId: stage.id,
            challenge: stage,
            trackKey: stage.trackKey,
            trackName: stage.trackName,
            skin: null,
            modeLabel: 'Campaign',
            billingLabel: formatCampaignStageLabel(stage),
            isCurrent: Boolean(stage.isNext && stage.unlocked),
            laps: stage.laps,
            lapsLabel,
            bestLabel: stage.bestTimeMs === null ? null : stage.bestTimeLabel,
            metaLabel: buildMetaLabel(stage, lapsLabel),
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

    return cards;
}
