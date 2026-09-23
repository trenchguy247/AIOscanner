// Shared local-server logic for both `node server.js` and the bundled .exe.
// Serves the scanner page, proxies the OTC Desks feed, picks a free port,
// and opens the browser automatically.
const http = require("http");
const { spawn } = require("child_process");
const { proxyOtc } = require("./_otc-core");

function openBrowser(url) {
  try {
    const p = process.platform;
    const cmd = p === "win32" ? ["cmd", ["/c", "start", "", url]]
      : p === "darwin" ? ["open", [url]]
      : ["xdg-open", [url]];
    const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});   // no browser handler: the printed URL is the fallback
    child.unref();
  } catch {}
}

function createServer(getHtml) {
  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
    catch { res.writeHead(400); return res.end("bad request"); }

    if (url.pathname === "/api/otc") {
      try {
        const out = await proxyOtc(url.searchParams.get("path"));
        res.writeHead(out.status, {
          "content-type": out.contentType || "application/json; charset=utf-8",
          "cache-control": out.maxAge ? `public, max-age=${out.maxAge}` : "no-store"
        });
        return res.end(out.body);
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end('{"error":"proxy failed"}');
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = await getHtml();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(html);
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("could not load index.html: " + e.message);
      }
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

// Tries `port`, then the next few, so a busy port doesn't kill the launch.
function listenWithFallback(server, port, attemptsLeft, cb) {
  const onError = (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      server.removeListener("error", onError);
      listenWithFallback(server, port + 1, attemptsLeft - 1, cb);
    } else {
      cb(err);
    }
  };
  server.once("error", onError);
  server.listen(port, "127.0.0.1", () => {
    server.removeListener("error", onError);
    cb(null, port);
  });
}

function start({ getHtml, port = Number(process.env.PORT) || 8787, open = true, keepOpen = false } = {}) {
  const server = createServer(getHtml);
  listenWithFallback(server, port, 20, (err, actual) => {
    if (err) {
      console.error("\n  Could not start the local server: " + err.message + "\n");
      if (keepOpen) holdWindow();
      process.exitCode = 1;
      return;
    }
    const url = `http://localhost:${actual}`;
    console.log("");
    console.log("   OTC//SCAN is running");
    console.log("   " + url);
    console.log("");
    console.log("   Leave this window open while you use the scanner.");
    console.log("   Close it (or press Ctrl+C) to stop.");
    console.log("");
    if (open) openBrowser(url);
  });
  return server;
}

// Keeps a double-clicked console window from vanishing before the error is read.
function holdWindow() {
  try {
    console.error("  Press Enter to close this window.");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(1));
  } catch { process.exit(1); }
}

module.exports = { start, createServer, openBrowser, holdWindow };
