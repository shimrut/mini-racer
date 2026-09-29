import {
    PASSCODE_HEADER,
    SESSION_COOKIE,
    checkPasscode,
    createSession,
    isGatedPath,
    isValidSession,
    readCookie,
    sessionCookie,
} from '../lib/gate.js';
import { UNLOCK_PATH, unlockPage } from '../lib/unlock-page.js';

const LOCKED_TEXT = 'Too many wrong passcodes. Try again in 15 minutes.';
const WRONG_TEXT = 'Wrong passcode. Try again.';

function privateResponse(response) {
    const copy = new Response(response.body, response);
    copy.headers.set('Cache-Control', 'private, no-cache');
    copy.headers.set('X-Robots-Tag', 'noindex');
    return copy;
}

async function unlock(request, env, url) {
    if (request.method !== 'POST') return Response.redirect(new URL('/mapmaker/', url), 303);
    const form = await request.formData().catch(() => null);
    const result = await checkPasscode(String(form?.get('passcode') ?? ''), env, request);
    if (result === 'locked') return unlockPage(LOCKED_TEXT, 429);
    if (result === 'wrong') return unlockPage(WRONG_TEXT, 401);
    return new Response(null, {
        status: 303,
        headers: {
            Location: '/mapmaker/',
            'Set-Cookie': sessionCookie(await createSession(env.MAPMAKER_PASSCODE), url.protocol === 'https:'),
        },
    });
}

export async function onRequest({ request, env, next }) {
    const url = new URL(request.url);
    if (!isGatedPath(url.pathname)) return next();
    if (!env.MAPMAKER_PASSCODE) return new Response('The Mapmaker passcode is not set.', { status: 503 });
    if (url.pathname === UNLOCK_PATH) return unlock(request, env, url);
    if (await isValidSession(readCookie(request, SESSION_COOKIE), env.MAPMAKER_PASSCODE)) {
        return privateResponse(await next());
    }

    const headerCode = request.headers.get(PASSCODE_HEADER);
    if (headerCode !== null) {
        const result = await checkPasscode(headerCode, env, request);
        if (result === 'ok') return privateResponse(await next());
        return Response.json(
            { error: result === 'locked' ? LOCKED_TEXT : 'Wrong passcode.' },
            { status: result === 'locked' ? 429 : 401 },
        );
    }
    if (url.pathname.startsWith('/api/')) {
        return Response.json({ error: 'The Mapmaker is locked. Reload the page and enter the passcode.' }, { status: 401 });
    }
    return unlockPage('', 401);
}
