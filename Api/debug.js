import supabase from './db-client.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const results = {};

    // Test 1: Direct fetch of streamed.pk
    try {
      const r = await fetch('https://streamed.pk/api/matches/all', {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await r.json();
      results.sp_direct = { ok: r.ok, status: r.status, isArray: Array.isArray(data), length: data?.length };
      if (data?.length > 0) {
        results.sp_sample = { title: data[0].title, sources: data[0].sources, teams_home: data[0]?.teams?.home?.name };
      }
    } catch (e) {
      results.sp_direct = { error: e.message, stack: e.stack?.slice(0, 300) };
    }

    // Test 2: Fetch watchfooty
    try {
      const r = await fetch('https://api.watchfooty.st/api/v1/matches/all', {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await r.json();
      results.wf_direct = { ok: r.ok, status: r.status, isArray: Array.isArray(data), length: data?.length };
      if (data?.length > 0) {
        results.wf_sample = { title: data[0].title, teams_home: data[0]?.teams?.home?.name };
      }
    } catch (e) {
      results.wf_direct = { error: e.message, stack: e.stack?.slice(0, 300) };
    }

    // Test 3: matchKey logic
    function normalizeTeam(name) {
      if (!name) return '';
      return name.toLowerCase()
        .replace(/\b(fc|cf|sc|afc|ac|club|team|national)\b/g, '')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function matchKey(home, away) {
      const h = normalizeTeam(home);
      const a = normalizeTeam(away);
      if (!h || !a) return null;
      return [h, a].sort().join('|');
    }
    results.key_test = {
      wf_key: matchKey('St. Louis Cardinals', 'San Diego Padres'),
      sp_key: matchKey('St. Louis Cardinals', 'San Diego Padres'),
      keys_match: matchKey('St. Louis Cardinals', 'San Diego Padres') === matchKey('St. Louis Cardinals', 'San Diego Padres')
    };

    // Test 4: Fetch both and count potential merges
    let wfList, spList;
    try {
      const [wfRes, spRes] = await Promise.all([
        fetch('https://api.watchfooty.st/api/v1/matches/all', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json()),
        fetch('https://streamed.pk/api/matches/all', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json()),
      ]);
      wfList = Array.isArray(wfRes) ? wfRes : [];
      spList = Array.isArray(spRes) ? spRes : [];
      
      results.fetch_both = { wf_count: wfList.length, sp_count: spList.length };

      // Count overlaps
      const wfKeys = new Set();
      for (const m of wfList) {
        const h = ((m.teams||{}).home||{}).name || '';
        const a = ((m.teams||{}).away||{}).name || '';
        const k = matchKey(h, a);
        if (k) wfKeys.add(k);
      }
      let overlaps = 0;
      for (const m of spList) {
        const h = ((m.teams||{}).home||{}).name || '';
        const a = ((m.teams||{}).away||{}).name || '';
        const t = m.title || '';
        let k = null;
        if (h && a) k = matchKey(h, a);
        else if (t.includes(' vs ')) {
          const parts = t.split(' vs ');
          k = matchKey(parts[0], parts[1]);
        }
        if (k && wfKeys.has(k)) overlaps++;
      }
      results.overlaps = overlaps;

      // Show first 3 overlapping matches
      let shown = 0;
      for (const m of spList) {
        if (shown >= 3) break;
        const h = ((m.teams||{}).home||{}).name || '';
        const a = ((m.teams||{}).away||{}).name || '';
        const t = m.title || '';
        let k = null;
        if (h && a) k = matchKey(h, a);
        else if (t.includes(' vs ')) {
          const parts = t.split(' vs ');
          k = matchKey(parts[0], parts[1]);
        }
        if (k && wfKeys.has(k)) {
          if (!results.sample_overlaps) results.sample_overlaps = [];
          results.sample_overlaps.push({ title: t, key: k, sources: m.sources });
          shown++;
        }
      }

    } catch (e) {
      results.fetch_both_error = e.message;
    }

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
}
