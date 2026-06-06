import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  buildDailyGpPlaylist,
} from './daily-gp-model.ts';
import {
  getServerDailyGpChallenge,
  getServerDailyGpChallengeForTrack,
  getServerDailyGpSnapshot,
  getServerPlayerBootstrap,
  submitServerDailyGpRun,
  updateServerPlayerIdentity,
} from './daily-gp-store.ts';

const DEFAULT_ALLOWED_ORIGIN = 'https://me.alfread.io';
const ALLOWED_ORIGINS = new Set([
  DEFAULT_ALLOWED_ORIGIN,
  'https://vectorgp.run',
]);
const CORS_RESPONSE_HEADERS = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  Vary: 'Origin',
};

function getRequestOrigin(req: Request) {
  const origin = req.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return origin;
  }

  const referer = req.headers.get('Referer');
  if (!referer) {
    return null;
  }

  try {
    const refererOrigin = new URL(referer).origin;
    return ALLOWED_ORIGINS.has(refererOrigin) ? refererOrigin : null;
  } catch (_error) {
    return null;
  }
}

function getCorsHeaders(requestOrigin: string | null) {
  return requestOrigin
    ? {
      ...CORS_RESPONSE_HEADERS,
      'Access-Control-Allow-Origin': requestOrigin,
    }
    : CORS_RESPONSE_HEADERS;
}

function jsonResponse(
  body: Record<string, unknown> | unknown[],
  status = 200,
  requestOrigin: string | null = DEFAULT_ALLOWED_ORIGIN,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(requestOrigin),
      'Content-Type': 'application/json',
    },
  });
}

function getSupabaseClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

Deno.serve(async (req) => {
  const requestOrigin = getRequestOrigin(req);
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    if (!requestOrigin) {
      return new Response('forbidden', {
        status: 403,
        headers: getCorsHeaders(null),
      });
    }

    return new Response('ok', { headers: getCorsHeaders(requestOrigin) });
  }

  if (!requestOrigin) {
    return jsonResponse({
      error: 'Requests are only accepted from allowed game origins',
    }, 403, null);
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return jsonResponse({ error: 'Supabase function is not configured' }, 500, requestOrigin);
  }

  try {
    if (pathname === '/api/player/bootstrap' || pathname.endsWith('/api/player/bootstrap')) {
      const { playerId } = Object.fromEntries(url.searchParams.entries());
      const payload = await getServerPlayerBootstrap(supabase, {
        playerId,
      });
      return jsonResponse(payload, 200, requestOrigin);
    }

    if (pathname === '/api/player/identity' || pathname.endsWith('/api/player/identity')) {
      const { playerId, leaderboardIdentity } = await req.json().catch(() => ({}));
      const payload = await updateServerPlayerIdentity(supabase, {
        playerId,
        leaderboardIdentity,
      });
      return jsonResponse(payload, 200, requestOrigin);
    }

    if (pathname === '/api/scoreboard/snapshot' || pathname.endsWith('/api/scoreboard/snapshot')) {
      const { trackKey, playerId, limit } = Object.fromEntries(url.searchParams.entries());
      const activeChallenge = await getServerDailyGpChallenge();
      const challenge = getServerDailyGpChallengeForTrack(trackKey ?? null);
      if (!challenge) {
        return jsonResponse({
          topRows: [],
          nearbyRows: [],
          currentPlayerRow: null,
          totalCount: 0,
          leaderboardEntryCount: 0,
          playerRank: null,
          playerRankLabel: null,
          objectiveType: activeChallenge.objectiveType,
        }, 200, requestOrigin);
      }

      const snapshot = await getServerDailyGpSnapshot(supabase, {
        challengeId: challenge.id,
        playerId: playerId ?? null,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      return jsonResponse(snapshot, 200, requestOrigin);
    }

    if (pathname === '/api/scoreboard/submit' || pathname.endsWith('/api/scoreboard/submit')) {
      const { trackKey, playerId, leaderboardIdentity, bestTime, replay, checkpointTimesSec } = await req.json().catch(() => ({}));
      const challenge = await getServerDailyGpChallenge();
      if (trackKey !== challenge.trackKey) {
        return jsonResponse({
          accepted: false,
          error: 'Track is not the active Mini Racer challenge.',
        }, 404, requestOrigin);
      }

      const result = await submitServerDailyGpRun(supabase, {
        playerId,
        challengeId: challenge.id,
        leaderboardIdentity,
        bestTime,
        replay,
        checkpointTimesSec,
        trackKey,
      });
      return jsonResponse(result.body, result.status, requestOrigin);
    }

    if (pathname === '/api/daily/active' || pathname.endsWith('/api/daily/active')) {
      const challenge = await getServerDailyGpChallenge();
      return jsonResponse(challenge, 200, requestOrigin);
    }

    if (pathname === '/api/daily/playlist' || pathname.endsWith('/api/daily/playlist')) {
      return jsonResponse(buildDailyGpPlaylist(), 200, requestOrigin);
    }

    if (pathname === '/api/daily/snapshot' || pathname.endsWith('/api/daily/snapshot')) {
      const { challengeId, playerId, limit } = Object.fromEntries(url.searchParams.entries());
      const snapshot = await getServerDailyGpSnapshot(supabase, {
        challengeId: challengeId ?? null,
        playerId: playerId ?? null,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      return jsonResponse(snapshot, 200, requestOrigin);
    }

    if (pathname === '/api/daily/submit' || pathname.endsWith('/api/daily/submit')) {
      const { playerId, challengeId, leaderboardIdentity, bestTime, replay, checkpointTimesSec, trackKey } = await req.json().catch(() => ({}));
      const result = await submitServerDailyGpRun(supabase, {
        playerId,
        challengeId,
        leaderboardIdentity,
        bestTime,
        replay,
        checkpointTimesSec,
        trackKey,
      });
      return jsonResponse(result.body, result.status, requestOrigin);
    }

    return jsonResponse({ error: 'Route not found' }, 404, requestOrigin);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Supabase API handler failed:', message);
    return jsonResponse({ error: message }, 500, requestOrigin);
  }
});
