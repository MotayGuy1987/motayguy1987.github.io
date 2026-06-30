import supabase from './db-client.js';

const WF_BASE = 'https://api.watchfooty.st';
const SP_BASE = 'https://streamed.pk';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchWithMeta(url, opts = {}) {
  const { headers = {}, timeout = 10000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', ...headers },
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      size: body.length,
      body: body.slice(0, 3000),
      elapsed: Date.now() - start,
      headers: Object.fromEntries(res.headers.entries()),
      truncated: body.length > 3000,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), elapsed: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Build our own URL for proxy testing
  const host = req.headers.host || 'localhost';
  const proto = headers['x-forwarded-proto'] || 'https';
  const selfUrl = `${proto}://${host}`;

  const results: Record<string, any> = {};

  try {
    // ── LAYER 1: WatchFooty API ──────────────────────────────
    const wfStart = Date.now();
    const wfRes = await fetch(`${WF_BASE}/api/v1/matches/live`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const wfData = await wfRes.json();
    results.wfApi = {
      status: wfRes.status,
      count: Array.isArray(wfData) ? wfData.length : 0,
      elapsedMs: Date.now() - wfStart,
      sampleMatches: (Array.isArray(wfData) ? wfData : []).slice(0, 3).map((m: any) => ({
        title: m.title,
        sport: m.sport,
        league: m.league,
        streamCount: (m.streams || []).length,
        firstStreamUrl: (m.streams || [{}])[0]?.url || '(none)',
        hasStreams: (m.streams || []).length > 0,
      })),
    };

    // Pick one live match WITH streams for deeper testing
    const testMatch = (Array.isArray(wfData) ? wfData : []).find((m: any) => (m.streams || []).length > 0);

    if (testMatch) {
      const streamUrl = testMatch.streams[0].url;

      // ── LAYER 2: Direct fetch of WF embed URL ───────────
      const direct = await fetchWithMeta(streamUrl, {
        headers: { Referer: 'https://watchfooty.su/' },
        timeout: 12000,
      });
      results.wfEmbedDirect = {
        url: streamUrl,
        status: direct.status,
        size: direct.size,
        elapsedMs: direct.elapsedMs,
        body: direct.body,
        hasIframe: /<iframe[^>]*src=/i.test(direct.body),
        hasAdScript: /aclib|runPop|zoneId|wfty/i.test(direct.body),
        hasVideoPlayer: /jwplayer|videojs|clappr|<video/i.test(direct.body),
        nestedIframeSrc: ((direct.body.match(/<iframe[^>]*src="([^"]+)"/i) || [null, null])[1]),
        frameBlockingHeaders: [
          direct.headers?.['x-frame-options'],
          direct.headers?.['content-security-policy'],
          direct.headers?.['content-security-policy-report-only'],
        ].filter(Boolean),
        is500Error: direct.status === 500,
        errorBody: direct.size < 100 ? direct.body.trim() : null,
      };

      // ── LAYER 3: Fetch nested iframe target ──────────────
      const nestedUrl = results.wfEmbedDirect.nestedIframeSrc;
      if (nestedUrl && nestedUrl.startsWith('http')) {
        const nested = await fetchWithMeta(nestedUrl, {
          headers: { Referer: new URL(streamUrl).origin },
          timeout: 15000,
        });
        results.nestedEmbed = {
          url: nestedUrl,
          status: nested.status,
          size: nested.size,
          elapsedMs: nested.elapsedMs,
          body: nested.body,
          hasM3U8: /\.m3u8/.test(nested.body),
          hasJWPlayer: /jwplayer/i.test(nested.body),
          hasVideoJS: /videojs/i.test(nested.body),
          hasClappr: /clappr/i.test(nested.body),
          hasFileConfig: /\bfile\s*:|\bsources\s*:/i.test(nested.body),
          hasPopupScripts: /window\.open|popunder|popup/i.test(nested.body),
          frameBlockingHeaders: [
            nested.headers?.['x-frame-options'],
            nested.headers?.['content-security-policy'],
            nested.headers?.['content-security-policy-report-only'],
          ].filter(Boolean),
          m3u8Urls: (nested.body.match(/https?:\/\/[^\s"']*\.m3u8[^\s"']*/g) || []).slice(0, 5),
        };
      }

      // ── LAYER 4: Our proxy (wf-embed) ────────────────────
      const proxyUrl = `${selfUrl}/api/wf-embed?url=${encodeURIComponent(streamUrl)}`;
      const proxied = await fetchWithMeta(proxyUrl, { timeout: 20000 });
      results.ourProxy = {
        url: '/api/wf-embed?url=...',
        status: proxied.status,
        size: proxied.size,
        elapsedMs: proxied.elapsedMs,
        body: proxied.body,
        adStripped: /removed/i.test(proxied.body),
        videoIframePreserved: /<iframe[^>]*src=/i.test(proxied.body),
        isProxyError: /"error"/i.test(proxied.body),
        shieldInjected: /AansShield/i.test(proxied.body),
        baseTagInjected: /<base href=/i.test(proxied.body),
      };

      // ── LAYER 4b: Test what happens when we load the PROXIED page's nested iframe through our proxy too ──
      if (results.nestedEmbed?.url) {
        const nestedProxyUrl = `${selfUrl}/api/wf-embed?url=${encodeURIComponent(results.nestedEmbed.url)}`;
        const nestedProxied = await fetchWithMeta(nestedProxyUrl, { timeout: 15000 });
        results.nestedProxy = {
          url: '/api/wf-embed?url=(nested)',
          status: nestedProxied.status,
          size: nestedProxied.size,
          elapsedMs: nestedProxied.elapsedMs,
          hasContent: nestedProxied.size > 500,
          shieldInjected: /AansShield/i.test(nestedProxied.body),
        };
      }
    } else {
      results.wfApiNote = 'No live WF match with streams found for deep testing';
    }
  } catch (e: any) {
    results.wfApiError = e.message;
  }

  // ── LAYER 5: Streamed.pk API ─────────────────────────────
  try {
    const spStart = Date.now();
    const spRes = await fetch(`${SP_BASE}/api/matches/live`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const spData = await spRes.json();
    results.spApi = {
      status: spRes.status,
      count: Array.isArray(spData) ? spData.length : 0,
      elapsedMs: Date.now() - spStart,
      sampleMatches: (Array.isArray(spData) ? spData : []).slice(0, 3).map((m: any) => ({
        title: m.title,
        category: m.category,
        popular: m.popular,
        sourceCount: (m.sources || []).length,
        sources: (m.sources || []).slice(0, 2),
      })),
    };

    const spTestMatch = (Array.isArray(spData) ? spData : []).find((m: any) => (m.sources || []).length > 0);
    if (spTestMatch && spTestMatch.sources[0]) {
      const src = spTestMatch.sources[0];
      const streamResolveUrl = `${SP_BASE}/api/stream/${src.source}/${src.id}`;
      const resolved = await fetchWithMeta(streamResolveUrl, { timeout: 10000 });
      results.spStreamResolve = {
        source: src.source,
        id: src.id,
        resolveUrl: streamResolveUrl,
        status: resolved.status,
        size: resolved.size,
        elapsedMs: resolved.elapsedMs,
        body: resolved.body,
        streamCount: (() => { try { return JSON.parse(resolved.body || '[]').length; } catch { return 0; } })(),
        sampleStreams: (() => {
          try {
            const parsed = JSON.parse(resolved.body || '[]');
            return (Array.isArray(parsed) ? parsed : []).slice(0, 2).map((s: any) => ({
              embedUrl: s.embedUrl,
              hd: s.hd,
              language: s.language,
              viewers: s.viewers,
            }));
          } catch { return []; }
        })(),
      };

      if (results.spStreamResolve.sampleStreams[0]) {
        const embedStUrl = results.spStreamResolve.sampleStreams[0].embedUrl;
        if (embedStUrl) {
          const embedSt = await fetchWithMeta(embedStUrl, { timeout: 12000 });
          results.embedStDirect = {
            url: embedStUrl,
            status: embedSt.status,
            size: embedSt.size,
            elapsedMs: embedSt.elapsedMs,
            hasContent: (embedSt.body || '').length > 500,
            frameBlockingHeaders: [
              embedSt.headers?.['x-frame-options'],
              embedSt.headers?.['content-security-policy'],
            ].filter(Boolean),
            hasPopupScripts: /window\.open|popunder|popup/i.test(embedSt.body || ''),
            hasVideoPlayer: /jwplayer|videojs|clappr|<video/i.test(embedSt.body || ''),
          };
        }
      }
    }
  } catch (e: any) {
    results.spApiError = e.message;
  }

  // ── Verdict ──────────────────────────────────────────────
  results.verdict = {
    wfApiOk: !!(results.wfApi && results.wfApi.count > 0),
    wfEmbedOk: !!(results.wfEmbedDirect && results.wfEmbedDirect.ok && results.wfEmbedDirect.size > 500),
    wfEmbedIs500: !!results.wfEmbedDirect?.is500Error,
    wfNestedOk: !!(results.nestedEmbed && results.nestedEmbed.ok && results.nestedEmbed.size > 1000),
    wfProxyOk: !!(results.ourProxy && results.ourProxy.ok && results.ourProxy.size > 500 && results.ourProxy.videoIframePreserved),
    wfShieldActive: !!(results.ourProxy && results.ourProxy.shieldInjected),
    spApiOk: !!(results.spApi && results.spApi.count > 0),
    spStreamOk: !!(results.spStreamResolve && results.spStreamResolve.ok),
    embedStOk: !!(results.embedStDirect && results.embedStDirect.ok && results.embedStDirect.hasContent),
    timestamp: new Date().toISOString(),
  };

  return res.status(200).json(results);
}
