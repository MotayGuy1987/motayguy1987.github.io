import supabase from './db-client.js';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Cache stream details per source/id (60s TTL)
const streamCache = new Map();
const CACHE_TTL = 60000;

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { source, id } = req.query;
    if (!source || !id) {
      return res.status(400).json({ error: 'Missing source or id' });
    }

    const cacheKey = `${source}/${id}`;
    const cached = streamCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return res.status(200).json(cached.data);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const apiRes = await fetch(`https://streamed.pk/api/stream/${source}/${id}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const data = await apiRes.json();

      // Normalize the stream data
      const streams = (Array.isArray(data) ? data : []).map(s => ({
        id: s.id,
        streamNo: s.streamNo,
        language: s.language || 'Unknown',
        hd: s.hd || false,
        embedUrl: s.embedUrl,
        source: s.source,
        viewers: s.viewers || 0,
      }));

      streamCache.set(cacheKey, { data: streams, ts: Date.now() });
      return res.status(200).json(streams);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error('Streamed streams API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
