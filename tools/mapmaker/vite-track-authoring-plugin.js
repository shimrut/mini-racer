import { applyTrackRepositoryUpdate } from './track-repository.js';

const ENDPOINT = '/__mapmaker/save-track';
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

function isLocalHost(host = '') {
    return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
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

export function mapmakerTrackAuthoringPlugin() {
    return {
        name: 'mini-racer-mapmaker-track-authoring',
        apply: 'serve',
        configureServer(server) {
            server.middlewares.use(async (request, response, next) => {
                const pathname = new URL(request.url || '/', 'http://localhost').pathname;
                if (pathname !== ENDPOINT) {
                    next();
                    return;
                }
                if (request.method !== 'POST') {
                    writeJson(response, 405, { error: 'Method not allowed.' });
                    return;
                }
                if (!isLocalHost(request.headers.host)) {
                    writeJson(response, 403, {
                        error: 'Mapmaker repository writes are available only from localhost.',
                    });
                    return;
                }

                try {
                    const payload = await readJsonBody(request);
                    const result = applyTrackRepositoryUpdate({
                        rootDir: server.config.root,
                        trackKey: payload.trackKey,
                        originalTrackKey: payload.originalTrackKey ?? null,
                        trackName: payload.trackName,
                        track: payload.track,
                    });
                    writeJson(response, 200, result);
                } catch (error) {
                    writeJson(response, 400, {
                        error: error instanceof Error ? error.message : 'Unable to save track.',
                    });
                }
            });
        },
    };
}
