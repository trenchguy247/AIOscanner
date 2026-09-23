// Shared proxy logic used by api/otc.js (Vercel) and server.js (local).
// It forwards ONLY read-only endpoints on an explicit allowlist, so the proxy
// can never be used to fetch arbitrary URLs.

const ALLOW = [
  // OTC Desks launcher feed
  { host: "otcdesks.cash", paths: ["/api/coins"], params: { page: /^\d{1,5}$/, size: /^\d{1,3}$/, mint: /^[1-9A-HJ-NP-Za-km-z]{32,48}$/ }, ttl: 15_000 },
  // OTC Desks logo
  { host: "otcdesks.cash", paths: ["/otc-icon.svg"], params: {}, ttl: 86_400_000, binary: true },
  // StonkFun public API (documented: /developers)
  { host: "www.stonkfun.xyz", pathPrefix: "/api/public/v1/", params: {
      page: /^\d{1,5}$/, pageSize: /^\d{1,3}$/, sort: /^(marketCap|newest|volume)$/,
      mode: /^(standard|reward)$/, status: /^(new|aboutToGraduate|graduated)$/,
      category: /^[\w-]{1,40}$/, quoteMint: /^[1-9A-HJ-NP-Za-km-z]{32,48}$/,
      limit: /^\d{1,3}$/, q: /^[\w .$-]{0,40}$/, since: /^[\d:.TZ-]{1,30}$/, creator: /^[1-9A-HJ-NP-Za-km-z]{32,48}$/
    }, ttl: 15_000 },
  // StonkFun logo
  { host: "www.stonkfun.xyz", paths: ["/stonk-mark.svg"], params: {}, ttl: 86_400_000, binary: true },
  // Jupiter price feed (quote-token USD prices)
  { host: "lite-api.jup.ag", paths: ["/price/v3"], params: { ids: /^[1-9A-HJ-NP-Za-km-z,]{32,4000}$/ }, ttl: 60_000 },
  // DexScreener price fallback
  { host: "api.dexscreener.com", pathPrefix: "/latest/dex/tokens/", params: {}, ttl: 60_000 }
];

const cache = new Map();

function matchRule(u) {
  return ALLOW.find((r) => {
    if (r.host !== u.hostname) return false;
    if (r.paths) return r.paths.includes(u.pathname);
    if (r.pathPrefix) return u.pathname.startsWith(r.pathPrefix) && !u.pathname.includes("..");
    return false;
  });
}

// Accepts a full URL (new style) or a bare /api/coins path (old OTC-only style).
function buildUpstreamUrl(raw) {
  if (typeof raw !== "string" || raw.length > 4500) return null;
  const override = process.env.OTC_UPSTREAM;
  let u;
  try {
    u = raw.startsWith("http") ? new URL(raw) : new URL(raw, override || "https://otcdesks.cash");
  } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  // Test/dev override: point every allowlisted host at a local stand-in.
  if (override) {
    const rule = matchRule(u) || matchRule(new URL(u.pathname + u.search, "https://otcdesks.cash"));
    if (!rule) return null;
    const dest = new URL(override);
    const out = new URL(u.pathname + u.search, `${dest.protocol}//${dest.host}`);
    out.searchParams.set("__host", u.hostname);
    return { url: out.toString(), ttl: rule.ttl, binary: !!rule.binary };
  }

  const rule = matchRule(u);
  if (!rule) return null;
  const out = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    const re = rule.params[k];
    if (!re || !re.test(v)) return null;
    out.set(k, v);
  }
  const qs = out.toString();
  return { url: `https://${u.hostname}${u.pathname}${qs ? "?" + qs : ""}`, ttl: rule.ttl, binary: !!rule.binary };
}

async function proxyOtc(raw) {
  const target = buildUpstreamUrl(raw);
  if (!target) return { status: 400, body: JSON.stringify({ error: "path not allowed" }), maxAge: 0 };

  const hit = cache.get(target.url);
  if (hit && Date.now() - hit.t < target.ttl) return { ...hit, maxAge: Math.round(target.ttl / 1000) };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(target.url, {
      signal: ctrl.signal,
      headers: { accept: target.binary ? "image/svg+xml,image/*" : "application/json", "user-agent": "otc-scan/2.0 (+read-only launch scanner)" }
    });
    const isBin = target.binary;
    const body = isBin ? Buffer.from(await r.arrayBuffer()) : await r.text();
    const result = { t: Date.now(), status: r.status, body, contentType: r.headers.get("content-type") || (isBin ? "image/svg+xml" : "application/json") };
    if (r.ok) {
      cache.set(target.url, result);
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
    }
    return { ...result, maxAge: r.ok ? Math.round(target.ttl / 1000) : 0 };
  } catch {
    return { status: 502, body: JSON.stringify({ error: "upstream unreachable" }), maxAge: 0 };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { proxyOtc, buildUpstreamUrl };
