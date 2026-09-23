// Entry point for the standalone executable (built with `bun build --compile`).
// The page is embedded as text, so the .exe needs no other files next to it
// and no Node installation on the machine.
import html from "../index.html" with { type: "text" };
import { start, holdWindow } from "../api/_server-core.js";

start({
  getHtml: () => html,
  open: !process.argv.includes("--no-open"),
  keepOpen: true
});

process.on("uncaughtException", (e) => {
  console.error("\n  Unexpected error: " + e.message + "\n");
  holdWindow();
});

// Without this, a compiled binary whose only work is an idle server can exit
// as soon as the top-level module finishes on some platforms.
setInterval(() => {}, 1 << 30);
