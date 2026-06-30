import supabase from './db-client.js';

// Copy-paste the exact same functions from matches.js to diagnose

const WF_BASE = 'https://api.watchfooty.st';
const SP_BASE = 'https://streamed.pk';

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
  return h < a ? `${h}|${a}` : `${a}|${h}`;
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
    return { _error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Fetch raw data
  const [spAll, spLive] = await Promise.all([
    fetchWithTimeout(`${SP_BASE}/api/matches/all`),
    fetchWithTimeout(`${SP_BASE}/api/matches/live`),
  ]);

  const spRaw = [
    ...(Array.isArray(spAll) ? spAll : []),
    ...(Array.isArray(spLive) ? spLive : []),
  ];

  // Deduplicate
  const seen = new Set();
  const spList = spRaw.filter(m => {
    const id = m.id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Transform each and report
  const transformed = [];
  const failed = [];
  for (const sp of spList) {
    const t = transformSP(sp);
    if (t) {
      const key = matchKey(t.homeTeam, t.awayTeam);
      transformed.push({
        title: t.title,
        homeTeam: t.homeTeam,
        awayTeam: t.awayTeam,
        matchKey: key,
        spSourcesCount: t.spSources.length,
        spSources: t.spSources,
        popular: t.popular,
      });
    } else {
      failed.push({ id: sp.id, title: sp.title, teams: JSON.stringify(sp.teams)?.slice(0, 100) });
    }
  }

  // Show first few keys to see if they'd match WF keys
  const sampleKeys = transformed.slice(0, 8).map(t => ({
    title: t.title,
    key: t.matchKey,
    sources: t.spSourcesCount,
  }));

  return res.status(200).json({
    spRawCount: spRaw.length,
    spDedupedCount: spList.length,
    transformedCount: transformed.length,
    failedCount: failed.length,
    failedSamples: failed.slice(0, 5),
    sampleKeys,
    allTransformedTitles: transformed.map(t => t.title),
  });
}
