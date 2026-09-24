# Brilliant Analyst Model — 24/7 Price History Poller

This is a small, free, server-side job that builds **real** forex and
Moroccan-stock price history continuously — every 15 minutes, forever —
completely independent of whether anyone has the web app open in a browser.
It runs on GitHub's own servers (GitHub Actions), not yours, so there's
nothing to host or keep running.

## How it works

1. A GitHub Actions workflow (`.github/workflows/poll-prices.yml`) wakes up
   every 15 minutes.
2. It runs `poll.js`, which fetches the current live forex rate for every
   configured pair, and the current live Moroccan stock quotes.
3. Each fetched price is appended (with a timestamp) to a JSON file per
   symbol under `data/forex/` or `data/moroccan/`.
4. The workflow commits the updated files back to this repo.
5. The web app reads these files directly from
   `https://raw.githubusercontent.com/<you>/<repo>/main/data/...` and merges
   them with whatever it has separately accumulated in the browser.

Net effect: real history keeps growing 24/7, whether or not the app is ever
opened — exactly the "true 24/7 collection independent of the browser" you
asked for.

## Setup (10 minutes, one time)

1. **Create a new GitHub repository.** It can be public or private — public
   is simpler because the app can read the JSON files directly with no
   authentication. (The data files only ever contain prices and timestamps —
   nothing sensitive — so a public repo is fine.) If you use a private repo
   instead, you'll need to adjust the app to fetch with a GitHub token, which
   is more setup; ask me if you want that version.

2. **Push these files** to the new repo, keeping the folder structure exactly
   as-is:
   - `poll.js`
   - `package.json`
   - `.github/workflows/poll-prices.yml`
   - `data/forex/.gitkeep`, `data/moroccan/.gitkeep` (empty placeholders so
     the folders exist in git — the poller will populate them)

   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

3. **Add your Parse.bot API key as a repo secret** (needed for the Moroccan
   stocks fetch — forex doesn't need a key):
   - Repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `PARSE_API_KEY`
   - Value: the same key already in the app (`pmx_c62591794d09d7bc9be32b72ddd0f391`)
     — or rotate it first if you'd rather not reuse it here.

4. **Trigger a first run manually** to check everything works: repo → Actions
   tab → "Poll Live Prices" → "Run workflow". After it finishes (~1-2 min),
   check the `data/forex/` and `data/moroccan/` folders — you should see
   JSON files like `EURUSD.json` with your first data point in each.

5. **Copy your raw data URL.** It will look like:
   ```
   https://raw.githubusercontent.com/<you>/<repo>/main/data
   ```

6. **Paste that URL into the web app.** Open `brilliantAnalystv3.html`,
   find:
   ```js
   const REMOTE_HISTORY_BASE_URL = null;
   ```
   and change it to:
   ```js
   const REMOTE_HISTORY_BASE_URL = 'https://raw.githubusercontent.com/<you>/<repo>/main/data';
   ```

7. **Re-save/redeploy the HTML file.** From then on, every forex pair and
   Moroccan stock will pull in this server-collected real history in
   addition to whatever's accumulated locally in the browser — so even a
   brand-new browser session benefits immediately from history GitHub has
   been quietly building in the background.

## Honest limitations

- **GitHub's schedule isn't millisecond-precise.** Scheduled workflows can
  run a few minutes late, and GitHub explicitly reserves the right to
  disable scheduled workflows on repositories with **no other activity for
  60 days** — if that happens, just re-enable it from the Actions tab (or
  push any small commit to reset the clock). This won't affect an actively
  used repo.
- **Rate limits.** `open.er-api.com` is a free public API; if you hit rate
  limits, space out the cron schedule (e.g. `*/30 * * * *` for every 30
  minutes instead of 15) — this only slows down warm-up, it doesn't break
  anything.
- **This poller collects; it doesn't predict.** All the technical-indicator
  math still runs client-side in the app, on whatever real history is
  available at the time — this just makes sure that real history keeps
  accumulating even when nobody's watching.

## Files in this folder

```
poll.js                              — the poller script (no dependencies)
package.json                         — Node metadata (engines: node >=18)
.github/workflows/poll-prices.yml    — the schedule that runs poll.js
data/forex/                          — per-pair JSON history (auto-populated)
data/moroccan/                       — per-stock JSON history (auto-populated)
```
