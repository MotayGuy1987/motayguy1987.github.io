import supabase from './db-client.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const results = {};
  
  // Test 1: Direct WF fetch
  try {
    const r1 = await fetch('https://api.watchfooty.st/api/v1/matches/live', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const d1 = await r1.json();
    results.wf_live = { status: r1.status, count: Array.isArray(d1) ? d1.length : 'not-array' };
  } catch (e) {
    results.wf_live = { error: e.message };
  }

  // Test 2: Direct SP fetch
  try {
    const r2 = await fetch('https://streamed.pk/api/matches/live', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const d2 = await r2.json();
    results.sp_live = { status: r2.status, count: Array.isArray(d2) ? d2.length : 'not-array', type: typeof d2 };
  } catch (e) {
    results.sp_live = { error: e.message };
  }

  // Test 3: SP all matches
  try {
    const r3 = await fetch('https://streamed.pk/api/matches/all', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    const text3 = await r3.text();
    results.sp_all = { status: r3.status, bodyLength: text3.length, first200: text3.slice(0, 200) };
  } catch (e) {
    results.sp_all = { error: e.message };
  }

  // Test 4: SP with no UA header
  try {
    const r4 = await fetch('https://streamed.pk/api/matches/live', {
      signal: AbortSignal.timeout(8000),
    });
    const d4 = await r4.json();
    results.sp_no_ua = { status: r4.status, count: Array.isArray(d4) ? d4.length : 'not-array' };
  } catch (e) {
    results.sp_no_ua = { error: e.message };
  }

  // Test 5: Node fetch version info
  results.node_version = process.version;
  results.env_info = {
    region: process.env.VERCEL_REGION || 'unknown',
    platform: process.platform,
  };

  return res.status(200).json(results);
}
