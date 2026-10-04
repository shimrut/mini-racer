import {
    PASSCODE_HEADER,
    OWNER_HEADER,
    SESSION_COOKIE,
    LEGACY_OWNER,
    GateConfigurationError,
    authenticatePasscode,
    clearSessionCookie,
    createSession,
    isGatedPath,
    publicOwnerId,
    readCookie,
    readWorkspaces,
    sessionCookie,
    sessionOwner,
} from '../lib/gate.js';
import { UNLOCK_PATH, unlockPage } from '../lib/unlock-page.js';
import { TRACK_GROUND_KEYS, DEFAULT_TRACK_GROUND_KEY } from '../../game/track/grounds.js';

const LOCKED_TEXT = 'Too many wrong passcodes. Try again in 15 minutes.';
const WRONG_TEXT = 'Wrong passcode. Try again.';

function privateResponse(response) {
    const copy = new Response(response.body, response);
    copy.headers.set('Cache-Control', 'private, no-store');
    copy.headers.set('X-Robots-Tag', 'noindex');
    return copy;
}

async function unlock(request, env, url, workspaces) {
    if (request.method !== 'POST') return Response.redirect(new URL('/mapmaker/', url), 303);
    const form = await request.formData().catch(() => null);
    const result = await authenticatePasscode(String(form?.get('passcode') ?? ''), env, request, workspaces);
    if (result.status === 'locked') return unlockPage(LOCKED_TEXT, 429);
    if (result.status === 'wrong') return unlockPage(WRONG_TEXT, 401);
    return new Response(null, {
        status: 303,
        headers: {
            Location: '/mapmaker/',
            'Set-Cookie': sessionCookie(
                await createSession(workspaces.get(result.ownerId), Date.now(), result.ownerId),
                url.protocol === 'https:',
            ),
        },
    });
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    if (!isGatedPath(url.pathname)) return context.next();
    let workspaces;
    try {
        workspaces = readWorkspaces(env);
    } catch (error) {
        if (!(error instanceof GateConfigurationError)) throw error;
        return privateResponse(new Response('The Mapmaker password configuration is not valid.', { status: 503 }));
    }
    if (url.pathname === UNLOCK_PATH) return privateResponse(await unlock(request, env, url, workspaces));
    if (url.pathname === '/api/session' && request.method === 'DELETE') {
        return privateResponse(new Response(null, {
            status: 204,
            headers: { 'Set-Cookie': clearSessionCookie(url.protocol === 'https:') },
        }));
    }

    let ownerId;
    // An explicit local-import password chooses its workspace even if a browser
    // cookie happens to exist. A wrong header cannot fall back to that cookie.
    const headerCode = request.headers.get(PASSCODE_HEADER);
    if (headerCode !== null) {
        const result = await authenticatePasscode(headerCode, env, request, workspaces);
        if (result.status !== 'ok') {
            return privateResponse(Response.json(
                { error: result.status === 'locked' ? LOCKED_TEXT : 'Wrong passcode.' },
                { status: result.status === 'locked' ? 429 : 401 },
            ));
        }
        ownerId = result.ownerId;
    } else {
        ownerId = await sessionOwner(readCookie(request, SESSION_COOKIE), workspaces);
    }
    if (ownerId !== null) {
        const opaqueOwnerId = await publicOwnerId(ownerId);
        const expectedOwner = request.headers.get(OWNER_HEADER);
        if (expectedOwner !== null && expectedOwner !== opaqueOwnerId) {
            return privateResponse(Response.json(
                { error: 'Your Mapmaker password changed in another tab. Reload before continuing.' },
                { status: 409 },
            ));
        }
        if (url.pathname === '/api/session') {
            return privateResponse(request.method === 'GET'
                ? Response.json({
                    ownerId: opaqueOwnerId,
                    groundKeys: ownerId === LEGACY_OWNER ? TRACK_GROUND_KEYS : [DEFAULT_TRACK_GROUND_KEY],
                })
                : new Response(null, { status: 405, headers: { Allow: 'GET, DELETE' } }));
        }
        // Only server-authenticated context can select a cloud map namespace.
        context.data ??= {};
        context.data.mapmakerOwner = ownerId;
        return privateResponse(await context.next());
    }
    if (url.pathname.startsWith('/api/')) {
        return privateResponse(Response.json({ error: 'The Mapmaker is locked. Reload the page and enter the passcode.' }, { status: 401 }));
    }
    return privateResponse(unlockPage('', 401));
}
