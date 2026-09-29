import { listMaps } from '../../../lib/maps.js';

export async function onRequestGet({ env }) {
    return Response.json({ maps: await listMaps(env.MAPMAKER_KV) });
}
