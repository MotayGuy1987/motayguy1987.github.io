function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// In-memory cache for cleaned embed pages (60s TTL)
const pageCache = new Map();
const CACHE_TTL = 60000;

async function fetchWithTimeout(url, ms = 10000, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    if (referer) headers['Referer'] = referer;
    const res = await fetch(url, { signal: controller.signal, headers });
    return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

// The anti-ad shield — injected BEFORE any page scripts run.
// Blocks popups, redirect ads, and ad script loading without breaking the video player.
const AD_SHIELD = `
<script>
(function() {
  'use strict';
  // Block window.open (popup ads)
  window.open = function() { console.log('[AansShield] Blocked window.open'); return null; };
  // Block top-level navigation attempts (redirect ads) — but allow same-origin hash changes
  var origAssign = window.location.assign.bind(window.location);
  var origReplace = window.location.replace.bind(window.location);
  window.location.assign = function(url) {
    try {
      var u = new URL(url, window.location.href);
      if (u.origin === window.location.origin) return origAssign(url);
    } catch(e) {}
    console.log('[AansShield] Blocked location.assign: ' + url);
  };
  window.location.replace = function(url) {
    try {
      var u = new URL(url, window.location.href);
      if (u.origin === window.location.origin) return origReplace(url);
    } catch(e) {}
    console.log('[AansShield] Blocked location.replace: ' + url);
  };
  // Block document.write of ad content
  var origWrite = document.write.bind(document);
  document.write = function(content) {
    if (content && typeof content === 'string' && /<script|<iframe|popunder|ads?\\.\\//i.test(content)) {
      console.log('[AansShield] Blocked document.write ad');
      return;
    }
    return origWrite(content);
  };
  // Intercept and block ad-related script loads
  var origCreateElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = origCreateElement(tag);
    if (tag && tag.toLowerCase() === 'script') {
      var origSrc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
      Object.defineProperty(el, 'src', {
        configurable: true,
        get: function() { return origSrc.get.call(this); },
        set: function(val) {
          var v = (val || '').toLowerCase();
          if (v.includes('aclib') || v.includes('runpop') || v.includes('popunder') ||
              v.includes('adcash') || v.includes('propeller') || v.includes('network-1') ||
              v.includes('wfty.shop') || v.includes('adserver') || v.includes('/d3.php') ||
              v.includes('wpnxis') || v.includes('vbcojh') || (v.includes('zone') && v.includes('id'))) {
            console.log('[AansShield] Blocked ad script: ' + val);
            return;
          }
          origSrc.set.call(this, val);
        }
      });
    }
    return el;
  };
  // Block eval of ad code
  var origEval = window.eval;
  window.eval = function(code) {
    if (code && typeof code === 'string' && /popunder|runPop|zoneId/i.test(code)) {
      console.log('[AansShield] Blocked eval ad');
      return;
    }
    return origEval.call(window, code);
  };
  // Block beforeunload (prevents "are you sure you want to leave" ad traps)
  window.addEventListener = (function(orig) {
    return function(type, listener, options) {
      if (type === 'beforeunload' || type === 'unload') {
        console.log('[AansShield] Blocked ' + type + ' listener');
        return;
      }
      return orig.call(window, type, listener, options);
    };
  })(window.addEventListener);
  console.log('[AansShield] Active — ads blocked');
})();
</script>`;

function cleanPage(html, originalUrl) {
  let cleaned = html;
  const origin = new URL(originalUrl).origin;

  // 1. Inject <base> tag so relative resources (CSS, JS, images) resolve to the original domain
  const baseTag = `<base href="${origin}/">`;

  // 2. Remove known ad script blocks from sportsembed.su
  cleaned = cleaned.replace(
    /<script[^>]*data-zone[^>]*src="[^"]*network[^"]*"[^>]*><\/script>/gi,
    '<!-- ad-network-removed -->'
  );
  cleaned = cleaned.replace(
    /<script[^>]*id="aclib"[^>]*>[\s\S]*?<\/script>/gi,
    '<!-- aclib-removed -->'
  );
  cleaned = cleaned.replace(
    /aclib\.runPop\([^)]*\)/gi,
    '/* aclib.runPop removed */'
  );
  cleaned = cleaned.replace(
    /<script[^>]*src="[^"]*wfty\.shop[^"]*"[^>]*><\/script>/gi,
    '<!-- analytics-removed -->'
  );

  // 3. Inject the AD_SHIELD + base tag right after <head>
  if (cleaned.includes('<head>')) {
    cleaned = cleaned.replace('<head>', `<head>${baseTag}${AD_SHIELD}`);
  } else if (cleaned.includes('<head ')) {
    cleaned = cleaned.replace(/<head ([^>]*)>/, `<head $1>${baseTag}${AD_SHIELD}`);
  } else if (cleaned.includes('<html')) {
    cleaned = cleaned.replace(/<html([^>]*)>/, `<html$1><head>${baseTag}${AD_SHIELD}</head>`);
  }

  // 4. Check if the page has any actual video content
  const hasVideo = /<iframe[^>]*src=/i.test(cleaned) ||
                    /<video/i.test(cleaned) ||
                    /jwplayer|videojs|clappr|hls\.js|videojs/i.test(cleaned) ||
                    /\.m3u8/i.test(cleaned);

  if (!hasVideo) {
    cleaned = '<!-- no-video-available -->' + cleaned;
  }

  return cleaned;
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: 'Missing url param' });
  }

  // Check cache
  const cached = pageCache.get(streamUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.status(200).send(cached.html);
  }

  try {
    // Determine referer based on the source domain
    let referer = 'https://watchfooty.su/';
    if (streamUrl.includes('embed.st')) {
      referer = 'https://streamed.pk/';
    } else if (streamUrl.includes('embedindia.st')) {
      referer = 'https://sportsembed.su/';
    }

    const result = await fetchWithTimeout(streamUrl, 10000, referer);

    if (!result.ok) {
      return res.status(result.status).json({ error: `Upstream returned ${result.status}` });
    }

    // Clean the HTML — inject base tag + ad shield, strip known ad scripts
    const cleaned = cleanPage(result.text, result.finalUrl || streamUrl);

    // Cache it
    pageCache.set(streamUrl, { html: cleaned, ts: Date.now() });

    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.status(200).send(cleaned);
  } catch (err) {
    console.error('Embed proxy error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
