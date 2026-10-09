import {
  API_ROUTES,
} from '../scoreboard/api-client.js';
import {
  getGuestPlayerToken,
  getOrCreatePlayerId,
  setGuestPlayerToken,
} from '../scoreboard/player-identity.js';
import { isLocalEnvironment } from '../track/environment.js';

function addPlayerIdentity(url) {
  url.searchParams.set('playerId', getOrCreatePlayerId('personal best ghost'));
  const guestToken = getGuestPlayerToken();
  if (guestToken) url.searchParams.set('guestToken', guestToken);
}

async function readJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  setGuestPlayerToken(payload?.guestToken ?? getGuestPlayerToken());
  return payload;
}

export class PbGhostService {
  constructor({ routes = API_ROUTES, fetchImpl = null } = {}) {
    this.routes = routes;
    this.fetchImpl = typeof fetchImpl === 'function'
      ? fetchImpl
      : typeof globalThis.fetch === 'function'
        ? (...args) => globalThis.fetch(...args)
        : null;
    this.recordCache = new Map();
    this.requestGenerationByChallengeId = new Map();
  }

  clear() {
    for (const challengeId of this.requestGenerationByChallengeId.keys()) {
      this.bumpRequestGeneration(challengeId);
    }
    this.recordCache.clear();
  }

  invalidate(challengeId) {
    if (!challengeId) return;
    this.bumpRequestGeneration(challengeId);
    this.recordCache.delete(challengeId);
  }

  bumpRequestGeneration(challengeId) {
    const nextGeneration = (this.requestGenerationByChallengeId.get(challengeId) || 0) + 1;
    this.requestGenerationByChallengeId.set(challengeId, nextGeneration);
    return nextGeneration;
  }

  installForChallenge(challengeId, record) {
    if (typeof challengeId !== 'string' || !challengeId.trim()) return null;
    const normalizedId = challengeId.trim();
    this.bumpRequestGeneration(normalizedId);
    this.rememberRecord(normalizedId, record ?? null);
    return record ?? null;
  }

  // A record whose moved ghost could not be read now is not cached, so the next request asks again.
  rememberRecord(challengeId, record) {
    if (record?.ghostUnavailable) this.recordCache.delete(challengeId);
    else this.recordCache.set(challengeId, record);
  }

  async getSummaries(challengeIds) {
    const ids = [...new Set(
      (Array.isArray(challengeIds) ? challengeIds : [])
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim()),
    )].slice(0, 7);
    if (
      !ids.length
      || isLocalEnvironment()
      || typeof this.fetchImpl !== 'function'
    ) {
      return {};
    }

    const url = new URL(this.routes.playerTrackPbsUrl, globalThis.location?.origin ?? 'http://localhost');
    url.searchParams.set('challengeIds', ids.join(','));
    addPlayerIdentity(url);
    const payload = await readJsonResponse(
      await this.fetchImpl(url.toString(), { method: 'GET' }),
      'Personal best summary request',
    );
    return payload?.trackPbs && typeof payload.trackPbs === 'object'
      ? payload.trackPbs
      : {};
  }

  async getForChallenge(challengeId, { forceRefresh = false } = {}) {
    if (typeof challengeId !== 'string' || !challengeId.trim()) return null;
    const normalizedId = challengeId.trim();
    if (!forceRefresh && this.recordCache.has(normalizedId)) {
      return this.recordCache.get(normalizedId);
    }
    if (isLocalEnvironment() || typeof this.fetchImpl !== 'function') return null;

    const requestGeneration = this.bumpRequestGeneration(normalizedId);
    const url = new URL(this.routes.playerPbGhostUrl, globalThis.location?.origin ?? 'http://localhost');
    url.searchParams.set('challengeId', normalizedId);
    addPlayerIdentity(url);
    const payload = await readJsonResponse(
      await this.fetchImpl(url.toString(), { method: 'GET' }),
      'Personal best ghost request',
    );
    if (
      requestGeneration !== this.requestGenerationByChallengeId.get(normalizedId)
    ) {
      return null;
    }

    const record = payload?.personalBest ?? payload?.trackPb ?? payload?.record ?? null;
    this.rememberRecord(normalizedId, record);
    return record;
  }
}
