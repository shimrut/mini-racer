import { MapError, deleteMap, readMapBody, saveMap } from '../../../lib/maps.js';

export async function onRequestPut({ request, env, params, data }) {
    try {
        const map = await saveMap(env.MAPMAKER_KV, params.key, await readMapBody(request), data?.mapmakerOwner);
        return Response.json({ map });
    } catch (error) {
        if (!(error instanceof MapError)) throw error;
        return Response.json({ error: error.message }, { status: error.status });
    }
}

export async function onRequestDelete({ env, params, data }) {
    try {
        await deleteMap(env.MAPMAKER_KV, params.key, data?.mapmakerImportOwner ?? data?.mapmakerOwner);
        return Response.json({ deleted: params.key });
    } catch (error) {
        if (!(error instanceof MapError)) throw error;
        return Response.json({ error: error.message }, { status: error.status });
    }
}
