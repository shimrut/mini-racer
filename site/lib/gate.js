// The passcode gate for the online Mapmaker (/mapmaker) and its cloud maps (/api/).
// A right passcode on the unlock page sets a signed session cookie. The local
// Mapmaker sends the passcode in a header instead. Wrong codes are counted for
// each address, and too many lock that address out for a while.

export const SESSION_COOKIE = 'mapmaker_session';
export const PASSCODE_HEADER = 'X-Mapmaker-Passcode';
export const OWNER_HEADER = 'X-Mapmaker-Owner';
export const LEGACY_OWNER = 'legacy';
export const MAX_FAILURES = 5;
export const LOCK_SECONDS = 15 * 60;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const FAILURE_PREFIX = 'unlock-failures:';
const encoder = new TextEncoder();

export class GateConfigurationError extends Error {}

export function isWorkspaceId(ownerId) {
    return typeof ownerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ownerId);
}

// Stable workspace IDs own maps; rotating a password must not move those maps.
// The original password keeps the original map: namespace for existing drafts.
export function readWorkspaces(env) {
    const workspaces = new Map();
    const passwords = new Set();
    const add = (ownerId, passcode) => {
        if (!isWorkspaceId(ownerId) || typeof passcode !== 'string' || !passcode.length
            || passcode.length > 1024 || workspaces.has(ownerId) || passwords.has(passcode)) {
            throw new GateConfigurationError('The Mapmaker password configuration is not valid.');
        }
        workspaces.set(ownerId, passcode);
        passwords.add(passcode);
    };
    if (env.MAPMAKER_PASSCODE !== undefined) add(LEGACY_OWNER, env.MAPMAKER_PASSCODE);
    if (env.MAPMAKER_PASSCODES !== undefined) {
        const raw = env.MAPMAKER_PASSCODES;
        let configured;
        try {
            configured = JSON.parse(raw);
        } catch {
            throw new GateConfigurationError('The Mapmaker password configuration is not valid.');
        }
        if (typeof raw !== 'string' || !configured || Array.isArray(configured)
            || typeof configured !== 'object' || !Object.values(configured).every((value) => typeof value === 'string')) {
            throw new GateConfigurationError('The Mapmaker password configuration is not valid.');
        }
        // JSON.parse normally silently discards duplicate keys. Walk the tokens
        // of this flat string-to-string object to reject duplicate IDs too.
        const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}:,]/g);
        for (let index = 1; index < tokens.length - 1; index += 4) {
            const ownerId = JSON.parse(tokens[index]);
            if (ownerId === LEGACY_OWNER) {
                throw new GateConfigurationError('The legacy Mapmaker workspace is reserved.');
            }
            add(ownerId, JSON.parse(tokens[index + 2]));
        }
    }
    if (!workspaces.size) throw new GateConfigurationError('The Mapmaker password is not set.');
    return workspaces;
}

export async function publicOwnerId(ownerId) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`mapmaker-owner:${ownerId}`)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

// Owner and expiry are signed together. A rotated password ends its sessions
// while its stable workspace ID continues to own the same drafts.
export async function createSession(passcode, now = Date.now(), ownerId = LEGACY_OWNER) {
    if (!isWorkspaceId(ownerId)) throw new GateConfigurationError('The Mapmaker workspace is not valid.');
    const expires = String(now + SESSION_SECONDS * 1000);
    const text = `v2.${ownerId}.${expires}`;
    return `${text}.${await sign(passcode, text)}`;
}

export async function isValidSession(token, passcode, now = Date.now(), ownerId = LEGACY_OWNER) {
    const parts = String(token ?? '').split('.');
    let text;
    let expires;
    let signature;
    if (parts.length === 4 && parts[0] === 'v2' && parts[1] === ownerId) {
        [, , expires, signature] = parts;
        text = parts.slice(0, 3).join('.');
    } else if (parts.length === 2 && ownerId === LEGACY_OWNER) {
        // Existing cookies can enter only the original workspace.
        [expires, signature] = parts;
        text = expires;
    } else {
        return false;
    }
    if (!/^\d+$/.test(expires) || !signature || !(Number(expires) > now)) return false;
    return safeEqual(signature, await sign(passcode, text));
}

export async function sessionOwner(token, workspaces, now = Date.now()) {
    const parts = String(token ?? '').split('.');
    const ownerId = parts[0] === 'v2' ? parts[1] : LEGACY_OWNER;
    const passcode = workspaces.get(ownerId);
    if (passcode === undefined) return null;
    return await isValidSession(token, passcode, now, ownerId) ? ownerId : null;
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

export function clearSessionCookie(secure) {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function failureKey(request) {
    return FAILURE_PREFIX + (request.headers.get('CF-Connecting-IP') ?? 'unknown');
}

export async function authenticatePasscode(code, env, request, workspaces = readWorkspaces(env)) {
    const key = failureKey(request);
    const failures = Number(await env.MAPMAKER_KV.get(key));
    if (failures >= MAX_FAILURES) return { status: 'locked' };
    let matchedOwner = null;
    for (const [ownerId, passcode] of workspaces) {
        if (safeEqual(code, passcode)) matchedOwner = ownerId;
    }
    if (matchedOwner !== null) return { status: 'ok', ownerId: matchedOwner };
    await env.MAPMAKER_KV.put(key, String(failures + 1), { expirationTtl: LOCK_SECONDS });
    return { status: 'wrong' };
}

// Returns 'ok', 'wrong', or 'locked'.
export async function checkPasscode(code, env, request) {
    return (await authenticatePasscode(code, env, request)).status;
}
