import supabase from './db-client.js';

const WF_BASE = 'https://api.watchfooty.st';
const SP_BASE = 'https://streamed.pk';

// In-memory cache (30s TTL)
let cache = { data: null, ts: 0, key: null };
const CACHE_TTL = 30000;
const VERSION = '3';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ============================================================
// NORMALIZATION
// ============================================================

function safeStr(v) {
  if (v == null || typeof v !== 'string') return '';
  return v.trim();
}

function normalizeTeam(name) {
  const s = safeStr(name);
  if (!s) return '';
  return s.toLowerCase()
    .replace(/\b(fc|cf|sc|afc|ac|club|team|national)\b/g, '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || '';
}

function matchKey(home, away) {
  const h = normalizeTeam(home);
  const a = normalizeTeam(away);
  if (!h || !a) return null;
  // Sort alphabetically so home/away order doesn't matter
  return h < a ? `${h}|${a}` : `${a}|${h}`;
}

function isLive(ts, wfStatus) {
  const now = Date.now();
  const diff = ts - now;
  if (wfStatus === 'in' || wfStatus === 'live') {
    if (diff < -5 * 3600 * 1000) return false; // stale >5h old "live"
    return true;
  }
  if (wfStatus === 'pre' || wfStatus === 'post' || wfStatus === 'ft' || wfStatus === 'finished') return false;
  return diff < 0 && diff > -4 * 3600 * 1000;
}

// ============================================================
// LEAGUE PRESTIGE DATABASE
// ============================================================

const LEAGUE_PRESTIGE = [
  { pattern: /fifa world cup|football world cup/i, score: 120 },
  { pattern: /uefa champions league|champions league/i, score: 110 },
  { pattern: /uefa euro\b|european championship/i, score: 105 },
  { pattern: /copa america\b/i, score: 100 },
  { pattern: /super bowl|nfl playoff/i, score: 100 },
  { pattern: /nba final|world series|mlb playoff/i, score: 98 },
  { pattern: /copa libertadores/i, score: 95 },
  { pattern: /stanley cup final|nhl playoff/i, score: 90 },
  { pattern: /ufc \d+|ufc fight night/i, score: 90 },
  { pattern: /^premier league|^epl/i, score: 85 },
  { pattern: /\bla liga\b/i, score: 82 },
  { pattern: /^serie a(?!.*u20)/i, score: 80 },
  { pattern: /^bundesliga(?!.*2)/i, score: 80 },
  { pattern: /^ligue 1(?!.*2)/i, score: 75 },
  { pattern: /europa league|conference league/i, score: 72 },
  { pattern: /^nfl$/i, score: 85 },
  { pattern: /^nba(?!.*g.?league)/i, score: 78 },
  { pattern: /^nhl$/i, score: 75 },
  { pattern: /^mlb$|major league baseball/i, score: 70 },
  { pattern: /formula 1|f1 grand prix/i, score: 80 },
  { pattern: /atp.*(finals|masters)|wta.*(finals|masters)/i, score: 70 },
  { pattern: /wnba/i, score: 50 },
  { pattern: /ncaa|college/i, score: 50 },
  { pattern: /pga|european tour/i, score: 55 },
  { pattern: /world championship|world.?cup/i, score: 40 },
];

const POPULAR_TEAMS = [
  'real madrid', 'barcelona', 'atletico', 'manchester united', 'man city',
  'liverpool', 'chelsea', 'arsenal', 'tottenham', 'bayern munich',
  'psg', 'juventus', 'inter milan', 'ac milan', 'napoli',
  'benfica', 'porto', 'ajax', 'celtic', 'rangers',
  'flamengo', 'palmeiras', 'boca juniors', 'river plate',
  'lakers', 'celtics', 'warriors', 'bulls', 'heat', 'nets', 'knicks',
  'yankees', 'red sox', 'dodgers', 'astros', 'braves',
  'cowboys', 'chiefs', 'eagles', '49ers', 'bills', 'packers',
  'mcgregor', 'ngannou', 'fury', 'joshua', 'canelo',
  'hamilton', 'verstappen', 'leclerc',
  'djokovic', 'alcaraz', 'sinner', 'medvedev', 'nadal',
  'swiatek', 'gauff', 'sabalenka',
];

function computeFeaturedScore(match) {
  let score = 0;
  const league = safeStr(match.league);
  const title = safeStr(match.title);
  const combined = `${league} ${title} ${(match.homeTeam?.name || '')} ${(match.awayTeam?.name || '')}`.toLowerCase();

  for (const { pattern, score: ls } of LEAGUE_PRESTIGE) {
    if (pattern.test(league) || pattern.test(title)) { score = Math.max(score, ls); break; }
  }
  for (const team of POPULAR_TEAMS) {
    if (combined.includes(team)) { score = Math.max(score, 55); break; }
  }
  if (match.popular) score = Math.max(score, 45);

  const totalStreams = (match.watchfooty?.streams?.length || 0) + (match.streamed?.sources?.length || 0);
  if (totalStreams >= 10) score += 12;
  else if (totalStreams >= 5) score += 6;
  else if (totalStreams >= 2) score += 2;

  if (match.live) score += 10;
  return score;
}

// ============================================================
// TRANSFORMERS
// ============================================================

function transformWF(m) {
  if (!m || typeof m !== 'object') return null;
  const teams = m.teams;
  if (!teams || typeof teams !== 'object') return null;

  const homeObj = teams.home;
  const awayObj = teams.away;
  const homeName = (homeObj && typeof homeObj === 'object') ? safeStr(homeObj.name) : '';
  const awayName = (awayObj && typeof awayObj === 'object') ? safeStr(awayObj.name) : '';
  if (!homeName && !awayName) return null;

  return {
    title: safeStr(m.title) || `${homeName} vs ${awayName}`,
    sport: safeStr(m.sport) || 'other',
    league: safeStr(m.league) || '',
    date: m.timestamp || (m.date ? new Date(m.date).getTime() : Date.now()),
    homeTeam: homeName,
    awayTeam: awayName,
    homeLogo: (homeObj && typeof homeObj === 'object' && homeObj.logoUrl) ? `${WF_BASE}${homeObj.logoUrl}` : '',
    awayLogo: (awayObj && typeof awayObj === 'object' && awayObj.logoUrl) ? `${WF_BASE}${awayObj.logoUrl}` : '',
    homeScore: m.scores?.home ?? null,
    awayScore: m.scores?.away ?? null,
    minute: safeStr(m.currentMinute),
    status: safeStr(m.status),
    poster: m.poster ? `${WF_BASE}${m.poster}` : '',
    leagueLogo: m.leagueLogo ? `${WF_BASE}${m.leagueLogo}` : '',
    wfId: safeStr(m.matchId),
    wfStreams: (Array.isArray(m.streams) ? m.streams : []).map(s => ({
      id: safeStr(s.id),
      url: safeStr(s.url),
      quality: safeStr(s.quality),
      language: safeStr(s.language),
      ads: !!s.ads,
      isRedirect: !!s.isRedirect,
      nsfw: !!s.nsfw,
    })),
  };
}

function transformSP(m) {
  if (!m || typeof m !== 'object') return null;
  const teams = m.teams;
  if (!teams || typeof teams !== 'object') return null;

  const homeObj = teams.home;
  const awayObj = teams.away;
  const homeName = (homeObj && typeof homeObj === 'object') ? safeStr(homeObj.name) : '';
  const awayName = (awayObj && typeof awayObj === 'object') ? safeStr(awayObj.name) : '';
  if (!homeName && !awayName) return null;

  const title = safeStr(m.title) || (homeName && awayName ? `${homeName} vs ${awayName}` : '');
  if (!title) return null;

  const homeBadge = (homeObj && typeof homeObj === 'object') ? homeObj.badge : null;
  const awayBadge = (awayObj && typeof awayObj === 'object') ? awayObj.badge : null;

  return {
    title,
    sport: safeStr(m.category) || 'other',
    league: '',
    date: m.date || Date.now(),
    homeTeam: homeName,
    awayTeam: awayName,
    homeLogo: homeBadge ? `${SP_BASE}/api/images/proxy/${safeStr(homeBadge)}.webp` : '',
    awayLogo: awayBadge ? `${SP_BASE}/api/images/proxy/${safeStr(awayBadge)}.webp` : '',
    poster: m.poster ? `${SP_BASE}${m.poster}` : '',
    spId: safeStr(m.id),
    spSources: (Array.isArray(m.sources) ? m.sources : []).map(s => ({
      source: safeStr(s.source),
      id: safeStr(s.id),
    })),
    popular: !!m.popular,
  };
}

// ============================================================
// FETCH
// ============================================================

async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    return await res.json();
  } catch (e) {
    console.error(`[matches] Fetch failed for ${url}:`, e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function dedupeById(list, idField) {
  const seen = new Set();
  return list.filter(m => {
    const id = m[idField];
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ============================================================
// MERGE
// ============================================================

function mergeMatches(wfList, spList) {
  const merged = new Map();

  // Pass 1: Add all WatchFooty matches
  for (const wf of wfList) {
    const t = transformWF(wf);
    if (!t) continue;
    const key = matchKey(t.homeTeam, t.awayTeam);
    const uid = key || `wf-${t.wfId}`;
    merged.set(uid, {
      uid,
      title: t.title,
      sport: t.sport,
      league: t.league,
      date: t.date,
      homeTeam: { name: t.homeTeam, logo: t.homeLogo },
      awayTeam: { name: t.awayTeam, logo: t.awayLogo },
      homeScore: t.homeScore,
      awayScore: t.awayScore,
      minute: t.minute,
      poster: t.poster,
      leagueLogo: t.leagueLogo,
      popular: false,
      live: isLive(t.date, t.status),
      watchfooty: { matchId: t.wfId, streams: t.wfStreams },
      streamed: null,
    });
  }

  // Pass 2: Merge Streamed.pk data into existing or add as new
  for (const sp of spList) {
    const t = transformSP(sp);
    if (!t) continue;
    const key = matchKey(t.homeName, t.awayName);

    if (key && merged.has(key)) {
      // MERGE: attach SP sources to existing WF match
      const existing = merged.get(key);
      existing.streamed = { matchId: t.spId, sources: t.spSources };
      if (t.popular) existing.popular = true;
      if (!existing.homeTeam.logo && t.homeLogo) existing.homeTeam.logo = t.homeLogo;
      if (!existing.awayTeam.logo && t.awayLogo) existing.awayTeam.logo = t.awayLogo;
      if (!existing.poster && t.poster) existing.poster = t.poster;
    } else if (key) {
      // NEW: SP-only match (no WF equivalent)
      merged.set(key, {
        uid: key,
        title: t.title,
        sport: t.sport,
        league: t.league,
        date: t.date,
        homeTeam: { name: t.homeName, logo: t.homeLogo },
        awayTeam: { name: t.awayName, logo: t.awayLogo },
        homeScore: null,
        awayScore: null,
        minute: '',
        poster: t.poster,
        leagueLogo: '',
        popular: t.popular,
        live: isLive(t.date, ''),
        watchfooty: null,
        streamed: { matchId: t.spId, sources: t.spSources },
      });
    }
  }

  // Compute featured scores & sort
  const scored = Array.from(merged.values()).map(m => ({
    ...m,
    featuredScore: computeFeaturedScore(m),
  }));

  return scored.sort((a, b) => {
    if (a.live && !b.live) return -1;
    if (!a.live && b.live) return 1;
    if (b.featuredScore !== a.featuredScore) return b.featuredScore - a.featuredScore;
    return a.date - b.date;
  });
}

// ============================================================
// HANDLER — Smart fetching strategy
//
// Strategy:
//   • No params (initial load):  live + popular from both APIs (~100KB total, <2s)
//   ?live=true:               live endpoints only (fastest)
//   ?sport=football:          sport-specific + live fallback
//   ?tab=all or explicit:     full /all endpoints with extended timeout
// ============================================================

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const sport = req.query.sport && req.query.sport !== 'all' ? req.query.sport : null;
    const liveOnly = req.query.live === 'true';
    const matchUid = req.query.id;
    const forceAll = req.query.all === 'true';

    const cacheKey = `${sport || 'all'}-${liveOnly ? 'live' : 'all'}${forceAll ? '-full' : ''}-v${VERSION}`;

    // Return cached response if fresh
    if (cache.data && cache.key === cacheKey && Date.now() - cache.ts < CACHE_TTL) {
      let result = cache.data;
      if (matchUid) result = result.find(m => m.uid === matchUid) || null;
      return res.status(200).json(matchUid ? (result || { error: 'Match not found' }) : result);
    }

    console.log(`[matches] Cache miss → fresh fetch. key=${cacheKey}`);

    let wfList = [];
    let spList = [];

    if (matchUid) {
      // Single match lookup — try direct API calls first
      const [wfMatch, spMatch] = await Promise.all([
        fetchWithTimeout(`${WF_BASE}/api/v1/match/${matchUid}`, 12000),
        fetchWithTimeout(`${SP_BASE}/api/matches/all`, 15000),
      ]);
      wfList = Array.isArray(wfMatch) ? wfMatch : (wfMatch ? [wfMatch] : []);
      spList = Array.isArray(spMatch) ? spMatch : [];
    } else if (forceAll || sport) {
      // Explicit "all" request or sport filter — use extended timeout for large payloads
      const timeout = forceAll ? 20000 : 15000;

      if (sport) {
        // Sport-specific: fetch that sport + live as supplement
        const [wfSport, spSport, wfLive, spLive] = await Promise.all([
          fetchWithTimeout(`${WF_BASE}/api/v1/matches/${sport}`, timeout),
          fetchWithTimeout(`${SP_BASE}/api/matches/${sport}`, timeout),
          fetchWithTimeout(`${WF_BASE}/api/v1/matches/live`, timeout),
          fetchWithTimeout(`${SP_BASE}/api/matches/live`, timeout),
        ]);
        wfList = [
          ...(Array.isArray(wfSport) ? wfSport : []),
          ...(Array.isArray(wfLive) ? wfLive : []),
        ];
        spList = [
          ...(Array.isArray(spSport) ? spSport : []),
          ...(Array.isArray(spLive) ? spLive : []),
        ];
      } else {
        // Force all: fetch everything with long timeout
        const [wfAll, spAll, wfLive, spLive] = await Promise.all([
          fetchWithTimeout(`${WF_BASE}/api/v1/matches/all`, timeout),
          fetchWithTimeout(`${SP_BASE}/api/matches/all`, timeout),
          fetchWithTimeout(`${WF_BASE}/api/v1/matches/live`, timeout),
          fetchWithTimeout(`${SP_BASE}/api/matches/live`, timeout),
        ]);
        wfList = [
          ...(Array.isArray(wfAll) ? wfAll : []),
          ...(Array.isArray(wfLive) ? wfLive : []),
        ];
        spList = [
          ...(Array.isArray(spAll) ? spAll : []),
          ...(Array.isArray(spLive) ? spLive : []),
        ];
      }
    } else {
      // DEFAULT: fast initial load — live + popular only (small payloads, <2s response)
      const [wfLive, spLive, wfPop, spPop] = await Promise.all([
        fetchWithTimeout(`${WF_BASE}/api/v1/matches/live`, 10000),
        fetchWithTimeout(`${SP_BASE}/api/matches/live`, 10000),
        fetchWithTimeout(`${WF_BASE}/api/v1/matches/popular`, 10000),
        fetchWithTimeout(`${SP_BASE}/api/matches/popular`, 10000),
      ]);

      wfList = [
        ...(Array.isArray(wfLive) ? wfLive : []),
        ...(Array.isArray(wfPop) ? wfPop : []),
      ];
      spList = [
        ...(Array.isArray(spLive) ? spLive : []),
        ...(Array.isArray(spPop) ? spPop : []),
      ];
    }

    // Deduplicate by matchId/spId within each source
    wfList = dedupeById(wfList, 'matchId');
    spList = dedupeById(spList, 'id');

    console.log(`[matches] Fetched: WF=${wfList.length}, SP=${spList.length}`);

    // Merge both datasets
    let merged = mergeMatches(wfList, spList);

    console.log(`[matches] Merged: ${merged.length}`);

    // Update cache
    cache = { data: merged, ts: Date.now(), key: cacheKey };

    if (matchUid) {
      const match = merged.find(m => m.uid === matchUid);
      return res.status(200).json(match || { error: 'Match not found' });
    }

    return res.status(200).json(merged);
  } catch (err) {
    console.error('[matches] API error:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
