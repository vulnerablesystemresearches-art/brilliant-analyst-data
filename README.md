# Brilliant Trade — 24/7 Price History + Prediction Track Record Poller

This is a small, free, server-side job that runs on GitHub's own servers —
not yours — completely independent of whether anyone has the web app open in
a browser. It now does **two** things:

1. **Price history** (original): builds real forex and Moroccan-stock price
   history continuously, every 15 minutes, forever.
2. **Prediction track record** (new): once a symbol has enough real history,
   runs the exact same 8-indicator algorithm the web app uses, logs the call,
   and — once its 4-hour horizon passes — checks it against the real price
   and records whether it was right. This is published as one shared
   `data/predictions/_summary.json`, so **every copy of the app anywhere
   reads the same track record** — a real global statistic, not something
   private to one browser.



## Version 2.2 change: crypto is now tracked too

The poller previously covered only forex and Moroccan stocks, so in global mode
the shared Track Record and the Trading Insights had no crypto at all. It now
also calls CoinGecko (the same top-30 request the app makes, one call per run),
predicts on the same real 7-day hourly series the app uses, and logs/resolves
crypto predictions exactly like the other markets under
`data/predictions/crypto/`. Nothing else needs configuring — no key, no new
secret. If CoinGecko rate-limits a run (it sometimes does for shared CI
addresses), the poller retries twice, then skips crypto for that run only;
it never writes placeholder data.

## Version 2.1 change: same engine as the app + indicator votes

The poller now uses the web app's indicator engine verbatim (earlier versions
used a simplified copy whose confidence scale and MACD differed from what the
cards show). Each logged prediction also stores a compact string of every
indicator's own lean (e.g. `UDNUUDN`), which powers the app's per-indicator
accuracy report.

**Recommended once, when you upgrade:** delete the old `data/predictions/`
folder contents in your repo (keep the folder). Predictions logged by the old
version used a different confidence scale, so mixing them with new ones would
blur the accuracy numbers. Price history under `data/forex` and
`data/moroccan` is unaffected — keep it.

## How it works

1. A GitHub Actions workflow (`.github/workflows/poll-prices.yml`) wakes up
   every 15 minutes.
2. `poll.js` fetches the current live forex rate for every configured pair
   and the current live Moroccan stock quotes.
3. Each fetched price is appended (with a timestamp) to
   `data/forex/<PAIR>.json` or `data/moroccan/<TICKER>.json`.
4. For any symbol with 30+ accumulated real points, it runs `TA.predict()`
   (ported verbatim from the web app) and logs a new prediction to
   `data/predictions/<assetClass>/<SYMBOL>.json` — but only if that symbol
   doesn't already have one still pending, so it doesn't spam a new call
   every 15 minutes.
5. Any of that symbol's earlier predictions whose 4-hour window has passed
   get resolved against the current fetched price: `correct`, `incorrect`,
   or `flat` (moved less than a noise threshold either way).
6. It rebuilds `data/predictions/_summary.json` — one aggregated file with
   global totals, per-market breakdown, confidence-bucket calibration, and
   a list of the most recent resolved calls (so the app can show exactly
   *which* calls were right and *which* were wrong, not just a percentage).
7. The workflow commits everything under `data/` (which includes
   `data/predictions/`) back to this repo.
8. The web app reads it all from
   `https://raw.githubusercontent.com/<you>/<repo>/main/data/...`.

**One config value does both jobs.** Because `data/predictions/` sits nested
inside `data/`, the same `REMOTE_HISTORY_BASE_URL` you already set in the app
automatically picks up the global prediction summary too — there's no second
URL to configure.

## If you already deployed the old version of this poller

You don't need to redo the whole setup — just replace one file:

1. Open your repo on GitHub, navigate to `poll.js` at the root, click the
   pencil/edit icon.
2. Select all, delete, and paste in the full contents of the new `poll.js`
   from this package.
3. Commit directly to `main`.
4. Go to the Actions tab → "Poll Live Prices" → **Run workflow** to trigger
   it once manually and confirm it works (see Verify below).
5. Nothing else changes — same workflow file, same `PARSE_API_KEY` secret,
   same `REMOTE_HISTORY_BASE_URL` in the app. The `data/predictions/` folder
   is created automatically on the first run.

## Setup from scratch (10 minutes, one time)

1. **Create a new GitHub repository.** Public is simplest (no auth needed to
   read the JSON files, which only ever contain prices/timestamps/predicted
   directions — nothing sensitive).

2. **Push these files**, keeping the structure exactly as-is:
   - `poll.js`
   - `package.json`
   - `.github/workflows/poll-prices.yml`
   - `data/forex/.gitkeep`, `data/moroccan/.gitkeep`

   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

3. **Add your Parse.bot API key as a repo secret** (forex needs no key):
   - Repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `PARSE_API_KEY`
   - Value: your Parse.bot key.

4. **Trigger a first run manually**: Actions tab → "Poll Live Prices" →
   **Run workflow**.

5. **Verify** (see below), then copy your raw data URL:
   ```
   https://raw.githubusercontent.com/<you>/<repo>/main/data
   ```
   and paste it into the app's:
   ```js
   const REMOTE_HISTORY_BASE_URL = 'https://raw.githubusercontent.com/<you>/<repo>/main/data';
   ```

## Verify it's working

- `data/forex/EURUSD.json` should contain entries like `{"t":..., "p":1.09}`.
- After enough runs accumulate 30+ points for a symbol, check
  `data/predictions/forex/EURUSD.json` — it should contain a prediction
  entry with `resolved: false`.
- After its `resolveAt` timestamp passes and the poller runs again, that
  entry flips to `resolved: true` with an `outcome`.
- `data/predictions/_summary.json` should show non-zero `total` once any
  predictions have resolved — this is the file the app actually reads for
  the global Track Record.

## Important: why forex may show mostly "flat" results

`open.er-api.com` (the free forex rate API this poller uses) only updates
its rates **once per day**, not continuously. Within a single 4-hour
resolution window, the rate the poller fetches is very likely the *exact
same daily snapshot* as when the prediction was made — so forex predictions
will tend to resolve as "flat" far more often than crypto, not because the
underlying algorithm is worse, but because the free data source barely moves
on this timescale. This is a data-source limitation, not a bug.

**If you want forex predictions to actually resolve meaningfully**, the fix
is a forex API with intraday updates. Options, roughly cheapest to most
capable:
- A free-tier intraday forex API (several exist with limited free calls/day
  — search "free real-time forex API" for current options, availability
  changes often).
- A paid tier of a forex data provider (Twelve Data, Alpha Vantage,
  ExchangeRate-API's paid tier, etc.) if this needs to be genuinely reliable.

Swapping the forex fetch URL in both `poll.js` and the web app's
`fetchForex()` to a different provider is a contained change — ask if you
want help wiring in a specific one.

## Honest limitations

- **GitHub's schedule isn't millisecond-precise** and can lag under load.
  GitHub also disables scheduled workflows on repos with no activity for
  60 days — just re-enable from the Actions tab if that happens; nothing is
  lost.
- **Rate limits.** If you hit them, space out the cron (e.g. `*/30 * * * *`)
  — this only slows accumulation, it doesn't break anything.
- **Resolution timing is approximate**, not to-the-second — a prediction
  resolves whenever the *next* poller run happens to be at or after its
  4-hour mark, which could be a few minutes to ~15 minutes late.
- **Sample size still matters.** A handful of resolved predictions can look
  good or bad by pure chance. The app's Track Record panel enforces this
  explicitly with a trust tier (not ready / early signal / statistically
  established at 30+ resolved) — don't treat small numbers as meaningful
  regardless of what this poller reports.

## Files in this folder

```
poll.js                                    — the poller (no dependencies)
package.json                               — Node metadata (engines: node >=18)
.github/workflows/poll-prices.yml          — the schedule that runs poll.js
data/forex/                                — per-pair price history (auto-populated)
data/moroccan/                             — per-stock price history (auto-populated)
data/predictions/<class>/<symbol>.json     — per-symbol prediction log (auto-populated)
data/predictions/_summary.json             — aggregated global track record the app reads
```
