/**
 * Card models for the Campaign lobby track carousel.
 *
 * Campaign reads as a run of numbered stages rather than a run of days, and a
 * locked stage still earns a card: seeing what is coming, and what opens it, is
 * most of what the screen is for.
 */
import { getCombinedMedalStackTiers } from '../medals/medal-timing.js';
import { TRACKS } from '../track/tracks.js';

export function formatCampaignStageLabel(stage) {
    const number = typeof stage?.numberLabel === 'string' && stage.numberLabel.trim()
        ? stage.numberLabel.trim()
        : null;
    return number ? `Stage ${number}` : 'Stage';
}

function formatLapsLabel(laps) {
    const safeLaps = Number.isInteger(laps) && laps > 0 ? laps : 1;
    return `${safeLaps} ${safeLaps === 1 ? 'Lap' : 'Laps'}`;
}

/**
 * A locked stage states its gate instead of its lap count — the requirement is
 * the only thing a player can act on there. Once the medal counter is carrying
 * the price, though, repeating it here would print the same number twice on one
 * card, so the meta line falls back to what the stage is.
 */
function buildMetaLabel(stage, lapsLabel) {
    if (!stage.unlocked) {
        if (stage.unlockProgress && !stage.unlockProgress.awaitingPreviousMedal) return lapsLabel;
        return stage.unlockRequirementLabel || 'Locked';
    }
    return stage.bestTimeMs === null
        ? lapsLabel
        : `${lapsLabel} · PB ${stage.bestTimeLabel}`;
}

/**
 * What an unlocked card spends on its rank, a locked one spends on the number
 * that actually governs it. The ratio drives a fill bar: five locked cards each
 * a little fuller reads as a ladder in a way five bare fractions do not.
 */
function buildLockMeter(stage) {
    const progress = stage.unlocked ? null : stage.unlockProgress;
    if (!progress) return null;
    const { medalTotal, requiredMedals } = progress;
    return {
        label: 'Medals',
        value: `${medalTotal}/${requiredMedals}`,
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
            eyebrowLabel: formatCampaignStageLabel(stage),
            // The stage the campaign is asking for next is the one to mark.
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
            // Until the bootstrap answers, "no rank" would be a guess.
            rankPending: stage.standingsResolved === false,
            locked: !stage.unlocked,
            lockedLabel: stage.unlockRequirementLabel || null,
            lockMeter: buildLockMeter(stage),
        });
    }

    return cards;
}
