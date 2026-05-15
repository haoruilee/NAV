import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const SYMBOL = 'RVI';
const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(16).toString('hex');
const CIK = '0002085091';
const SEC_UA = 'RVINavMonitor admin@rvi-monitor.app';

// ===== File helpers =====
const DATA_DIR = join(__dirname, 'data');
const NAV_FILE = join(DATA_DIR, 'nav-history.json');
const VALUATIONS_FILE = join(DATA_DIR, 'valuations.json');
const CONFIG_FILE = join(DATA_DIR, 'company-config.json');

function readJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}
function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadNavHistory() { return readJSON(NAV_FILE, []); }
function saveNavHistory(entries) { writeJSON(NAV_FILE, entries); }
function loadConfig() { return readJSON(CONFIG_FILE, { companies: {} }); }
function loadValuations() { return readJSON(VALUATIONS_FILE, { lastUpdated: null, sources: {}, companies: {} }); }
function saveValuations(data) { data.lastUpdated = new Date().toISOString(); writeJSON(VALUATIONS_FILE, data); }

// ===== In-memory cache =====
const cache = new Map();
async function getCached(key, ttlMs, fetcher) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return entry.data;
  try {
    const data = await fetcher();
    cache.set(key, { data, time: Date.now() });
    return data;
  } catch (err) {
    if (entry) return entry.data;
    throw err;
  }
}

// ===== Yahoo Finance =====
async function fetchYahooChart(symbol, range = '3mo', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' } });
  if (!res.ok) throw new Error(`Yahoo API returned ${res.status}`);
  const json = await res.json();
  return json.chart.result[0];
}

function extractQuoteFromChart(chartResult) {
  const meta = chartResult.meta;
  return {
    symbol: meta.symbol, price: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    change: meta.regularMarketPrice - (meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice),
    changePercent: meta.chartPreviousClose ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : 0,
    open: meta.regularMarketOpen || null, dayHigh: meta.regularMarketDayHigh || null,
    dayLow: meta.regularMarketDayLow || null, volume: meta.regularMarketVolume || null,
    avgVolume: null, marketCap: null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null, fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
    marketState: meta.marketState || 'REGULAR', currency: meta.currency,
    exchangeName: meta.exchangeName, timestamp: new Date().toISOString()
  };
}

function extractOHLCV(chartResult) {
  const timestamps = chartResult.timestamp || [];
  const ohlcv = chartResult.indicators.quote[0];
  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString(),
    open: ohlcv.open[i], high: ohlcv.high[i], low: ohlcv.low[i],
    close: ohlcv.close[i], volume: ohlcv.volume[i]
  })).filter(q => q.close !== null);
}

// ===== SEC EDGAR - RVI Filing NAV Scraper =====
async function fetchSECFilings() {
  const res = await fetch(`https://data.sec.gov/submissions/CIK${CIK}.json`, { headers: { 'User-Agent': SEC_UA } });
  if (!res.ok) throw new Error(`SEC EDGAR returned ${res.status}`);
  return res.json();
}

async function scrapeNAVFromFiling(accession, primaryDoc) {
  const accClean = accession.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${CIK.replace(/^0+/, '')}/${accClean}/${primaryDoc}`;
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA } });
  if (!res.ok) throw new Error(`Filing fetch returned ${res.status}`);
  const html = await res.text();

  const patterns = [
    /NAV\s+per\s+Share\s+as\s+of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s+\(\$?([\d.]+)\)/gi,
    /net\s+asset\s+value\s+per\s+(?:Share|share)\s+(?:at|as\s+of|on)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})[^$]*\$?([\d.]+)\s+per/gi,
    /\$([\d.]+)\s+per\s+Share[^.]*net\s+asset\s+value[^.]*as\s+of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,
  ];

  const results = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let dateStr, navStr;
      if (pattern === patterns[2]) { navStr = match[1]; dateStr = match[2]; }
      else { dateStr = match[1]; navStr = match[2]; }
      const nav = parseFloat(navStr);
      if (nav > 0 && nav < 500) {
        const parsedDate = new Date(dateStr);
        if (!isNaN(parsedDate.getTime())) {
          results.push({ date: parsedDate.toISOString().split('T')[0], nav, source: 'sec-edgar', filing: accession });
        }
      }
    }
  }
  return results;
}

async function autoFetchNAV() {
  try {
    console.log('[SEC NAV] Checking for new filings...');
    const data = await fetchSECFilings();
    const filings = data.filings?.recent || {};
    const forms = filings.form || [], accessions = filings.accessionNumber || [], primaryDocs = filings.primaryDocument || [];
    const navFilingTypes = ['N-2', 'N-2/A', 'N-CSR', 'N-CSRS', 'N-CEN', '424B1', '424B3', 'N-2 MEF'];
    const entries = loadNavHistory();
    const existingDates = new Set(entries.filter(e => e.source === 'sec-edgar').map(e => e.date));
    let added = 0;

    for (let i = 0; i < Math.min(forms.length, 10); i++) {
      if (!navFilingTypes.includes(forms[i])) continue;
      try {
        const navData = await scrapeNAVFromFiling(accessions[i], primaryDocs[i]);
        for (const nd of navData) {
          if (existingDates.has(nd.date)) continue;
          const idx = entries.findIndex(e => e.date === nd.date);
          if (idx >= 0 && entries[idx].source === 'manual') {
            entries[idx] = { ...nd, updatedAt: new Date().toISOString() };
            added++;
          } else if (idx < 0) {
            entries.push({ ...nd, updatedAt: new Date().toISOString() });
            added++;
          }
          existingDates.add(nd.date);
        }
      } catch (err) { console.error(`[SEC NAV] Error scraping ${forms[i]}:`, err.message); }
    }

    if (added > 0) { entries.sort((a, b) => a.date.localeCompare(b.date)); saveNavHistory(entries); }
    console.log(`[SEC NAV] ${added ? `Added ${added} entries` : 'No new data'}`);
  } catch (err) { console.error('[SEC NAV] Failed:', err.message); }
}

// ===== CB Insights Unicorn List Scraper =====
async function fetchCBInsights() {
  try {
    console.log('[CB Insights] Fetching unicorn list...');
    const res = await fetch('https://www.cbinsights.com/research-unicorn-companies', {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
    });
    if (!res.ok) throw new Error(`CB Insights returned ${res.status}`);
    const html = await res.text();

    const config = loadConfig();
    const valuations = loadValuations();
    let found = 0;

    for (const [key, company] of Object.entries(config.companies)) {
      const searchName = company.cbInsightsName;
      if (!searchName) continue;

      // Search for the company in the HTML table
      // Row format: <td><a href="...">Company</a></td>\n<td data-value="$100">$100</td>
      const escapedName = searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`<td[^>]*>(?:<a[^>]*>)?\\s*${escapedName}\\s*(?:</a>)?</td>[\\s\\S]*?<td[^>]*>\\s*\\$?([\\d,.]+)\\s*</td>`, 'i');
      const match = html.match(regex);

      if (match) {
        const valBillions = parseFloat(match[1].replace(/,/g, ''));
        if (valBillions > 0) {
          if (!valuations.companies[key]) valuations.companies[key] = { valuations: [] };
          const entry = {
            value: valBillions * 1e9,
            date: new Date().toISOString().split('T')[0],
            source: 'cbinsights',
            label: `CB Insights Unicorn List: $${valBillions}B`
          };

          // Only add if value changed from last CB Insights entry
          const existing = valuations.companies[key].valuations.filter(v => v.source === 'cbinsights');
          const last = existing[existing.length - 1];
          if (!last || last.value !== entry.value) {
            valuations.companies[key].valuations.push(entry);
            found++;
          }
        }
      }
    }

    valuations.sources.cbinsights = { lastFetched: new Date().toISOString(), status: 'ok' };
    saveValuations(valuations);
    console.log(`[CB Insights] Found ${found} new valuations`);
  } catch (err) {
    console.error('[CB Insights] Failed:', err.message);
    const valuations = loadValuations();
    valuations.sources.cbinsights = { lastFetched: new Date().toISOString(), status: 'error', error: err.message };
    saveValuations(valuations);
  }
}

// ===== Google News RSS - Valuation Headlines =====
async function fetchNewsValuations() {
  try {
    console.log('[News RSS] Scanning for valuation headlines...');
    const config = loadConfig();
    const valuations = loadValuations();
    let found = 0;

    for (const [key, company] of Object.entries(config.companies)) {
      if (!company.newsQuery) continue;
      try {
        await new Promise(r => setTimeout(r, 1000)); // Rate limit: 1 req/sec
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(company.newsQuery)}&hl=en-US&gl=US&ceid=US:en`;
        const res = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) continue;
        const xml = await res.text();

        // Parse RSS items for valuation numbers
        const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
        if (!valuations.companies[key]) valuations.companies[key] = { valuations: [] };
        const seenUrls = new Set(valuations.companies[key].valuations.filter(v => v.source === 'news').map(v => v.url));

        for (const item of items.slice(0, 10)) {
          const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
          const linkMatch = item.match(/<link>(.*?)<\/link>/);
          const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
          if (!titleMatch || !linkMatch) continue;

          const title = (titleMatch[1] || titleMatch[2]).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          const url = linkMatch[1];
          const pubDate = dateMatch ? new Date(dateMatch[1]) : new Date();

          if (seenUrls.has(url)) continue;

          // Only process headlines that explicitly mention valuation context
          const hasValuationContext = /valuation|valued\s+at|funding\s+round|series\s+[a-z]|raises?\s+\$|worth|unicorn/i.test(title);
          if (!hasValuationContext) continue;

          // Extract valuation from headline: "$134 billion", "$134B", "$10.5B"
          // Strategy: find ALL dollar amounts, prefer the one near "valuation"/"valued" keyword,
          // otherwise take the largest (likely the company valuation, not the round size)
          const allMatches = [...title.matchAll(/\$\s*([\d,.]+)\s*(billion|trillion|B|T)\b/gi)];
          if (!allMatches.length) continue;

          let bestMatch = allMatches[0];
          if (allMatches.length > 1) {
            // Prefer match closest to "valuation"/"valued" keyword
            const valIdx = title.search(/valuation|valued\s+at/i);
            if (valIdx >= 0) {
              bestMatch = allMatches.reduce((best, m) =>
                Math.abs(m.index - valIdx) < Math.abs(best.index - valIdx) ? m : best
              );
            } else {
              // No keyword — take the largest dollar amount
              bestMatch = allMatches.reduce((best, m) => {
                const bv = parseFloat(best[1].replace(/,/g, ''));
                const mv = parseFloat(m[1].replace(/,/g, ''));
                return mv > bv ? m : best;
              });
            }
          }

          let value = parseFloat(bestMatch[1].replace(/,/g, ''));
          const unit = bestMatch[2].toLowerCase();
          if (unit === 'trillion' || unit === 't') value *= 1e12;
          else value *= 1e9;

          // Sanity check: must be > $100M and < $10T
          if (value < 1e8 || value > 1e13) continue;

          valuations.companies[key].valuations.push({
            value,
            date: pubDate.toISOString().split('T')[0],
            source: 'news',
            headline: title.slice(0, 200),
            url
          });
          seenUrls.add(url);
          found++;
        }
      } catch (err) { console.error(`[News RSS] Error for ${company.name}:`, err.message); }
    }

    valuations.sources.news = { lastFetched: new Date().toISOString(), status: 'ok' };
    saveValuations(valuations);
    console.log(`[News RSS] Found ${found} new valuation headlines`);
  } catch (err) {
    console.error('[News RSS] Failed:', err.message);
  }
}

// ===== SEC EDGAR Form D Monitor =====
async function fetchFormDData() {
  try {
    console.log('[Form D] Checking company filings...');
    const config = loadConfig();
    const valuations = loadValuations();
    let found = 0;

    for (const [key, company] of Object.entries(config.companies)) {
      if (!company.cik) continue;
      try {
        await new Promise(r => setTimeout(r, 200)); // SEC rate limit
        const res = await fetch(`https://data.sec.gov/submissions/CIK${company.cik}.json`, {
          headers: { 'User-Agent': SEC_UA }
        });
        if (!res.ok) continue;
        const data = await res.json();
        const filings = data.filings?.recent || {};
        const forms = filings.form || [], dates = filings.filingDate || [], accessions = filings.accessionNumber || [];

        if (!valuations.companies[key]) valuations.companies[key] = { valuations: [] };
        const seenFilings = new Set(valuations.companies[key].valuations.filter(v => v.source === 'formD').map(v => v.filing));

        for (let i = 0; i < Math.min(forms.length, 5); i++) {
          if (!['D', 'D/A'].includes(forms[i])) continue;
          if (seenFilings.has(accessions[i])) continue;

          // Fetch Form D XML for offering amount
          try {
            await new Promise(r => setTimeout(r, 200));
            const accClean = accessions[i].replace(/-/g, '');
            const primaryDoc = filings.primaryDocument?.[i];
            if (!primaryDoc) continue;
            const cikClean = company.cik.replace(/^0+/, '');
            const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikClean}/${accClean}/${primaryDoc}`;
            const xmlRes = await fetch(xmlUrl, { headers: { 'User-Agent': SEC_UA } });
            if (!xmlRes.ok) continue;
            const xml = await xmlRes.text();

            // Extract total offering amount
            const offeringMatch = xml.match(/<totalOfferingAmount>([\d,]+)<\/totalOfferingAmount>/i)
              || xml.match(/totalOfferingAmount[^>]*>([\d,]+)/i);
            if (offeringMatch) {
              const amount = parseFloat(offeringMatch[1].replace(/,/g, ''));
              if (amount > 1e6) { // > $1M to be meaningful
                valuations.companies[key].valuations.push({
                  value: amount,
                  date: dates[i],
                  source: 'formD',
                  filing: accessions[i],
                  label: `Form D: $${(amount / 1e9).toFixed(2)}B offering`
                });
                found++;
              }
            }
          } catch {}
        }
      } catch (err) { console.error(`[Form D] Error for ${company.name}:`, err.message); }
    }

    valuations.sources.formD = { lastFetched: new Date().toISOString(), status: 'ok' };
    saveValuations(valuations);
    console.log(`[Form D] Found ${found} new filings`);
  } catch (err) { console.error('[Form D] Failed:', err.message); }
}

// ===== SEC EDGAR EFTS - Full Text Search for New Filings =====
async function fetchEFTSAlerts() {
  try {
    console.log('[EFTS] Searching for new RVI-related filings...');
    const valuations = loadValuations();
    const config = loadConfig();

    // Check for new RVI fund filings
    const rviRes = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22Robinhood+Ventures+Fund%22&dateRange=custom&startdt=2026-01-01&forms=N-2,N-2/A,N-CSR,N-CSRS,424B1`,
      { headers: { 'User-Agent': SEC_UA } }
    );
    if (rviRes.ok) {
      const rviData = await rviRes.json();
      const totalHits = rviData.hits?.total?.value || 0;
      console.log(`[EFTS] Found ${totalHits} RVI fund filings`);
    }

    // Search for each portfolio company to find mentions in other fund filings (implies valuation events)
    let alerts = 0;
    for (const [key, company] of Object.entries(config.companies)) {
      if (!company.name || company.weight === 0) continue; // Skip TBD allocations
      try {
        await new Promise(r => setTimeout(r, 300));
        const q = encodeURIComponent(`"${company.name}" AND (valuation OR "funding round" OR "Series")`);
        const res = await fetch(
          `https://efts.sec.gov/LATEST/search-index?q=${q}&dateRange=custom&startdt=2026-01-01`,
          { headers: { 'User-Agent': SEC_UA } }
        );
        if (!res.ok) continue;
        const data = await res.json();
        const hits = data.hits?.total?.value || 0;
        if (hits > 0) alerts++;
      } catch {}
    }

    valuations.sources.efts = { lastFetched: new Date().toISOString(), status: 'ok', alerts };
    saveValuations(valuations);
    console.log(`[EFTS] ${alerts} companies have SEC filing mentions`);
  } catch (err) { console.error('[EFTS] Failed:', err.message); }
}

// ===== Estimated NAV Computation =====
function computeEstimatedNAV() {
  const config = loadConfig();
  const valuations = loadValuations();
  const navHistory = loadNavHistory();
  const latestOfficialNAV = navHistory.length ? navHistory[navHistory.length - 1] : null;

  const holdings = [];
  let totalOfficialValue = 0;
  let totalEstimatedValue = 0;

  for (const [key, company] of Object.entries(config.companies)) {
    if (company.totalFairValue === 0) continue; // Skip TBD allocations

    const officialValue = company.totalFairValue;
    totalOfficialValue += officialValue;

    // Find the best (most recent) valuation from any source
    const companyVals = valuations.companies[key]?.valuations || [];
    const sortedVals = [...companyVals].sort((a, b) => b.date.localeCompare(a.date));
    const latestVal = sortedVals[0];

    let estimatedValue = officialValue;
    let multiplier = 1;
    let dataAge = null;
    let latestSource = null;

    if (latestVal && company.valuationAtFiling) {
      // Scale: if company was worth $62B at filing and now worth $100B, scale up by 100/62
      multiplier = latestVal.value / company.valuationAtFiling;
      estimatedValue = officialValue * multiplier;
      dataAge = Math.floor((Date.now() - new Date(latestVal.date).getTime()) / 86400000);
      latestSource = latestVal;
    }

    totalEstimatedValue += estimatedValue;
    holdings.push({
      key, name: company.name, weight: company.weight, sector: company.sector,
      officialValue, estimatedValue, multiplier,
      valuationAtFiling: company.valuationAtFiling,
      latestValuation: latestVal ? { value: latestVal.value, date: latestVal.date, source: latestVal.source, label: latestVal.label || latestVal.headline } : null,
      dataAgeDays: dataAge
    });
  }

  // Add cash position
  const cashValue = config.cashPosition || 0;
  totalOfficialValue += cashValue;
  totalEstimatedValue += cashValue;

  const shares = config.sharesOutstanding || 27250000;
  const officialNAV = latestOfficialNAV?.nav || (totalOfficialValue / shares);
  const estimatedNAV = totalEstimatedValue / shares;

  // Confidence: based on average data freshness
  const ages = holdings.map(h => h.dataAgeDays).filter(a => a !== null);
  const avgAge = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 999;
  let confidence = 'low';
  if (avgAge < 30) confidence = 'high';
  else if (avgAge < 90) confidence = 'medium';

  return {
    officialNAV: latestOfficialNAV ? { nav: latestOfficialNAV.nav, date: latestOfficialNAV.date, source: latestOfficialNAV.source } : null,
    estimatedNAV: Math.round(estimatedNAV * 100) / 100,
    confidence,
    avgDataAgeDays: Math.round(avgAge),
    totalOfficialValue, totalEstimatedValue, cashValue,
    sharesOutstanding: shares,
    filingBaseDate: config.filingBaseDate,
    holdings,
    sources: valuations.sources,
    lastUpdated: valuations.lastUpdated
  };
}

// ===== Admin auth =====
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ===== Express setup =====
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// GET /api/quote
app.get('/api/quote', async (req, res) => {
  try {
    const chartResult = await getCached('quote', 10000, () => fetchYahooChart(SYMBOL, '1d', '1m'));
    const quote = extractQuoteFromChart(chartResult);
    const ohlcv = extractOHLCV(chartResult);
    if (ohlcv.length > 0) {
      quote.open = quote.open || ohlcv[0].open;
      quote.dayHigh = quote.dayHigh || Math.max(...ohlcv.map(q => q.high).filter(Boolean));
      quote.dayLow = quote.dayLow || Math.min(...ohlcv.map(q => q.low).filter(Boolean));
      quote.volume = quote.volume || ohlcv.reduce((sum, q) => sum + (q.volume || 0), 0);
    }
    const sharesOutstanding = loadConfig().sharesOutstanding || 27250000;
    quote.marketCap = quote.price * sharesOutstanding;
    try {
      const hist = await getCached('avgvol', 300000, () => fetchYahooChart(SYMBOL, '3mo', '1d'));
      const vols = extractOHLCV(hist).map(q => q.volume).filter(Boolean);
      if (vols.length > 0) quote.avgVolume = Math.round(vols.reduce((a, b) => a + b, 0) / vols.length);
    } catch {}
    res.json(quote);
  } catch (err) { res.status(502).json({ error: 'Failed to fetch quote', message: err.message }); }
});

// GET /api/chart
app.get('/api/chart', async (req, res) => {
  try {
    const period = req.query.period || '3m';
    const config = { '1m': { range: '1mo', interval: '15m' }, '3m': { range: '3mo', interval: '1d' }, '6m': { range: '6mo', interval: '1d' }, '1y': { range: '1y', interval: '1d' }, 'max': { range: 'max', interval: '1d' } };
    const { range, interval } = config[period] || config['3m'];
    const chartResult = await getCached(`chart-${period}`, 60000, () => fetchYahooChart(SYMBOL, range, interval));
    res.json({ quotes: extractOHLCV(chartResult), period, interval });
  } catch (err) { res.status(502).json({ error: 'Failed to fetch chart data', message: err.message }); }
});

// GET /api/nav
app.get('/api/nav', (req, res) => { res.json(loadNavHistory()); });

// POST /api/nav (admin only)
app.post('/api/nav', requireAdmin, (req, res) => {
  const { nav, date } = req.body;
  if (!nav || typeof nav !== 'number' || nav <= 0) return res.status(400).json({ error: 'Invalid NAV value' });
  const entryDate = date || new Date().toISOString().split('T')[0];
  const entries = loadNavHistory();
  const existing = entries.findIndex(e => e.date === entryDate);
  if (existing >= 0) entries[existing] = { date: entryDate, nav, source: 'manual', updatedAt: new Date().toISOString() };
  else entries.push({ date: entryDate, nav, source: 'manual', updatedAt: new Date().toISOString() });
  entries.sort((a, b) => a.date.localeCompare(b.date));
  saveNavHistory(entries);
  res.json(entries);
});

// GET /api/holdings
app.get('/api/holdings', (req, res) => {
  const config = loadConfig();
  const activeHoldings = Object.values(config.companies).filter(c => c.weight > 0);
  const newInvestments = Object.values(config.companies).filter(c => c.weight === 0 && c.note);
  res.json({
    asOf: config.filingBaseDate || '2026-01-31',
    holdings: activeHoldings.map(c => ({ name: c.name, weight: c.weight, sector: c.sector })),
    newInvestments: newInvestments.map(c => ({ name: c.name, status: c.note })),
    expenseRatio: { gross: 3.13, net: 2.13, waiverExpiry: '2026-08-27' }
  });
});

// GET /api/valuations
app.get('/api/valuations', (req, res) => {
  const config = loadConfig();
  const valuations = loadValuations();
  const result = {};
  for (const [key, company] of Object.entries(config.companies)) {
    const vals = valuations.companies[key]?.valuations || [];
    const sorted = [...vals].sort((a, b) => b.date.localeCompare(a.date));
    result[key] = {
      name: company.name, weight: company.weight, sector: company.sector,
      totalFairValue: company.totalFairValue, valuationAtFiling: company.valuationAtFiling,
      latestValuation: sorted[0] || null,
      valuationHistory: sorted.slice(0, 10)
    };
  }
  res.json({ companies: result, sources: valuations.sources, lastUpdated: valuations.lastUpdated });
});

// GET /api/estimated-nav
app.get('/api/estimated-nav', (req, res) => {
  res.json(computeEstimatedNAV());
});

// GET /api/status
app.get('/api/status', (req, res) => {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = eastern.getHours(), min = eastern.getMinutes(), day = eastern.getDay();
  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = isWeekday && ((hour === 9 && min >= 30) || (hour > 9 && hour < 16));
  const isPreMarket = isWeekday && ((hour >= 4 && hour < 9) || (hour === 9 && min < 30));
  const isAfterHours = isWeekday && (hour >= 16 && hour < 20);
  res.json({
    isMarketHours, isPreMarket, isAfterHours,
    marketStatus: isMarketHours ? 'open' : isPreMarket ? 'pre-market' : isAfterHours ? 'after-hours' : 'closed',
    serverTime: now.toISOString(),
    easternTime: eastern.toLocaleTimeString('en-US', { hour12: true })
  });
});

// ===== Data Refresh Scheduler =====
async function runAllFetchers() {
  console.log('\n[Scheduler] Running all data fetchers...');
  await autoFetchNAV();
  await fetchCBInsights();
  await fetchNewsValuations();
  await fetchFormDData();
  await fetchEFTSAlerts();
  console.log('[Scheduler] All fetchers complete\n');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  RVI NAV Monitor`);
  console.log(`  ───────────────────────────`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Admin key: ${ADMIN_KEY}`);
  console.log(`  Press Ctrl+C to stop\n`);

  // Run all fetchers on startup
  runAllFetchers();

  // Schedule recurring fetches
  setInterval(autoFetchNAV, 6 * 3600_000);         // SEC NAV: every 6h
  setInterval(fetchNewsValuations, 6 * 3600_000);   // News: every 6h
  setInterval(fetchCBInsights, 12 * 3600_000);      // CB Insights: every 12h
  setInterval(fetchFormDData, 12 * 3600_000);        // Form D: every 12h
  setInterval(fetchEFTSAlerts, 24 * 3600_000);       // EFTS: every 24h
});
