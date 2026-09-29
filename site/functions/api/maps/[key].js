import { MapError, deleteMap, readMapBody, saveMap } from '../../../lib/maps.js';

export async function onRequestPut({ request, env, params }) {
    try {
        const map = await saveMap(env.MAPMAKER_KV, params.key, await readMapBody(request));
        return Response.json({ map });
    } catch (error) {
        if (!(error instanceof MapError)) throw error;
        return Response.json({ error: error.message }, { status: error.status });
    }
}

export async function onRequestDelete({ env, params }) {
    await deleteMap(env.MAPMAKER_KV, params.key);
    return Response.json({ deleted: params.key });
}
