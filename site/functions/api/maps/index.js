import { MapError, listMaps } from '../../../lib/maps.js';

export async function onRequestGet({ env, data }) {
    try {
        return Response.json({ maps: await listMaps(env.MAPMAKER_KV, data?.mapmakerOwner) });
    } catch (error) {
        if (!(error instanceof MapError)) throw error;
        return Response.json({ error: error.message }, { status: error.status });
    }
}
