#!/usr/bin/env node
/**
 * Brilliant Trade — 24/7 real price history + prediction track record poller
 * ────────────────────────────────────────────────────────────────────────
 * Runs on a schedule (see .github/workflows/poll-prices.yml), completely
 * independent of whether anyone has the web app open in a browser.
 *
 * Each run does TWO things now, not just one:
 *
 * 1. PRICE HISTORY (as before): fetches the current live price for every
 *    configured forex pair and Moroccan stock, appends it to
 *    data/<assetClass>/<SYMBOL>.json.
 *
 * 2. PREDICTIONS (new): once a symbol has enough real price history
 *    (30+ points), runs the exact same TA.predict() algorithm the web app
 *    uses, logs the call to data/predictions/<assetClass>/<SYMBOL>.json,
 *    and resolves any of that symbol's earlier pending calls whose 4-hour
 *    horizon has passed by checking them against the current real price.
 *    Finally it rebuilds data/predictions/_summary.json — one aggregated
 *    file with global totals, per-market breakdown, confidence calibration,
 *    and a list of recent resolved calls (so the web app can show exactly
 *    which ones were correct and which weren't).
 *
 * Because this runs on GitHub's servers and commits its results back to the
 * repo, every copy of the web app anywhere reads the SAME prediction
 * history and the SAME track record — a real shared/global dataset, not
 * something private to one browser. This file (data/predictions/*.json) is
 * the "light database" — plain JSON, git-versioned, diffable, no server or
 * database engine required.
 *
 * No dependencies: uses Node's built-in fetch (Node 18+).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PRED_DIR = path.join(DATA_DIR, 'predictions');
const MAX_POINTS_PER_SYMBOL = 2000; // price history cap (~3 weeks at 15-min cadence)
const MAX_PRED_PER_SYMBOL = 500; // prediction log cap per symbol
const MAX_RECENT_IN_SUMMARY = 300; // how many recent resolved calls the summary file lists individually
const MAX_INSIGHT_ENTRIES = 3000; // compact up/down results published for the app's Trading Insights

const PRED_RESOLUTION_MS = 4 * 60 * 60 * 1000; // evaluate at the 4h (max) horizon — same as the app
const PRED_FLAT_THRESHOLD_PCT = { crypto: 0.3, forex: 0.05, moroccan: 0.15 }; // same thresholds as the app
const PRED_MIN_HISTORY = 30; // same "enough real data" gate as TA.predict itself

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

// IMPORTANT, and worth knowing before reading the track record: open.er-api.com's
// free tier updates once per DAY, not continuously. That means within any single
// 4-hour resolution window, the "live" rate fetched here is very likely the exact
// same daily snapshot as when the prediction was made — so forex calls will tend
// to resolve "flat" far more often than crypto, not because the algorithm is
// worse, but because the underlying free data source barely changes on this
// timescale. See the poller README for options to fix this at the root.

// Same scraper endpoint as the web app (fetchMoroccanStocks).
const MOROCCAN_SCRAPER_URL =
    'https://api.parse.bot/scraper/79ba1cf9-d616-40e4-afde-7082f8c53d55/get_share_prices';
const PARSE_API_KEY = process.env.PARSE_API_KEY || '';

// ─── shared helpers ────────────────────────────────────────────────────

function safeFileName(symbol) {
    return symbol.replace(/[^A-Za-z0-9]/g, '');
}

function loadJson(file) {
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.warn(`[poller] could not parse ${file}, treating as empty:`, e.message);
        return null;
    }
}

function saveJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
}

// ─── price history (unchanged behavior from before) ───────────────────

function loadSeries(assetClass, symbol) {
    const arr = loadJson(path.join(DATA_DIR, assetClass, safeFileName(symbol) + '.json'));
    return Array.isArray(arr) ? arr : [];
}

function appendPricePoint(assetClass, symbol, price) {
    if (typeof price !== 'number' || !isFinite(price) || price <= 0) return loadSeries(assetClass, symbol);
    const points = loadSeries(assetClass, symbol);
    points.push({ t: Date.now(), p: price });
    const trimmed = points.length > MAX_POINTS_PER_SYMBOL
        ? points.slice(points.length - MAX_POINTS_PER_SYMBOL)
        : points;
    saveJson(path.join(DATA_DIR, assetClass, safeFileName(symbol) + '.json'), trimmed);
    return trimmed;
}

// ─── TA module — ported verbatim (no DOM/browser APIs) from the web app,
// so predictions computed here match predictions the app itself would
// compute from the same history. Keep this in sync with the app's copy.

// Indicator engine: copied verbatim from the web app so the shared, server-computed
// track record measures exactly the same predictions people see on the cards.
const TA = {
    sma(prices, period) {
        if (prices.length < period) return null;
        const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
    },

    ema(prices, period) {
        if (prices.length < period) return null;
        const k = 2 / (period + 1);
        let ema = prices[0];
        for (let i = 1; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }
        return ema;
    },

    rsi(prices, period = 14) {
        if (prices.length < period + 1) return 50;
        let gains = 0,
            losses = 0;
        for (let i = prices.length - period; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff > 0) gains += diff;
            else losses += Math.abs(diff);
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    },

    macd(prices) {
        const ema12 = this.ema(prices, 12);
        const ema26 = this.ema(prices, 26);
        if (!ema12 || !ema26) return { line: 0, signal: 0, histogram: 0, prevHistogram: 0 };
        const macdLine = ema12 - ema26;
        const signal = macdLine * 0.2;
        const histogram = macdLine - signal;
        return { line: macdLine, signal, histogram, prevHistogram: histogram * 0.9 };
    },

    bollingerBands(prices, period = 20, multiplier = 2) {
        const sma = this.sma(prices, period);
        if (!sma) return { upper: 0, middle: 0, lower: 0 };
        const slice = prices.slice(-period);
        const squaredDiffs = slice.map(p => Math.pow(p - sma, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        const stddev = Math.sqrt(variance);
        return {
            upper: sma + (multiplier * stddev),
            middle: sma,
            lower: sma - (multiplier * stddev)
        };
    },

    momentum(prices, period = 10) {
        if (prices.length < period + 1) return 0;
        return prices[prices.length - 1] - prices[prices.length - period - 1];
    },

    atr(prices, period = 14) {
        if (prices.length < period + 1) return 0;
        let sum = 0;
        for (let i = prices.length - period; i < prices.length; i++) {
            sum += Math.abs(prices[i] - prices[i - 1]);
        }
        return sum / period;
    },

    // Fixed order used everywhere votes are stored as a compact 7-char string
    // (e.g. "UDNUUDN") instead of an object — keeps each log entry tiny.
    VOTE_KEYS: ['rsi', 'macd', 'trend', 'bb', 'mom', 'range', 'slope'],
    encodeVotes(votes) {
        if (!votes) return null;
        return this.VOTE_KEYS.map(k => votes[k] || 'N').join('');
    },

    predict(prices, volumes = []) {
        if (!prices || prices.length < 30) {
            return {
                direction: 'NEUTRAL',
                confidence: 50,
                reasons: ['Insufficient data'],
                votes: null,
                indicators: {
                    rsi: 50,
                    macd: 0,
                    sma20: null,
                    sma50: null,
                    bb: { upper: 0, middle: 0, lower: 0 },
                    momentum: 0,
                    atr: 0,
                    rangePosition: 0.5
                }
            };
        }

        const currentPrice = prices[prices.length - 1];
        const rsi = this.rsi(prices, 14);
        const macd = this.macd(prices);
        const sma20 = this.sma(prices, 20);
        const sma50 = this.sma(prices, 50);
        const bb = this.bollingerBands(prices, 20);
        const momentum = this.momentum(prices, 10);
        const atr = this.atr(prices, 14);
        const recentHigh = Math.max(...prices.slice(-20));
        const recentLow = Math.min(...prices.slice(-20));
        const rangePosition = (currentPrice - recentLow) / (recentHigh - recentLow || 1);

        let upScore = 0;
        let downScore = 0;
        let reasons = [];
        let bullishIndicators = 0;
        let bearishIndicators = 0;

        if (rsi < 30) {
            upScore += 2.5;
            reasons.push('RSI deeply oversold (' + rsi.toFixed(1) + ') — strong bounce potential');
            bullishIndicators++;
        } else if (rsi < 40) {
            upScore += 1.5;
            reasons.push('RSI oversold (' + rsi.toFixed(1) + ') — bounce likely');
            bullishIndicators++;
        } else if (rsi > 70) {
            downScore += 2.5;
            reasons.push('RSI overbought (' + rsi.toFixed(1) + ') — reversal expected');
            bearishIndicators++;
        } else if (rsi > 60) {
            downScore += 1.5;
            reasons.push('RSI approaching overbought (' + rsi.toFixed(1) + ')');
            bearishIndicators++;
        } else {
            reasons.push('RSI neutral (' + rsi.toFixed(1) + ')');
        }

        if (macd.histogram > 0 && macd.histogram > macd.prevHistogram) {
            upScore += 2;
            reasons.push('MACD bullish expansion — momentum increasing');
            bullishIndicators++;
        } else if (macd.histogram > 0) {
            upScore += 1;
            reasons.push('MACD positive — bullish bias');
            bullishIndicators++;
        } else if (macd.histogram < 0 && macd.histogram < macd.prevHistogram) {
            downScore += 2;
            reasons.push('MACD bearish expansion — selling pressure increasing');
            bearishIndicators++;
        } else if (macd.histogram < 0) {
            downScore += 1;
            reasons.push('MACD negative — bearish bias');
            bearishIndicators++;
        }

        if (sma20 && sma50) {
            if (currentPrice > sma20 && sma20 > sma50) {
                upScore += 1.5;
                reasons.push('Strong uptrend: Price > SMA20 > SMA50');
                bullishIndicators++;
            } else if (currentPrice > sma20 && sma20 < sma50) {
                upScore += 0.5;
                reasons.push('Price recovering above SMA20 (potential trend change)');
                bullishIndicators++;
            } else if (currentPrice < sma20 && sma20 < sma50) {
                downScore += 1.5;
                reasons.push('Strong downtrend: Price < SMA20 < SMA50');
                bearishIndicators++;
            } else if (currentPrice < sma20 && sma20 > sma50) {
                downScore += 0.5;
                reasons.push('Price breaking below SMA20 (potential trend change)');
                bearishIndicators++;
            }
        }

        if (bb.upper && bb.lower) {
            if (currentPrice < bb.lower) {
                upScore += 2;
                reasons.push('Price below lower Bollinger Band — extreme oversold');
                bullishIndicators++;
            } else if (currentPrice > bb.upper) {
                downScore += 2;
                reasons.push('Price above upper Bollinger Band — extreme overbought');
                bearishIndicators++;
            } else if (currentPrice < bb.middle) {
                upScore += 0.5;
            } else {
                downScore += 0.5;
            }
        }

        if (momentum > 0) {
            upScore += 0.5;
            if (momentum > atr * 2) {
                upScore += 1;
                reasons.push('Strong positive momentum detected');
                bullishIndicators++;
            }
        } else {
            downScore += 0.5;
            if (momentum < -atr * 2) {
                downScore += 1;
                reasons.push('Strong negative momentum detected');
                bearishIndicators++;
            }
        }

        if (rangePosition < 0.2) {
            upScore += 1;
            reasons.push('Price near recent lows — support zone');
            bullishIndicators++;
        } else if (rangePosition > 0.8) {
            downScore += 1;
            reasons.push('Price near recent highs — resistance zone');
            bearishIndicators++;
        }

        if (volumes && volumes.length > 20) {
            const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            const currentVolume = volumes[volumes.length - 1];
            if (currentVolume > avgVolume * 1.5) {
                if (upScore > downScore) {
                    upScore += 1;
                    reasons.push('High volume confirms bullish move');
                } else {
                    downScore += 1;
                    reasons.push('High volume confirms bearish move');
                }
            }
        }

        if (prices.length > 10) {
            const recent = prices.slice(-10);
            const first = recent[0];
            const last = recent[recent.length - 1];
            const slope = (last - first) / first;
            if (slope > 0.05) {
                upScore += 1;
                reasons.push('Strong 10-period uptrend (+' + (slope * 100).toFixed(1) + '%)');
            } else if (slope < -0.05) {
                downScore += 1;
                reasons.push('Strong 10-period downtrend (' + (slope * 100).toFixed(1) + '%)');
            }
        }

        // Each indicator's own directional lean, recorded separately from the
        // blended score so that, once outcomes resolve, we can measure which
        // indicators actually carry signal per market. This mirrors the exact
        // branch conditions used in the scoring above (it changes no scores).
        const votes = { rsi: 'N', macd: 'N', trend: 'N', bb: 'N', mom: 'N', range: 'N', slope: 'N' };
        votes.rsi = rsi < 40 ? 'U' : (rsi > 60 ? 'D' : 'N');
        votes.macd = macd.histogram > 0 ? 'U' : (macd.histogram < 0 ? 'D' : 'N');
        if (sma20 && sma50) votes.trend = currentPrice > sma20 ? 'U' : (currentPrice < sma20 ? 'D' : 'N');
        if (bb.upper && bb.lower) {
            votes.bb = currentPrice < bb.lower ? 'U' : (currentPrice > bb.upper ? 'D' : (currentPrice < bb.middle ? 'U' : 'D'));
        }
        votes.mom = momentum > 0 ? 'U' : 'D';
        votes.range = rangePosition < 0.2 ? 'U' : (rangePosition > 0.8 ? 'D' : 'N');
        if (prices.length > 10) {
            const r10 = prices.slice(-10);
            const slope10 = (r10[r10.length - 1] - r10[0]) / r10[0];
            votes.slope = slope10 > 0.05 ? 'U' : (slope10 < -0.05 ? 'D' : 'N');
        }

        const total = upScore + downScore;
        const confidence = total > 0 ? Math.round((Math.max(upScore, downScore) / total) * 100) : 50;
        const direction = upScore > downScore ? 'UP' : (downScore > upScore ? 'DOWN' : 'NEUTRAL');

        if (direction === 'UP') {
            reasons.unshift('Bullish consensus: ' + bullishIndicators + ' indicators vs ' + bearishIndicators +
                ' bearish');
        } else if (direction === 'DOWN') {
            reasons.unshift('Bearish consensus: ' + bearishIndicators + ' indicators vs ' + bullishIndicators +
                ' bullish');
        }

        return {
            direction,
            confidence: Math.min(confidence, 98),
            upScore,
            downScore,
            reasons,
            votes,
            indicators: { rsi, macd: macd.line, sma20, sma50, bb, momentum, atr, rangePosition }
        };
    }
};

// ─── prediction log + resolution (new) ──────────────────────────────────

function predFile(assetClass, symbol) {
    return path.join(PRED_DIR, assetClass, safeFileName(symbol) + '.json');
}

function loadPredictionLog(assetClass, symbol) {
    const arr = loadJson(predFile(assetClass, symbol));
    return Array.isArray(arr) ? arr : [];
}

function savePredictionLog(assetClass, symbol, entries) {
    const trimmed = entries.length > MAX_PRED_PER_SYMBOL
        ? entries.slice(entries.length - MAX_PRED_PER_SYMBOL)
        : entries;
    saveJson(predFile(assetClass, symbol), trimmed);
}

function maybeLogPrediction(assetClass, symbol, currentPrice, priceHistory) {
    if (priceHistory.length < PRED_MIN_HISTORY) return; // same gate the app uses
    const prediction = TA.predict(priceHistory);
    const votes = TA.encodeVotes(prediction.votes);
    const entries = loadPredictionLog(assetClass, symbol);
    const hasPending = entries.some(e => !e.resolved);
    if (hasPending) return;
    entries.push({
        id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        symbol, assetClass,
        predictedAt: Date.now(),
        resolveAt: Date.now() + PRED_RESOLUTION_MS,
        direction: prediction.direction,
        confidence: prediction.confidence,
        votes,
        priceAtPrediction: currentPrice,
        resolved: false, resolvedAt: null, priceAtResolution: null, outcome: null
    });
    savePredictionLog(assetClass, symbol, entries);
}

function resolvePendingPredictions(assetClass, symbol, currentPrice) {
    const entries = loadPredictionLog(assetClass, symbol);
    if (!entries.length) return;
    const threshold = PRED_FLAT_THRESHOLD_PCT[assetClass] ?? 0.2;
    const now = Date.now();
    let changed = false;
    entries.forEach(e => {
        if (e.resolved || now < e.resolveAt) return;
        const pctMove = ((currentPrice - e.priceAtPrediction) / e.priceAtPrediction) * 100;
        let outcome;
        if (Math.abs(pctMove) < threshold) outcome = 'flat';
        else if ((e.direction === 'UP' && pctMove > 0) || (e.direction === 'DOWN' && pctMove < 0)) outcome = 'correct';
        else if (e.direction === 'NEUTRAL') outcome = 'flat';
        else outcome = 'incorrect';
        e.resolved = true; e.resolvedAt = now; e.priceAtResolution = currentPrice; e.outcome = outcome; e.pctMove = pctMove;
        changed = true;
    });
    if (changed) savePredictionLog(assetClass, symbol, entries);
}

// Walks every data/predictions/<assetClass>/<symbol>.json file and rebuilds
// the single aggregated summary the web app reads.
function rebuildSummary() {
    const summary = {
        generatedAt: Date.now(),
        total: 0, correct: 0, incorrect: 0, flat: 0, pending: 0,
        byAssetClass: {},
        byConfidenceBucket: {
            '50-65%': { correct: 0, incorrect: 0 },
            '65-80%': { correct: 0, incorrect: 0 },
            '80-100%': { correct: 0, incorrect: 0 }
        },
        recent: [] // most recently resolved calls, newest first, capped
    };

    if (!fs.existsSync(PRED_DIR)) {
        saveJson(path.join(PRED_DIR, '_summary.json'), summary);
        return summary;
    }

    const allResolved = [];

    fs.readdirSync(PRED_DIR, { withFileTypes: true }).forEach(dirent => {
        if (!dirent.isDirectory()) return;
        const assetClass = dirent.name;
        const dir = path.join(PRED_DIR, assetClass);
        if (!summary.byAssetClass[assetClass]) {
            summary.byAssetClass[assetClass] = { total: 0, correct: 0, incorrect: 0, flat: 0, pending: 0 };
        }
        fs.readdirSync(dir).forEach(file => {
            if (!file.endsWith('.json')) return;
            const entries = loadJson(path.join(dir, file)) || [];
            entries.forEach(e => {
                if (!e.resolved) {
                    summary.pending++;
                    summary.byAssetClass[assetClass].pending++;
                    return;
                }
                summary.total++;
                summary.byAssetClass[assetClass].total++;
                summary[e.outcome]++;
                summary.byAssetClass[assetClass][e.outcome]++;
                if (e.outcome === 'correct' || e.outcome === 'incorrect') {
                    const bucket = e.confidence >= 80 ? '80-100%' : (e.confidence >= 65 ? '65-80%' : '50-65%');
                    summary.byConfidenceBucket[bucket][e.outcome]++;
                }
                allResolved.push(e);
            });
        });
    });

    const directional = summary.correct + summary.incorrect;
    summary.accuracyPct = directional > 0 ? Math.round((summary.correct / directional) * 1000) / 10 : null;
    Object.keys(summary.byAssetClass).forEach(ac => {
        const s = summary.byAssetClass[ac];
        const d = s.correct + s.incorrect;
        s.accuracyPct = d > 0 ? Math.round((s.correct / d) * 1000) / 10 : null;
    });

    allResolved.sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
    summary.recent = allResolved.slice(0, MAX_RECENT_IN_SUMMARY);

    // The 300-row `recent` list above feeds the Track Record tables, but it is far
    // too short for statistics (and flat results fill much of it). The Trading
    // Insights need every recent UP/DOWN result, so publish those separately in a
    // compact tuple form: [market, symbol, confidence, direction, 1=correct|0=incorrect,
    // predictedAt in seconds, pctMove, votes].
    summary.insights = allResolved
        .filter(e => e.outcome === 'correct' || e.outcome === 'incorrect')
        .slice(0, MAX_INSIGHT_ENTRIES)
        .map(e => [
            e.assetClass, e.symbol, e.confidence, e.direction,
            e.outcome === 'correct' ? 1 : 0,
            Math.round((e.predictedAt || 0) / 1000),
            typeof e.pctMove === 'number' ? Math.round(e.pctMove * 1000) / 1000 : 0,
            e.votes || ''
        ]);

    saveJson(path.join(PRED_DIR, '_summary.json'), summary);
    return summary;
}

// ─── main polling routines ──────────────────────────────────────────────

async function pollForex() {
    // Many pairs share a base currency, and one response already contains every
    // target rate — so fetch each distinct base once (4 requests, not 32). Fewer
    // calls to a free API that rate-limits, identical data.
    const bases = [...new Set(FOREX_PAIRS.map(p => p.from))];
    const rateMaps = {};
    for (const base of bases) {
        try {
            const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            rateMaps[base] = data.rates || null;
        } catch (e) {
            console.warn(`[poller] forex base ${base} failed:`, e.message);
            rateMaps[base] = null;
        }
        await new Promise(r => setTimeout(r, 250)); // be polite to the free API
    }

    let ok = 0, failed = 0;
    for (const pair of FOREX_PAIRS) {
        const rate = rateMaps[pair.from] && rateMaps[pair.from][pair.to];
        if (!rate) { console.warn(`[poller] no forex rate for ${pair.name}`); failed++; continue; }
        const history = appendPricePoint('forex', pair.name, rate);
        resolvePendingPredictions('forex', pair.name, rate);
        maybeLogPrediction('forex', pair.name, rate, history.map(pt => pt.p));
        ok++;
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
                const history = appendPricePoint('moroccan', ticker, price);
                resolvePendingPredictions('moroccan', ticker, price);
                maybeLogPrediction('moroccan', ticker, price, history.map(pt => pt.p));
                ok++;
            }
        }
        console.log(`[poller] moroccan: ${ok} updated`);
    } catch (e) {
        console.warn('[poller] Moroccan stocks poll failed:', e.message);
    }
}


// Same CoinGecko call the web app makes: top 30 coins with their real 7-day
// hourly price series. That series is the history the app predicts on for
// crypto, so the poller predicts on exactly the same thing — no accumulation
// needed, and nothing fabricated. If CoinGecko can't be reached this run
// (rate limit etc.), crypto is simply skipped; no placeholder data is written.
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&page=1&sparkline=true&price_change_percentage=1h,24h,7d';

async function fetchCoinGeckoWithRetry() {
    const waits = [0, 20000, 45000]; // shared CI IPs get rate-limited sometimes — back off and retry
    let lastErr;
    for (const wait of waits) {
        if (wait) await new Promise(r => setTimeout(r, wait));
        try {
            const res = await fetch(COINGECKO_URL, { headers: { 'Accept': 'application/json', 'User-Agent': 'brilliant-trade-poller' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (!Array.isArray(data) || !data.length) throw new Error('empty response');
            return data;
        } catch (e) { lastErr = e; console.warn('[poller] coingecko attempt failed:', e.message); }
    }
    throw lastErr;
}

async function pollCrypto() {
    try {
        const coins = await fetchCoinGeckoWithRetry();
        const seen = new Set();
        let ok = 0;
        for (const coin of coins) {
            const symbol = coin.symbol ? String(coin.symbol).toUpperCase() : null;
            const price = coin.current_price;
            const series = coin.sparkline_in_7d && coin.sparkline_in_7d.price;
            if (!symbol || seen.has(symbol) || typeof price !== 'number' || !(price > 0) || !Array.isArray(series)) continue;
            seen.add(symbol);
            resolvePendingPredictions('crypto', symbol, price);
            maybeLogPrediction('crypto', symbol, price, series);
            ok++;
        }
        console.log(`[poller] crypto: ${ok} coins processed`);
    } catch (e) {
        console.warn('[poller] crypto poll failed this run (skipped, nothing fabricated):', e.message);
    }
}

(async () => {
    console.log('[poller] run started', new Date().toISOString());
    await pollCrypto();
    await pollForex();
    await pollMoroccan();
    const summary = rebuildSummary();
    console.log(`[poller] predictions summary: total=${summary.total} correct=${summary.correct} incorrect=${summary.incorrect} flat=${summary.flat} pending=${summary.pending}`);
    console.log('[poller] run finished', new Date().toISOString());
})();
