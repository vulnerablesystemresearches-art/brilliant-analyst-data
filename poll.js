#!/usr/bin/env node
/**
 * Brilliant Analyst Model — 24/7 real price history poller
 * ──────────────────────────────────────────────────────────
 * Runs on a schedule (see .github/workflows/poll-prices.yml), completely
 * independent of whether anyone has the web app open in a browser. Each run:
 *   1. Fetches the current live forex rate for every configured pair.
 *   2. Fetches the current live Moroccan stock quotes.
 *   3. Appends one real, timestamped data point per symbol to
 *      data/<assetClass>/<SYMBOL>.json in this repo.
 *   4. The workflow commits + pushes the updated data/ folder back to GitHub.
 *
 * The web app then reads these JSON files straight from
 * raw.githubusercontent.com (see REMOTE_HISTORY_BASE_URL in the app) and
 * merges them with whatever it has accumulated locally, so predictions are
 * backed by real history that keeps growing even while nobody has the app
 * open — exactly like crypto already gets from CoinGecko.
 *
 * No dependencies: uses Node's built-in fetch (Node 18+).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const MAX_POINTS_PER_SYMBOL = 2000; // ~3 weeks of history at a 15-min cadence

// Same pair list as the web app (fetchForex), so symbol names line up exactly.
const FOREX_PAIRS = [
    { from: 'USD', to: 'EUR', name: 'EUR/USD' },
    { from: 'USD', to: 'GBP', name: 'GBP/USD' },
    { from: 'USD', to: 'JPY', name: 'USD/JPY' },
    { from: 'USD', to: 'CHF', name: 'USD/CHF' },
    { from: 'USD', to: 'CAD', name: 'USD/CAD' },
    { from: 'USD', to: 'AUD', name: 'AUD/USD' },
    { from: 'USD', to: 'NZD', name: 'NZD/USD' },
    { from: 'USD', to: 'CNY', name: 'USD/CNY' },
    { from: 'EUR', to: 'GBP', name: 'EUR/GBP' },
    { from: 'EUR', to: 'JPY', name: 'EUR/JPY' },
    { from: 'EUR', to: 'CHF', name: 'EUR/CHF' },
    { from: 'EUR', to: 'AUD', name: 'EUR/AUD' },
    { from: 'EUR', to: 'CAD', name: 'EUR/CAD' },
    { from: 'GBP', to: 'JPY', name: 'GBP/JPY' },
    { from: 'GBP', to: 'CHF', name: 'GBP/CHF' },
    { from: 'GBP', to: 'AUD', name: 'GBP/AUD' },
    { from: 'AUD', to: 'JPY', name: 'AUD/JPY' },
    { from: 'USD', to: 'MAD', name: 'USD/MAD' },
    { from: 'EUR', to: 'MAD', name: 'EUR/MAD' },
    { from: 'USD', to: 'SEK', name: 'USD/SEK' },
    { from: 'USD', to: 'NOK', name: 'USD/NOK' },
    { from: 'USD', to: 'DKK', name: 'USD/DKK' },
    { from: 'USD', to: 'ZAR', name: 'USD/ZAR' },
    { from: 'USD', to: 'SGD', name: 'USD/SGD' },
    { from: 'USD', to: 'HKD', name: 'USD/HKD' },
    { from: 'USD', to: 'KRW', name: 'USD/KRW' },
    { from: 'USD', to: 'TRY', name: 'USD/TRY' },
    { from: 'USD', to: 'MXN', name: 'USD/MXN' },
    { from: 'USD', to: 'BRL', name: 'USD/BRL' },
    { from: 'USD', to: 'INR', name: 'USD/INR' },
    { from: 'USD', to: 'RUB', name: 'USD/RUB' },
    { from: 'USD', to: 'PLN', name: 'USD/PLN' }
];

// Same scraper endpoint as the web app (fetchMoroccanStocks).
const MOROCCAN_SCRAPER_URL =
    'https://api.parse.bot/scraper/79ba1cf9-d616-40e4-afde-7082f8c53d55/get_share_prices';
const PARSE_API_KEY = process.env.PARSE_API_KEY || '';

function safeFileName(symbol) {
    return symbol.replace(/[^A-Za-z0-9]/g, '');
}

function loadSeries(assetClass, symbol) {
    const file = path.join(DATA_DIR, assetClass, safeFileName(symbol) + '.json');
    if (!fs.existsSync(file)) return [];
    try {
        const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        console.warn(`[poller] could not parse ${file}, starting fresh:`, e.message);
        return [];
    }
}

function appendPoint(assetClass, symbol, price) {
    if (typeof price !== 'number' || !isFinite(price) || price <= 0) return;
    const dir = path.join(DATA_DIR, assetClass);
    fs.mkdirSync(dir, { recursive: true });

    const points = loadSeries(assetClass, symbol);
    points.push({ t: Date.now(), p: price });

    const trimmed = points.length > MAX_POINTS_PER_SYMBOL
        ? points.slice(points.length - MAX_POINTS_PER_SYMBOL)
        : points;

    const file = path.join(dir, safeFileName(symbol) + '.json');
    fs.writeFileSync(file, JSON.stringify(trimmed));
}

async function pollForex() {
    let ok = 0, failed = 0;
    for (const pair of FOREX_PAIRS) {
        try {
            const res = await fetch(`https://open.er-api.com/v6/latest/${pair.from}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const rate = data.rates && data.rates[pair.to];
            if (!rate) throw new Error('no rate for ' + pair.to + ' in response');
            appendPoint('forex', pair.name, rate);
            ok++;
        } catch (e) {
            console.warn(`[poller] forex fetch failed for ${pair.name}:`, e.message);
            failed++;
        }
        // be polite to the free API — small delay between calls
        await new Promise(r => setTimeout(r, 250));
    }
    console.log(`[poller] forex: ${ok} updated, ${failed} failed`);
}

async function pollMoroccan() {
    if (!PARSE_API_KEY) {
        console.warn('[poller] PARSE_API_KEY not set — skipping Moroccan stocks (add it as a repo secret).');
        return;
    }
    try {
        const res = await fetch(MOROCCAN_SCRAPER_URL, {
            headers: { 'X-API-Key': PARSE_API_KEY, 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const companies = (json && json.data && json.data.companies) || [];
        let ok = 0;
        for (const company of companies) {
            const price = company.closing_price || company.reference_price || 0;
            const ticker = company.ticker ||
                (company.company ? company.company.substring(0, 4).toUpperCase() : null);
            if (ticker && price) {
                appendPoint('moroccan', ticker, price);
                ok++;
            }
        }
        console.log(`[poller] moroccan: ${ok} updated`);
    } catch (e) {
        console.warn('[poller] Moroccan stocks poll failed:', e.message);
    }
}

(async () => {
    console.log('[poller] run started', new Date().toISOString());
    await pollForex();
    await pollMoroccan();
    console.log('[poller] run finished', new Date().toISOString());
})();
