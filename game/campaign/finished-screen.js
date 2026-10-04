import { formatSeriesMedals, getSeriesKerbColors } from '../lobby/campaign-series-picker.js';
import {
    countCampaignMedals,
    getCampaignSeries,
    isCampaignSeriesFinished,
} from './manifest.js';
import { getCampaignSeriesSurfaceLabel } from './series-surfaces.js';

// One screen for every campaign. The series that was just finished fills the
// title, surface, stage count and medal total. A series the game does not
// currently publish, or one that is not finished, has no screen.
export function buildCampaignFinishedScreen(seriesId, resultsByRaceId = {}) {
    const series = getCampaignSeries(seriesId);
    if (!series || !isCampaignSeriesFinished(seriesId, resultsByRaceId)) return null;

    const stageCount = series.stages.length;
    const medalCount = countCampaignMedals(resultsByRaceId, seriesId);
    const surfaceLabel = getCampaignSeriesSurfaceLabel(series);
    const mastered = series.stages.every((stage) => {
        const medal = resultsByRaceId?.[stage.raceId]?.medal;
        return medal === 'gold' || medal === 'author';
    });
    const ground = series.grounds?.[0] ?? series.ground;

    return {
        seriesId: series.id,
        seriesName: series.name,
        eyebrow: 'Campaign finished',
        title: series.name,
        summary: mastered
            ? `${series.name} is finished, with gold or better on every stage.`
            : `${series.name} is finished.`,
        kerb: getSeriesKerbColors(ground),
        facts: [
            { label: 'Stages', value: String(stageCount) },
            { label: 'Medals', value: formatSeriesMedals({ medalCount, stageCount }) },
            { label: 'Surface', value: surfaceLabel },
        ],
    };
}
