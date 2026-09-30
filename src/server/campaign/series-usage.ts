import { listAppSeriesDefinitions, listStoredSeries } from './series-store.js';

// A track goes in one place only: the Daily list or one Campaign stage. This
// finds the series that use a track: the stored series, and the app series
// that no stored copy replaces.
export async function readSeriesTrackUse(): Promise<Map<string, string>> {
    const stored = await listStoredSeries();
    const storedIds = new Set(stored.map((series) => series.id));
    const useByTrack = new Map<string, string>();
    for (const series of listAppSeriesDefinitions()) {
        if (storedIds.has(series.id)) continue;
        for (const stage of series.stages ?? []) useByTrack.set(stage.trackKey, series.id);
    }
    for (const series of stored) {
        for (const stage of series.stages) useByTrack.set(stage.trackKey, series.id);
    }
    return useByTrack;
}

export async function findSeriesUsingTrack(trackKey: string, exceptSeriesId?: string): Promise<string | null> {
    const seriesId = (await readSeriesTrackUse()).get(trackKey) ?? null;
    return seriesId && seriesId !== exceptSeriesId ? seriesId : null;
}
