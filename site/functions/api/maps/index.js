import { MapError, listAllMaps, listMaps } from '../../../lib/maps.js';

export async function onRequestGet({ env, data }) {
    try {
        const maps = data?.mapmakerImportAll
            ? await listAllMaps(env.MAPMAKER_KV)
            : await listMaps(env.MAPMAKER_KV, data?.mapmakerOwner);
        return Response.json({ maps });
    } catch (error) {
        if (!(error instanceof MapError)) throw error;
        return Response.json({ error: error.message }, { status: error.status });
    }
}
