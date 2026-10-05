import { formatCampaignTotalTime, readCampaignPlace } from './aggregate.js';
import { getCampaignSeriesGrounds } from './series-surfaces.js';

export function campaignPosterTheme(_seriesId, ground, grounds = []) {
    const surfaces = getCampaignSeriesGrounds({ ground, ...(grounds.length ? { grounds } : {}) });
    if (surfaces.length > 1) return 'mixed';
    if (surfaces[0] === 'tarmac') return 'street';
    if (surfaces[0] === 'grip') return 'grip';
    if (surfaces[0] === 'dirt') return 'dirt';
    if (surfaces[0] === 'snow') return 'snow';
    return 'custom';
}

export function campaignPosterTime(timeMs) {
    const exact = formatCampaignTotalTime(timeMs);
    return exact ? exact.slice(0, exact.lastIndexOf('.')) : '';
}

export function campaignPosterPlace(place) {
    const valid = readCampaignPlace(place);
    if (!valid) return null;
    const total = valid.total > 1000
        ? `${Number((valid.total / 1000).toFixed(1))}K` : String(valid.total);
    return {
        headline: valid.rank >= 1000 ? `Top ${Math.ceil(valid.rank / valid.total * 100)}%` : `#${valid.rank}`,
        caption: `out of ${total}`,
    };
}

const COMPLETION_ACCENTS = {
    street: '#ff4659', dirt: '#f8c44c', snow: '#76cbf8',
    grip: '#d854eb', mixed: '#c7cdd5', custom: '#d854eb',
};

export function campaignCompletionAccent(series = {}) {
    return COMPLETION_ACCENTS[campaignPosterTheme(series?.id, series?.ground, series?.grounds ?? [])];
}
