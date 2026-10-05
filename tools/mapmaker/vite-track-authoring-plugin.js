import {
    applySeriesStageMove,
    applyTrackAssignment,
    applyTrackRepositoryRemoval,
    applyTrackRepositoryUpdate,
} from './track-repository.js';
import { isValidTrackKey } from './track-source.js';
import { parseTrackDestination } from './campaign-series.js';
import { LEGACY_OWNER, PASSCODE_HEADER, isWorkspaceId } from '../../site/lib/gate.js';

const ENDPOINT = '/__mapmaker/save-track';
const REMOVE_ENDPOINT = '/__mapmaker/remove-track';
const MOVE_STAGE_ENDPOINT = '/__mapmaker/move-stage';
const ASSIGN_ENDPOINT = '/__mapmaker/assign-track';
const CLOUD_ENDPOINT = '/__mapmaker/cloud-maps';
const ENDPOINTS = new Set([ENDPOINT, REMOVE_ENDPOINT, MOVE_STAGE_ENDPOINT, ASSIGN_ENDPOINT, CLOUD_ENDPOINT]);
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

function isLocalHost(host = '') {
    return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

function isSameLocalOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
        const parsed = new URL(origin);
        return parsed.protocol === 'http:' && parsed.host === request.headers.host;
    } catch {
        return false;
    }
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_REQUEST_BYTES) {
                reject(new Error('Mapmaker save payload is too large.'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new Error('Mapmaker save payload is not valid JSON.'));
            }
        });
        request.on('error', reject);
    });
}

function writeJson(response, statusCode, body) {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(body));
}

function readPayloadTrackKey(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Mapmaker save payload is invalid.');
    }
    const trackKey = typeof payload.trackKey === 'string' ? payload.trackKey.trim() : '';
    if (!isValidTrackKey(trackKey)) {
        throw new Error('Track key must be a valid non-reserved JavaScript identifier.');
    }
    return trackKey;
}

function optionalInteger(value, label) {
    if (value == null || value === '') return null;
    const number = Number(value);
    if (!Number.isInteger(number)) throw new Error(`${label} must be a whole number.`);
    return number;
}

function normalizeAssignPayload(payload) {
    const trackKey = readPayloadTrackKey(payload);
    if (!parseTrackDestination(payload.destination)) {
        throw new Error('Destination must be daily, not used, or a Campaign series.');
    }
    return {
        trackKey,
        destination: payload.destination,
        laps: optionalInteger(payload.laps, 'Laps'),
        requiredMedals: optionalInteger(payload.requiredMedals, 'The medal target'),
    };
}

function normalizeSavePayload(payload) {
    const trackKey = readPayloadTrackKey(payload);

    const rawOriginal = payload.originalTrackKey;
    const originalTrackKey = rawOriginal == null || rawOriginal === ''
        ? null
        : String(rawOriginal).trim();
    if (originalTrackKey !== null && !isValidTrackKey(originalTrackKey)) {
        throw new Error('Original track key must be a valid non-reserved JavaScript identifier.');
    }

    const trackName = typeof payload.trackName === 'string' ? payload.trackName.trim() : '';
    if (!trackName) {
        throw new Error('Track name cannot be empty.');
    }

    if (!payload.track || typeof payload.track !== 'object') {
        throw new Error('Track geometry payload is required.');
    }

    return {
        trackKey,
        originalTrackKey,
        trackName,
        medalRow: payload.medalRow && typeof payload.medalRow === 'object' ? payload.medalRow : null,
        track: payload.track,
    };
}

// Lists or deletes the maps saved in the online Mapmaker. Returns [status, body].
async function forwardCloudRequest(cloud, payload) {
    if (!cloud.passcode) {
        return [501, { error: 'Add MAPMAKER_PASSCODE to .env.local and restart npm run mapmaker to see your cloud maps.' }];
    }
    const method = payload?.method;
    const cloudId = typeof payload?.key === 'string' ? payload.key : '';
    const parts = cloudId.split(':');
    const workspace = parts.length === 2 ? parts[0] : LEGACY_OWNER;
    const key = parts.length === 2 ? parts[1] : cloudId;
    const validRequest = (method === 'GET' && !cloudId) || (method === 'DELETE' && isValidTrackKey(key));
    if (!validRequest || parts.length > 2 || !isWorkspaceId(workspace)) {
        return [400, { error: 'Cloud maps request is invalid.' }];
    }
    const url = new URL(`/api/maps${key ? `/${encodeURIComponent(key)}` : ''}`, cloud.url);
    url.searchParams.set('scope', 'all');
    if (method === 'DELETE') url.searchParams.set('workspace', workspace);
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: { [PASSCODE_HEADER]: cloud.passcode },
        });
    } catch {
        return [502, { error: `Cannot reach ${cloud.url}.` }];
    }
    return [response.status, await response.json().catch(() => ({ error: `${cloud.url} answered ${response.status}.` }))];
}

// cloud: { url, passcode } of the online Mapmaker, for the Cloud maps list.
export function mapmakerTrackAuthoringPlugin(cloud = { url: '', passcode: '' }) {
    return {
        name: 'mini-racer-mapmaker-track-authoring',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                const pathname = new URL(request.url || '/', 'http://localhost').pathname;
                if (!ENDPOINTS.has(pathname)) {
                    next();
                    return;
                }
                if (request.method !== 'POST') {
                    writeJson(response, 405, { error: 'Method not allowed.' });
                    return;
                }
                if (!isLocalHost(request.headers.host) || !isSameLocalOrigin(request)) {
                    writeJson(response, 403, {
                        error: 'Mapmaker repository writes are available only from localhost.',
                    });
                    return;
                }

                try {
                    if (pathname === CLOUD_ENDPOINT) {
                        writeJson(response, ...await forwardCloudRequest(cloud, await readJsonBody(request)));
                        return;
                    }
                    if (pathname === REMOVE_ENDPOINT) {
                        const payload = await readJsonBody(request);
                        const trackKey = typeof payload?.trackKey === 'string'
                            ? payload.trackKey.trim()
                            : '';
                        if (!isValidTrackKey(trackKey)) {
                            throw new Error('Track key must be a valid non-reserved JavaScript identifier.');
                        }
                        writeJson(response, 200, applyTrackRepositoryRemoval({
                            rootDir: server.config.root,
                            trackKey,
                        }));
                        return;
                    }
                    if (pathname === MOVE_STAGE_ENDPOINT) {
                        const payload = await readJsonBody(request);
                        writeJson(response, 200, applySeriesStageMove({
                            rootDir: server.config.root,
                            seriesId: typeof payload?.seriesId === 'string' ? payload.seriesId : '',
                            trackKey: typeof payload?.trackKey === 'string' ? payload.trackKey.trim() : '',
                            direction: Number(payload?.direction) < 0 ? -1 : 1,
                        }));
                        return;
                    }
                    if (pathname === ASSIGN_ENDPOINT) {
                        writeJson(response, 200, applyTrackAssignment({
                            rootDir: server.config.root,
                            ...normalizeAssignPayload(await readJsonBody(request)),
                        }));
                        return;
                    }
                    writeJson(response, 200, applyTrackRepositoryUpdate({
                        rootDir: server.config.root,
                        ...normalizeSavePayload(await readJsonBody(request)),
                    }));
                } catch (error) {
                    writeJson(response, 400, {
                        error: error instanceof Error ? error.message : 'Unable to update track.',
                    });
                }
            });
        },
    };
}
