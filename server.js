import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const SYMBOL = 'RVI';
const PORT = process.env.PORT || 4000;

// Simple in-memory cache
const cache = new Map();
async function getCached(key, ttlMs, fetcher) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return entry.data;
  try {
    const data = await fetcher();
    cache.set(key, { data, time: Date.now() });
    return data;
  } catch (err) {
    // Return stale cache if available on error
    if (entry) return entry.data;
    throw err;
  }
}

// Yahoo Finance v8 chart API (public, no auth required)
async function fetchYahooChart(symbol, range = '3mo', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    }
  });
  if (!res.ok) throw new Error(`Yahoo API returned ${res.status}`);
  const json = await res.json();
  const result = json.chart.result[0];
  return result;
}

// Extract quote data from chart response
function extractQuoteFromChart(chartResult) {
  const meta = chartResult.meta;
  return {
    symbol: meta.symbol,
    price: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    change: meta.regularMarketPrice - (meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice),
    changePercent: meta.chartPreviousClose ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : 0,
    open: meta.regularMarketOpen || null,
    dayHigh: meta.regularMarketDayHigh || null,
    dayLow: meta.regularMarketDayLow || null,
    volume: meta.regularMarketVolume || null,
    avgVolume: null,
    marketCap: null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
    marketState: meta.marketState || 'REGULAR',
    currency: meta.currency,
    exchangeName: meta.exchangeName,
    timestamp: new Date().toISOString()
  };
}

// Extract OHLCV data from chart response
function extractOHLCV(chartResult) {
  const timestamps = chartResult.timestamp || [];
  const indicators = chartResult.indicators;
  const ohlcv = indicators.quote[0];

  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString(),
    open: ohlcv.open[i],
    high: ohlcv.high[i],
    low: ohlcv.low[i],
    close: ohlcv.close[i],
    volume: ohlcv.volume[i]
  })).filter(q => q.close !== null);
}

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// GET /api/quote - live RVI quote (10s cache)
app.get('/api/quote', async (req, res) => {
  try {
    const chartResult = await getCached('quote', 10000, () => fetchYahooChart(SYMBOL, '1d', '1m'));
    const quote = extractQuoteFromChart(chartResult);

    // Get intraday high/low/open/volume from actual data
    const ohlcv = extractOHLCV(chartResult);
    if (ohlcv.length > 0) {
      quote.open = quote.open || ohlcv[0].open;
      quote.dayHigh = quote.dayHigh || Math.max(...ohlcv.map(q => q.high).filter(Boolean));
      quote.dayLow = quote.dayLow || Math.min(...ohlcv.map(q => q.low).filter(Boolean));
      quote.volume = quote.volume || ohlcv.reduce((sum, q) => sum + (q.volume || 0), 0);
    }

    // Estimate market cap (RVI has ~27.25M shares outstanding from IPO)
    const sharesOutstanding = 27_250_000;
    quote.marketCap = quote.price * sharesOutstanding;
    // Estimate avg volume from 3-month data
    try {
      const hist = await getCached('avgvol', 300000, () => fetchYahooChart(SYMBOL, '3mo', '1d'));
      const vols = extractOHLCV(hist).map(q => q.volume).filter(Boolean);
      if (vols.length > 0) quote.avgVolume = Math.round(vols.reduce((a, b) => a + b, 0) / vols.length);
    } catch {}

    res.json(quote);
  } catch (err) {
    console.error('Quote error:', err.message);
    res.status(502).json({ error: 'Failed to fetch quote', message: err.message });
  }
});

// GET /api/chart - historical price data (60s cache)
app.get('/api/chart', async (req, res) => {
  try {
    const period = req.query.period || '3m';
    // Map our periods to Yahoo's range/interval params
    const config = {
      '1m': { range: '1mo', interval: '15m' },
      '3m': { range: '3mo', interval: '1d' },
      '6m': { range: '6mo', interval: '1d' },
      '1y': { range: '1y', interval: '1d' },
      'max': { range: 'max', interval: '1d' }
    };
    const { range, interval } = config[period] || config['3m'];

    const chartResult = await getCached(`chart-${period}`, 60000, () =>
      fetchYahooChart(SYMBOL, range, interval)
    );

    const quotes = extractOHLCV(chartResult);
    res.json({ quotes, period, interval });
  } catch (err) {
    console.error('Chart error:', err.message);
    res.status(502).json({ error: 'Failed to fetch chart data', message: err.message });
  }
});

// NAV persistence
const NAV_FILE = join(__dirname, 'data', 'nav-history.json');

function loadNavHistory() {
  if (!existsSync(NAV_FILE)) return [];
  return JSON.parse(readFileSync(NAV_FILE, 'utf-8'));
}

function saveNavHistory(entries) {
  writeFileSync(NAV_FILE, JSON.stringify(entries, null, 2));
}

// GET /api/nav
app.get('/api/nav', (req, res) => {
  res.json(loadNavHistory());
});

// POST /api/nav - add NAV entry
app.post('/api/nav', (req, res) => {
  const { nav, date } = req.body;
  if (!nav || typeof nav !== 'number' || nav <= 0) {
    return res.status(400).json({ error: 'Invalid NAV value' });
  }
  const entryDate = date || new Date().toISOString().split('T')[0];
  const entries = loadNavHistory();

  const existing = entries.findIndex(e => e.date === entryDate);
  if (existing >= 0) {
    entries[existing] = { date: entryDate, nav, source: 'manual', updatedAt: new Date().toISOString() };
  } else {
    entries.push({ date: entryDate, nav, source: 'manual', updatedAt: new Date().toISOString() });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  saveNavHistory(entries);
  res.json(entries);
});

// GET /api/holdings - static fund composition
app.get('/api/holdings', (req, res) => {
  res.json({
    asOf: '2026-01-31',
    holdings: [
      { name: 'Databricks', weight: 23.24, sector: 'AI/Data', color: '#6366f1' },
      { name: 'Revolut', weight: 14.30, sector: 'Fintech', color: '#8b5cf6' },
      { name: 'Mercor', weight: 14.23, sector: 'AI', color: '#a78bfa' },
      { name: 'Airwallex', weight: 7.11, sector: 'Fintech', color: '#c4b5fd' },
      { name: 'Boom Supersonic', weight: 7.11, sector: 'Aerospace', color: '#22d3ee' },
      { name: 'Oura', weight: 7.11, sector: 'Health Tech', color: '#2dd4bf' },
      { name: 'Ramp', weight: 7.11, sector: 'Fintech', color: '#34d399' },
      { name: 'Cash & Equivalents', weight: 19.78, sector: 'Cash', color: '#6b7280' }
    ],
    newInvestments: [
      { name: 'OpenAI', status: 'Allocation TBD' },
      { name: 'ElevenLabs', status: 'Allocation TBD' },
      { name: 'Stripe', status: 'Allocation TBD' }
    ],
    expenseRatio: { gross: 3.13, net: 2.13, waiverExpiry: '2026-08-27' }
  });
});

// GET /api/status - market hours and server health
app.get('/api/status', (req, res) => {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = eastern.getHours();
  const min = eastern.getMinutes();
  const day = eastern.getDay();
  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = isWeekday && ((hour === 9 && min >= 30) || (hour > 9 && hour < 16));
  const isPreMarket = isWeekday && ((hour >= 4 && hour < 9) || (hour === 9 && min < 30));
  const isAfterHours = isWeekday && (hour >= 16 && hour < 20);

  res.json({
    isMarketHours,
    isPreMarket,
    isAfterHours,
    marketStatus: isMarketHours ? 'open' : isPreMarket ? 'pre-market' : isAfterHours ? 'after-hours' : 'closed',
    serverTime: now.toISOString(),
    easternTime: eastern.toLocaleTimeString('en-US', { hour12: true })
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  RVI NAV Monitor`);
  console.log(`  ───────────────────────────`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
