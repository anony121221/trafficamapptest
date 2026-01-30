/**
 * Cloudflare Worker: CORS + HLS-friendly proxy
 *
 * Endpoint:
 *   GET/HEAD  /proxy?url=https://example.com/path
 *   OPTIONS   /proxy  (CORS preflight)
 *
 * Notes:
 * - Add camera/API hostnames to ALLOWED_HOSTS.
 * - Set ALLOW_ANY_ORIGIN=false and fill ALLOWED_ORIGINS for tighter security.
 */

const ALLOWED_HOSTS = [
  // Camera JSON feeds throwing CORS in browsers:
  "oktraffic.org",
  "stream.oktraffic.org",
  "traveler.modot.org",
  "sd.cdn.iteris-atis.com",
  "www.nvroads.com",
  "www.udottraffic.utah.gov",
  "api.algotraffic.com",

  // Your other providers:
  "ctroads.org",
  "cttravelsmart.org",
  "trafficland.com",
  "images.trafficland.com",

  // DFW Auth + API
  "dotstream.us.auth0.com",
  "511dfw.org",
];

const ALLOWED_ORIGINS = [
  // Put your GitHub Pages origin(s) here when you know them:
  // "https://YOURNAME.github.io",
];

const ALLOW_ANY_ORIGIN = true;   // set false to lock it down
const CACHE_TTL_SECONDS = 10;    // small TTL is good for cameras

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/proxy") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(request) });
    }

    const target = url.searchParams.get("url");
    if (!target) return new Response("Missing ?url=", { status: 400, headers: corsHeaders(request) });

    let targetUrl;
    try { targetUrl = new URL(target); }
    catch { return new Response("Bad url", { status: 400, headers: corsHeaders(request) }); }

    if (!["https:", "http:"].includes(targetUrl.protocol)) {
      return new Response("Only http/https allowed", { status: 400, headers: corsHeaders(request) });
    }

    if (isBlockedHostname(targetUrl.hostname)) {
      return new Response("Target host blocked", { status: 403, headers: corsHeaders(request) });
    }

    if (!isAllowedHost(targetUrl.hostname)) {
      return new Response("Target host not allowed", { status: 403, headers: corsHeaders(request) });
    }

    // Forward safe headers (Range helps HLS/video)
    const upstreamHeaders = new Headers();
    const range = request.headers.get("Range");
    if (range) upstreamHeaders.set("Range", range);
    const accept = request.headers.get("Accept");
    if (accept) upstreamHeaders.set("Accept", accept);
    const contentType = request.headers.get("Content-Type");
    if (contentType) upstreamHeaders.set("Content-Type", contentType);
    const auth = request.headers.get("Authorization");
    if (auth) upstreamHeaders.set("Authorization", auth);
    if (!upstreamHeaders.get("User-Agent")) {
      upstreamHeaders.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
      );
    }
    if (!upstreamHeaders.get("Referer")) {
      upstreamHeaders.set("Referer", `${targetUrl.origin}/`);
    }
    if (!upstreamHeaders.get("Origin")) {
      upstreamHeaders.set("Origin", targetUrl.origin);
    }

    // Cache key
    const isCacheable = CACHE_TTL_SECONDS > 0 && (request.method === "GET" || request.method === "HEAD");
    const cacheKey = new Request(new URL(`/__cache__/${encodeURIComponent(targetUrl.toString())}`, url.origin), {
      method: request.method,
      headers: upstreamHeaders
    });

    if (isCacheable) {
      const cached = await caches.default.match(cacheKey);
      if (cached) return withCors(cached, request);
    }

    const upstreamResp = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "follow",
      cf: isCacheable ? { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true } : undefined,
    });

    const contentType = (upstreamResp.headers.get("content-type") || "").toLowerCase();
    const looksLikeM3U8 =
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegurl") ||
      targetUrl.pathname.toLowerCase().endsWith(".m3u8");

    const raw = url.searchParams.get("raw") === "1";

    let resp;
    if (!raw && looksLikeM3U8) {
      const text = await upstreamResp.text();
      const rewritten = rewriteM3U8(text, targetUrl, url.origin);
      resp = new Response(rewritten, { status: upstreamResp.status, headers: upstreamResp.headers });
      resp.headers.set("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
    } else {
      resp = new Response(upstreamResp.body, upstreamResp);
    }

    // Remove some headers we don't want to forward
    resp.headers.delete("set-cookie");
    resp.headers.delete("access-control-allow-origin");
    resp.headers.delete("access-control-allow-credentials");

    resp = withCors(resp, request);

    if (isCacheable && upstreamResp.ok) {
      ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
    }

    return resp;
  },
};

function isAllowedHost(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => {
    const a = allowed.toLowerCase();
    return h === a || h.endsWith("." + a);
  });
}

function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;

  // block literal IPv4 private ranges
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split(".").map((x) => parseInt(x, 10));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  // block some IPv6 local
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd")) return true;

  return false;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  let allowOrigin = "*";

  if (!ALLOW_ANY_ORIGIN) {
    allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "null";
  } else {
    allowOrigin = origin || "*";
  }

  return new Headers({
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Range,Authorization",
    "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  });
}

function withCors(response, request) {
  const h = new Headers(response.headers);
  const cors = corsHeaders(request);
  for (const [k, v] of cors) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}

function rewriteM3U8(m3u8Text, baseUrl, workerOrigin) {
  const lines = m3u8Text.split(/\r?\n/);
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    let resolved;
    try { resolved = new URL(trimmed, baseUrl).toString(); }
    catch { return line; }

    return `${workerOrigin}/proxy?url=${encodeURIComponent(resolved)}`;
  }).join("\n");
}
