// Vercel serverless function: GET /api/otc?path=/api/coins?page=1&size=60
// Lets the scanner read the OTC Desks launcher feed when the browser blocks
// direct cross-site requests.
const { proxyOtc } = require("./_otc-core");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    return res.end();
  }
  const path = new URL(req.url, "http://x").searchParams.get("path");
  const out = await proxyOtc(path);
  res.statusCode = out.status;
  res.setHeader("content-type", out.contentType || "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", out.maxAge ? `public, s-maxage=${out.maxAge}, max-age=${Math.min(out.maxAge, 10)}` : "no-store");
  res.end(out.body);
};
