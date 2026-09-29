// The passcode gate for the online Mapmaker (/mapmaker) and its cloud maps (/api/).
// A right passcode on the unlock page sets a signed session cookie. The local
// Mapmaker sends the passcode in a header instead. Wrong codes are counted for
// each address, and too many lock that address out for a while.

export const SESSION_COOKIE = 'mapmaker_session';
export const PASSCODE_HEADER = 'X-Mapmaker-Passcode';
export const MAX_FAILURES = 5;
export const LOCK_SECONDS = 15 * 60;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const FAILURE_PREFIX = 'unlock-failures:';
const encoder = new TextEncoder();

export function isGatedPath(pathname) {
    return pathname === '/mapmaker' || pathname.startsWith('/mapmaker/') || pathname.startsWith('/api/');
}

// Takes the same time wherever the two texts differ.
export function safeEqual(a, b) {
    const left = encoder.encode(String(a ?? ''));
    const right = encoder.encode(String(b ?? ''));
    let difference = left.length ^ right.length;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ (right[index] ?? 0);
    }
    return difference === 0;
}

async function sign(passcode, text) {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(passcode),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`mapmaker-session:${text}`)));
    return btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A session is its end time and a signature made with the passcode, so a new
// passcode ends every session.
export async function createSession(passcode, now = Date.now()) {
    const expires = String(now + SESSION_SECONDS * 1000);
    return `${expires}.${await sign(passcode, expires)}`;
}

export async function isValidSession(token, passcode, now = Date.now()) {
    const [expires, signature] = String(token ?? '').split('.');
    if (!signature || !(Number(expires) > now)) return false;
    return safeEqual(signature, await sign(passcode, expires));
}

export function readCookie(request, name) {
    for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name) return value.join('=');
    }
    return null;
}

export function sessionCookie(token, secure) {
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function failureKey(request) {
    return FAILURE_PREFIX + (request.headers.get('CF-Connecting-IP') ?? 'unknown');
}

// Returns 'ok', 'wrong', or 'locked'.
export async function checkPasscode(code, env, request) {
    const key = failureKey(request);
    const failures = Number(await env.MAPMAKER_KV.get(key));
    if (failures >= MAX_FAILURES) return 'locked';
    if (safeEqual(code, env.MAPMAKER_PASSCODE)) return 'ok';
    await env.MAPMAKER_KV.put(key, String(failures + 1), { expirationTtl: LOCK_SECONDS });
    return 'wrong';
}
