# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A single-page scanner for two Solana memecoin launchpads. It walks each one's
"newest launches" feed, filters on market data, then fetches each survivor's
reward record and lists the contract addresses that clear your thresholds.

Everything the user sees is **`index.html`** — one file, no build step, no
framework, no dependencies. The Node files exist only to serve it and to proxy
API calls past CORS. Treat `index.html` as the product.

## Commands

```bash
npm start              # serve on :8787 and open a browser
npm run serve          # serve without opening a browser

# tests (two terminals)
npm run mock           # terminal 1 — fake launchpads on :9913
npm run test:serve     # terminal 2 — app on :8802 pointed at the mock
npm test               # terminal 3 — drives the real UI with Playwright

npm run build:exe:win  # standalone Windows .exe (needs bun)
npm run build:exe      # same for the host platform
```

`npm test` needs `playwright` installed and its Chromium available.

## Architecture

| File | Role |
|---|---|
| `index.html` | The entire app: themes, adapters, filters, presets, scan engine, rendering |
| `api/_otc-core.js` | Proxy with a strict host/path/param allowlist. **The only place network destinations are declared.** |
| `api/_server-core.js` | Local HTTP server, port fallback, browser launching |
| `api/otc.js` | Vercel serverless wrapper around `_otc-core` |
| `server.js` | Local wrapper around `_server-core`, reads `index.html` from disk |
| `build/exe-entry.js` | Bun compile entry; **inlines `index.html` into the binary** |
| `test/mock.js` | Fake launchpads mirroring the real response shapes |
| `test/scan_test.py` | Playwright end-to-end assertions |

### The adapter pattern

`PADS` in `index.html` is the extensibility point. Each launchpad supplies
`listUrl` / `parseList` / `detailUrl` / `parseDetail` / `pickNative` / `links`
plus theme and copy. The scan engine is generic and should stay that way — if
you find yourself writing `if (pad.id === "otc")` inside `scan()`, add a flag or
a hook to the adapter instead.

Existing flags, both load-bearing:

- `rawUnits` — `true` when reward figures are raw integers needing division by
  the token's decimals; `false` when they're already token amounts.
- `feedHasRealTime` — `false` when the list endpoint's timestamps are not real
  launch times, which changes where the age window is applied.
- `detail2Url` / `parseDetail2` — optional second detail fetch, merged over the
  first. Non-empty values win.

## API contracts (verified live 2026-09-19)

Do not change these mappings without re-checking against a live response.

### OTC Desks — `otcdesks.cash`, undocumented

`GET /api/coins?page=&size=` — list, newest first, max 60/page, `total` is the
all-time count. **The list has no `rewards` object.**

`GET /api/coins?mint=` — same shape, one coin, *with* `rewards`.

```
snapshot: { marketCap, usdPrice, change24h, volume24h, liquidity, holders, at }
rewards:  { earned, owed, toProtocol, toPot, toBuyback, lastClaimTx, lastClaimAt }
rewardMint / rewardSymbol   what holders are PAID IN
pairMint  / pairSymbol      present only on stock-paired coins
```

Fee split per their docs: 67.5% holders · 10% desk pot · 5% OTC holders ·
5% protocol · 10% buybacks · 2.5% rent.

### StonkFun — `www.stonkfun.xyz`, documented at `/developers`

300 req/min per IP. Every response is wrapped: `{ data: {...}, meta: {...} }`.

```
GET /api/public/v1/tokens?sort=newest&page=&pageSize=   -> data.tokens[], data.pagination
GET /api/public/v1/tokens/{mint}                        -> data.token, data.launch
GET /api/public/v1/tokens/{mint}/rewards                -> data.rewards, data.quote
GET /api/public/v1/launches                             -> data.launches[], real timestamps
GET /api/public/v1/pairs                                -> data.pairs[], every quote token StonkFun allows
```

`market: { priceUsd, marketCapUsd, fdvUsd, volume24hUsd, liquidityUsd, peakMarketCapUsd }`
`rewards: { distributedRaw, distributedTokens, undistributedRaw, undistributedTokens, payoutCount, holderCount }`

`distributedTokens` is already a token amount. `distributedRaw` is the raw string.

`pairs[]` entries: `{ mint, symbol, name, category, categoryLabel, symbolAmbiguous, ... }`.
~530 pairs live across 9 categories (xstock, backpack, custom, prestock, currency,
tessera, leverage, solana, collectible). **Some symbols map to more than one
mint** (`symbolAmbiguous: true`, e.g. two different "WBTC" tokens) — always
filter and store by `mint`, never by `symbol`. This endpoint needs no proxy
allowlist change: it falls under the existing `www.stonkfun.xyz` `pathPrefix`
rule in `api/_otc-core.js` and takes no query params the scanner uses.

### Prices

Jupiter `https://lite-api.jup.ag/price/v3?ids=<comma-separated>` returns
`{ usdPrice, decimals, liquidity, blockId, priceChange24h }` per mint. **The
`decimals` field is the reason this endpoint is used** — the scanner needs it to
scale raw fee integers. DEX Screener is the per-mint fallback and does not
reliably carry decimals; `decimalsFor()` guesses 6 for `…pump` mints, else 9.

## Landmines

These already caused bugs. Each cost real debugging time.

**OTC rewards are not always SOL.** A coin paired against a stock earns *that
stock*, not SOL — their docs say so explicitly, and ~20% of the live feed is
stock-paired. xStock tokens use 8 decimals and cost hundreds of dollars.
Assuming SOL/1e9 understated those coins by a median of 38× and silently
dropped ones that should have matched. Always scale by `pairMint`'s decimals
when `pairMint` is present, and price against that mint.

**The fee token and the payout token are different things.** `pairSymbol` is
what fees accrue in; `rewardSymbol` is what holders receive. A coin can pair
against DOGE and pay out in CATE. Don't label one with the other.

**OTC has no `rewards.distributed` key.** An earlier filter option pointed at
it and therefore guaranteed zero hits. The real keys are listed above.

**StonkFun's `holderCount` counts paid holders, not token holders.** The
`/rewards` endpoint's `holderCount` only reflects wallets that have received at
least one distribution — it reads `0` for any reward coin before its first
payout cycle, even if the token already has real holders on-chain (confirmed
live: a coin with 4 on-chain holders and `payoutCount: 0` showed
`holderCount: 0`; established coins with millions of payouts show holder
counts in the thousands, moving in lockstep with `payoutCount`). StonkFun's
public API exposes no other holder figure — the site's own "top holders" list
comes from a different, undocumented data source. The UI labels this column
"Paid holders" on the StonkFun tab for this reason; don't relabel it back to
"Holders" or treat a `0` here as "no one holds this coin."

**StonkFun's token feed timestamps are fake.** Every row in
`/api/public/v1/tokens` carries the *same* `createdAt` — a cache-generation
time. The real launch time is `data.launch.createdAt` from
`/api/public/v1/tokens/{mint}`, or any entry in `/api/public/v1/launches`. This
is why that tab does a second detail fetch and applies the age window after it.

**Both APIs serve cached snapshots.** OTC's `snapshot.at` runs up to ~40 minutes
behind. The sites display the same cached figures, so the scanner matching them
is correct behaviour — but never describe these numbers as live.

**HTML5 `step` validation can silently block the scan.** `min="0.25"` with
`step="1"` made the default `24` invalid, so submitting the filter form did
nothing, with no console error. The form now carries `novalidate` and steps are
consistent with their mins. If "Apply & scan" ever appears to do nothing, check
constraint validation first.

**The `.exe` embeds `index.html` at compile time.** Editing the page does not
change an already-built binary. Re-run `npm run build:exe:win` or you will test
a stale copy.

**`Start OTC Scanner.cmd` needs CRLF line endings.** Writing it from a Unix
shell heredoc corrupts it. Verify with `file` before shipping.

**Filter values of `0` mean "off".** `ZEROABLE` lists which keys follow that
rule. `lookbackH`, `maxCoins` and `concurrency` are scan *scope* and keep real
defaults. A new filter that is not in `ZEROABLE` will not be disable-able.

**"Unpaid" means a different field per launchpad.** The `unpaidOnly` filter
keeps coins that have never had a payout, but that's `lastClaimAt` (OTC — a
single claim timestamp, 0/absent if the creator has never claimed) vs.
`payouts`/`payoutCount` (StonkFun — a distribution-round counter). Both are
detail-fetch fields, so — like `minHolders` on Stonk and `minPayouts` — the
filter is applied after `getDetail()`, not in `passMarket()`.

**The pair filter (`pairMints`) is array-typed, unlike every other filter.**
`FIELDS` has one entry with `type: "multi"` — `readForm`/`writeForm`/`markActive`
all special-case `el.multiple` before the normal numeric/string branches, and
`DEFAULTS.pairMints` is `[]` rather than `0`/`"off"`. It stores selected quote
**mints**, not symbols (see the ambiguous-symbol note above). Filtering happens
in `passMarket()`, not post-detail, because `priceMint` is already on the list
response for Stonk — this also means a selected pair the feed never sends
correctly produces zero hits rather than being silently ignored.

The pair list itself is lazy-loaded once per page load into module-level
`pairsCache` (`ensurePairsLoaded()`, called at the end of every
`renderFilterForm()`, no-ops instantly once cached or on the OTC pad). Until
it resolves, the `<select>` shows a disabled "Loading pairs…" option;
`ensurePairsLoaded()` re-populates it and re-applies whatever was saved for
that filter once the fetch lands, rather than trusting whatever the (empty)
select happened to read via `writeForm()` before the options existed.

## Network

The proxy allowlist in `api/_otc-core.js` is a security boundary: host, path
and every query param are validated against regexes. Adding an endpoint means
adding a rule there, not loosening the matcher.

`OTC_UPSTREAM` redirects every allowlisted host to one local stand-in and
forwards the original host as `__host`. Dev and test only — never set it in
production.

The page tries the proxy before a direct connection whenever it is served over
http(s), and only falls back to direct on `file://`. That ordering exists to
keep a CORS error out of the console; don't reverse it.

## Testing

`test/mock.js` deliberately reproduces the real APIs' quirks — the identical
StonkFun timestamps, the missing `rewards` on OTC's list endpoint, stock-paired
coins with 8-decimal fee tokens. **If you change the mock to be "cleaner", the
tests stop proving anything.** When you learn something new about a real API,
encode it in the mock first.

`test/scan_test.py` asserts exact mint sets computed independently in Python,
not just hit counts. Keep it that way — a count can match by coincidence.

To verify a compiled binary rather than the source page, build it, run it with
`OTC_UPSTREAM` set, and point `SCAN_URL` at its port.

## Conventions

- No dependencies in `index.html`. No frameworks, no bundler, no CDN scripts.
  Google Fonts is the only external resource.
- Theme values come from CSS custom properties keyed off `body[data-pad]`.
  Switching tabs must never require a reload.
- Comments explain *why*, especially where the code works around one of the
  landmines above. Those comments are load-bearing — don't strip them as noise.
- The log pane is the user's window into what happened. A coin excluded for a
  surprising reason should say so there; a scan returning nothing should explain
  itself rather than printing "0 hits".
- This tool reads public data and never holds keys, signs transactions, or
  touches a wallet. Keep it that way.
