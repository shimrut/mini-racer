// Shared Campaign medal count used by the series screen and completion screen.
const MEDALS_PER_STAGE = 4;

// "12/64": the medals a player holds in a series, of the most it can give.
export function formatSeriesMedals(series) {
    const medalCount = Number.isInteger(series?.medalCount) ? series.medalCount : 0;
    const stageCount = Number.isInteger(series?.stageCount) ? series.stageCount : 0;
    return `${medalCount}/${stageCount * MEDALS_PER_STAGE}`;
}
