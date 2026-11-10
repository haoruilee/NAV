import express from 'express';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { auditFundData, auditValuationEntry } from './scripts/valuation-audit-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(16).toString('hex');
const SEC_UA = 'NAVMonitor admin@nav-monitor.app';

// ===== File helpers (multi-fund) =====
const DATA_DIR = join(__dirname, 'data');
const FUNDS_FILE = join(DATA_DIR, 'funds.json');
const HARNESS_RUNS_DIR = join(__dirname, 'var', 'agent-harness', 'runs');

function readJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return fallback; }
}
function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function loadFunds() { return readJSON(FUNDS_FILE, []); }
function getFund(fundId) { return loadFunds().find(f => f.id === fundId); }

function loadNavHistory(fundId) { return readJSON(join(DATA_DIR, fundId, 'nav-history.json'), []); }
function saveNavHistory(fundId, entries) { writeJSON(join(DATA_DIR, fundId, 'nav-history.json'), entries); }
function loadConfig(fundId) { return readJSON(join(DATA_DIR, fundId, 'company-config.json'), { companies: {} }); }
function loadValuations(fundId) { return readJSON(join(DATA_DIR, fundId, 'valuations.json'), { lastUpdated: null, sources: {}, companies: {} }); }
function saveValuations(fundId, data) { data.lastUpdated = new Date().toISOString(); writeJSON(join(DATA_DIR, fundId, 'valuations.json'), data); }

// Resolve fund from query param, default to 'rvi'
function resolveFund(req) {
  const fundId = req.query.fund || 'rvi';
  const fund = getFund(fundId);
  return fund ? fundId : null;
}

function valuationAuditFor(key, company, entry, peers) {
  return entry.audit || auditValuationEntry({ key, company, entry, peers });
}

function valuationTrustScore(audit) {
  const trust = { high: 30, medium: 20, low: 10 }[audit?.trustLevel] || 0;
  const source = {
    'company-official': 8,
    regulatory: 8,
    'primary-wire': 7,
    'trusted-media': 5,
    aggregator: 3
  }[audit?.sourceClass] || 0;
  const cross = audit?.crossVerified ? 2 : 0;
  return trust + source + cross;
}

function selectNavValuation(key, company, entries) {
  const eligible = entries
    .map(entry => ({ entry, audit: valuationAuditFor(key, company, entry, entries) }))
    .filter(item => item.audit.useForNav);
  eligible.sort((a, b) => {
    const scoreDiff = valuationTrustScore(b.audit) - valuationTrustScore(a.audit);
    if (scoreDiff !== 0) return scoreDiff;
    return String(b.entry.date || '').localeCompare(String(a.entry.date || ''));
  });
  return eligible[0]?.entry || null;
}

function selectLatestOfficialNAV(navHistory, asOfDate = null) {
  const entries = asOfDate ? navHistory.filter(entry => entry.date <= asOfDate) : navHistory;
  return entries.length ? entries[entries.length - 1] : null;
}

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

// ===== SEC EDGAR - Filing NAV Scraper =====
async function fetchSECFilings(cik) {
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { 'User-Agent': SEC_UA } });
  if (!res.ok) throw new Error(`SEC EDGAR returned ${res.status}`);
  return res.json();
}

async function scrapeNAVFromFiling(cik, accession, primaryDoc) {
  const accClean = accession.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, '')}/${accClean}/${primaryDoc}`;
  const res = await fetch(url, { headers: { 'User-Agent': SEC_UA } });
  if (!res.ok) throw new Error(`Filing fetch returned ${res.status}`);
  const html = await res.text();

  const patterns = [
    /NAV\s+per\s+Share\s+as\s+of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})\s+\(\$?([\d.]+)\)/gi,
    /net\s+asset\s+value\s+per\s+(?:Share|share|unit)\s+(?:at|as\s+of|on|of)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})[^$]*\$?([\d.]+)\s+per/gi,
    /\$([\d.]+)\s+per\s+(?:Share|share|unit)[^.]*net\s+asset\s+value[^.]*as\s+of\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/gi,
    /net\s+asset\s+value[^(]*\((?:"|&#8220;|")NAV(?:"|&#8221;|")\)[^$]*of\s+\$?([\d.]+)/gi,
  ];

  const results = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let dateStr, navStr;
      if (pattern === patterns[2]) { navStr = match[1]; dateStr = match[2]; }
      else if (pattern === patterns[3]) {
        navStr = match[1]; dateStr = null; // NAV without date
      }
      else { dateStr = match[1]; navStr = match[2]; }
      const nav = parseFloat(navStr);
      if (nav > 0 && nav < 500) {
        if (dateStr) {
          const parsedDate = new Date(dateStr);
          if (!isNaN(parsedDate.getTime())) {
            results.push({ date: parsedDate.toISOString().split('T')[0], nav, source: 'sec-edgar', filing: accession });
          }
        }
      }
    }
  }
  return results;
}

async function autoFetchNAV(fundId) {
  const fund = getFund(fundId);
  if (!fund?.cik) return;
  try {
    console.log(`[SEC NAV][${fundId}] Checking for new filings...`);
    const data = await fetchSECFilings(fund.cik);
    const filings = data.filings?.recent || {};
    const forms = filings.form || [], accessions = filings.accessionNumber || [], primaryDocs = filings.primaryDocument || [];
    const navFilingTypes = ['N-2', 'N-2/A', 'N-CSR', 'N-CSRS', 'N-CEN', '424B1', '424B3', 'N-2 MEF'];
    const entries = loadNavHistory(fundId);
    const existingDates = new Set(entries.filter(e => e.source === 'sec-edgar').map(e => e.date));
    let added = 0;

    for (let i = 0; i < Math.min(forms.length, 10); i++) {
      if (!navFilingTypes.includes(forms[i])) continue;
      try {
        const navData = await scrapeNAVFromFiling(fund.cik, accessions[i], primaryDocs[i]);
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
      } catch (err) { console.error(`[SEC NAV][${fundId}] Error scraping ${forms[i]}:`, err.message); }
    }

    if (added > 0) { entries.sort((a, b) => a.date.localeCompare(b.date)); saveNavHistory(fundId, entries); }
    console.log(`[SEC NAV][${fundId}] ${added ? `Added ${added} entries` : 'No new data'}`);
  } catch (err) { console.error(`[SEC NAV][${fundId}] Failed:`, err.message); }
}

// ===== CB Insights Unicorn List Scraper =====
// Fetched once, applied to all funds
let cbInsightsCache = { html: null, time: 0 };

async function fetchCBInsightsHTML() {
  if (cbInsightsCache.html && Date.now() - cbInsightsCache.time < 3600_000) return cbInsightsCache.html;
  const res = await fetch('https://www.cbinsights.com/research-unicorn-companies', {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`CB Insights returned ${res.status}`);
  cbInsightsCache.html = await res.text();
  cbInsightsCache.time = Date.now();
  return cbInsightsCache.html;
}

async function fetchCBInsights(fundId) {
  try {
    console.log(`[CB Insights][${fundId}] Matching unicorn list...`);
    const html = await fetchCBInsightsHTML();
    const config = loadConfig(fundId);
    const valuations = loadValuations(fundId);
    let found = 0;

    for (const [key, company] of Object.entries(config.companies)) {
      const searchName = company.cbInsightsName;
      if (!searchName) continue;

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
    saveValuations(fundId, valuations);
    console.log(`[CB Insights][${fundId}] Found ${found} new valuations`);
  } catch (err) {
    console.error(`[CB Insights][${fundId}] Failed:`, err.message);
    const valuations = loadValuations(fundId);
    valuations.sources.cbinsights = { lastFetched: new Date().toISOString(), status: 'error', error: err.message };
    saveValuations(fundId, valuations);
  }
}

// ===== Google News RSS - Valuation Headlines =====
async function fetchNewsValuations(fundId) {
  try {
    console.log(`[News RSS][${fundId}] Scanning for valuation headlines...`);
    const config = loadConfig(fundId);
    const valuations = loadValuations(fundId);
    let found = 0;

    for (const [key, company] of Object.entries(config.companies)) {
      if (!company.newsQuery) continue;
      try {
        await new Promise(r => setTimeout(r, 1000));
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(company.newsQuery)}&hl=en-US&gl=US&ceid=US:en`;
        const res = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) continue;
        const xml = await res.text();

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

          const hasValuationContext = /valuation|valued\s+at|funding\s+round|series\s+[a-z]|raises?\s+\$|worth|unicorn/i.test(title);
          if (!hasValuationContext) continue;

          const allMatches = [...title.matchAll(/\$\s*([\d,.]+)\s*(billion|trillion|B|T)\b/gi)];
          if (!allMatches.length) continue;

          // Classify each dollar match as "valuation" or "funding amount"
          // A match near "valuation", "valued at", "worth" = valuation
          // A match near "raises", "raising", "raised", "closes", "close" = funding amount
          const classified = allMatches.map(m => {
            const before = title.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
            const after = title.slice(m.index, m.index + 60).toLowerCase();
            const nearValuation = /valuation|valued\s+at|worth/.test(before + ' ' + after);
            const nearFunding = /raises?|raising|raised|closed?\s|closing|in\s+funding|funding\s+round|series\s+[a-z]/i.test(before) ||
              /funding\s+round|series\s+[a-z]/i.test(after);
            return { match: m, isValuation: nearValuation, isFunding: nearFunding && !nearValuation };
          });

          // Prefer explicit valuation matches
          const valuationMatches = classified.filter(c => c.isValuation);
          const nonFundingMatches = classified.filter(c => !c.isFunding);
          let bestMatch;

          // If only 1 dollar match and both "raise" and "valuation" context exist,
          // the dollar is the raise amount not the valuation — skip
          // e.g. "Raise $15 Billion, Lifting Valuation" — $15B is the raise
          if (allMatches.length === 1) {
            const m = classified[0];
            const before = title.slice(Math.max(0, m.match.index - 60), m.match.index).toLowerCase();
            const hasRaise = /raises?|raising|raised|closed?\s/i.test(before);
            if (hasRaise && m.isValuation) continue;
          }

          if (valuationMatches.length) {
            // Take the valuation-tagged match closest to "valuation" keyword
            const valIdx = title.search(/valuation|valued\s+at/i);
            bestMatch = valuationMatches.reduce((best, c) =>
              Math.abs(c.match.index - valIdx) < Math.abs(best.match.index - valIdx) ? c : best
            ).match;
          } else if (nonFundingMatches.length) {
            // No explicit valuation keyword, but some matches aren't funding amounts — take largest
            bestMatch = nonFundingMatches.reduce((best, c) => {
              const bv = parseFloat(best.match[1].replace(/,/g, ''));
              const mv = parseFloat(c.match[1].replace(/,/g, ''));
              return mv > bv ? c : best;
            }).match;
          } else {
            // All matches look like funding amounts (e.g. "raises $20B") — skip
            continue;
          }

          let value = parseFloat(bestMatch[1].replace(/,/g, ''));
          const unit = bestMatch[2].toLowerCase();
          if (unit === 'trillion' || unit === 't') value *= 1e12;
          else value *= 1e9;

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
      } catch (err) { console.error(`[News RSS][${fundId}] Error for ${company.name}:`, err.message); }
    }

    valuations.sources.news = { lastFetched: new Date().toISOString(), status: 'ok' };
    saveValuations(fundId, valuations);
    console.log(`[News RSS][${fundId}] Found ${found} new valuation headlines`);
  } catch (err) {
    console.error(`[News RSS][${fundId}] Failed:`, err.message);
  }
}

// ===== SEC EDGAR Form D Monitor =====
async function fetchFormDData(fundId) {
  try {
    console.log(`[Form D][${fundId}] Checking company filings...`);
    const config = loadConfig(fundId);
    const valuations = loadValuations(fundId);
    let found = 0;

    for (const [key, company] of Object.entries(config.companies)) {
      if (!company.cik) continue;
      try {
        await new Promise(r => setTimeout(r, 200));
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

            const offeringMatch = xml.match(/<totalOfferingAmount>([\d,]+)<\/totalOfferingAmount>/i)
              || xml.match(/totalOfferingAmount[^>]*>([\d,]+)/i);
            if (offeringMatch) {
              const amount = parseFloat(offeringMatch[1].replace(/,/g, ''));
              if (amount > 1e6) {
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
      } catch (err) { console.error(`[Form D][${fundId}] Error for ${company.name}:`, err.message); }
    }

    valuations.sources.formD = { lastFetched: new Date().toISOString(), status: 'ok' };
    saveValuations(fundId, valuations);
    console.log(`[Form D][${fundId}] Found ${found} new filings`);
  } catch (err) { console.error(`[Form D][${fundId}] Failed:`, err.message); }
}

// ===== SEC EDGAR EFTS - Full Text Search for New Filings =====
async function fetchEFTSAlerts(fundId) {
  const fund = getFund(fundId);
  if (!fund) return;
  try {
    console.log(`[EFTS][${fundId}] Searching for new filings...`);
    const valuations = loadValuations(fundId);
    const config = loadConfig(fundId);

    // Check for new fund filings using the fund's search name
    const searchName = fund.secSearchName || fund.name;
    const fundRes = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(searchName)}%22&dateRange=custom&startdt=2026-01-01&forms=N-2,N-2/A,N-CSR,N-CSRS,424B1,424B3`,
      { headers: { 'User-Agent': SEC_UA } }
    );
    if (fundRes.ok) {
      const fundData = await fundRes.json();
      const totalHits = fundData.hits?.total?.value || 0;
      console.log(`[EFTS][${fundId}] Found ${totalHits} fund filings`);
    }

    let alerts = 0;
    for (const [key, company] of Object.entries(config.companies)) {
      if (!company.name || company.weight === 0) continue;
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
    saveValuations(fundId, valuations);
    console.log(`[EFTS][${fundId}] ${alerts} companies have SEC filing mentions`);
  } catch (err) { console.error(`[EFTS][${fundId}] Failed:`, err.message); }
}

// ===== Estimated NAV Computation =====
function computeEstimatedNAV(fundId, asOfDate = null) {
  const config = loadConfig(fundId);
  const valuations = loadValuations(fundId);
  const navHistory = loadNavHistory(fundId);
  const latestOfficialNAV = selectLatestOfficialNAV(navHistory, asOfDate);

  const holdings = [];
  let totalOfficialValue = 0;
  let totalEstimatedValue = 0;

  for (const [key, company] of Object.entries(config.companies || {})) {
    if (company.totalFairValue === 0) continue;

    const officialValue = company.totalFairValue;
    totalOfficialValue += officialValue;

    const companyValsAll = valuations.companies[key]?.valuations || [];
    const companyVals = asOfDate ? companyValsAll.filter(v => !v.date || v.date <= asOfDate) : companyValsAll;
    const sortedVals = [...companyVals].sort((a, b) => b.date.localeCompare(a.date));
    const latestVal = selectNavValuation(key, company, sortedVals);

    let estimatedValue = officialValue;
    let multiplier = 1;
    let dataAge = null;
    let verificationAge = null;

    if (latestVal && company.valuationAtFiling) {
      multiplier = latestVal.value / company.valuationAtFiling;
      estimatedValue = officialValue * multiplier;
      const referenceDate = asOfDate ? new Date(`${asOfDate}T00:00:00Z`) : new Date();
      dataAge = Math.floor((referenceDate.getTime() - new Date(latestVal.date).getTime()) / 86400000);
      const auditCheckedAt = (latestVal.audit || auditValuationEntry({ key, company, entry: latestVal, peers: companyVals })).checkedAt;
      verificationAge = auditCheckedAt ? Math.floor((Date.now() - new Date(auditCheckedAt).getTime()) / 86400000) : null;
    }

    totalEstimatedValue += estimatedValue;
    holdings.push({
      key, name: company.name, weight: company.weight, sector: company.sector,
      officialValue, estimatedValue, multiplier,
      valuationAtFiling: company.valuationAtFiling,
      corporateAction: company.corporateAction || null,
      latestValuation: latestVal ? {
        value: latestVal.value,
        date: latestVal.date,
        source: latestVal.source,
        label: latestVal.label || latestVal.headline,
        url: latestVal.url || null,
        audit: valuationAuditFor(key, company, latestVal, companyVals)
      } : null,
      blockedValuations: sortedVals.filter(v => {
        const audit = valuationAuditFor(key, company, v, companyVals);
        return !audit.useForNav;
      }).slice(0, 5).map(v => ({
        value: v.value,
        date: v.date,
        source: v.source,
        label: v.label || v.headline,
        url: v.url || null,
        audit: valuationAuditFor(key, company, v, companyVals)
      })),
      dataAgeDays: dataAge,
      valuationAgeDays: dataAge,
      verificationAgeDays: verificationAge
    });
  }

  const cashValue = config.cashPosition || 0;
  totalOfficialValue += cashValue;
  totalEstimatedValue += cashValue;

  const shares = config.sharesOutstanding || 1;
  const officialNAV = latestOfficialNAV?.nav || (totalOfficialValue / shares);
  const estimatedNAV = totalEstimatedValue > 0 ? (totalEstimatedValue / shares) : (latestOfficialNAV?.nav || 0);

  const ages = holdings.map(h => h.dataAgeDays).filter(a => a !== null);
  const avgAge = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 999;
  let confidence = 'low';
  if (avgAge < 30) confidence = 'high';
  else if (avgAge < 90) confidence = 'medium';

  return {
    officialNAV: latestOfficialNAV ? { nav: latestOfficialNAV.nav, date: latestOfficialNAV.date, source: latestOfficialNAV.source } : null,
    asOfDate: asOfDate || new Date().toISOString().split('T')[0],
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

function computeEstimatedNAVHistory(fundId) {
  const config = loadConfig(fundId);
  const valuations = loadValuations(fundId);
  const navHistory = loadNavHistory(fundId);
  const dates = new Set(navHistory.map(entry => entry.date));
  if (config.filingBaseDate) dates.add(config.filingBaseDate);

  for (const [key, company] of Object.entries(config.companies || {})) {
    const entries = valuations.companies?.[key]?.valuations || [];
    for (const entry of entries) {
      if (!entry.date) continue;
      const audit = entry.audit || auditValuationEntry({ key, company, entry, peers: entries });
      if (audit.useForNav || audit.issues?.length) dates.add(entry.date);
    }
  }

  dates.add(new Date().toISOString().split('T')[0]);
  return [...dates].sort().map(date => {
    const snapshot = computeEstimatedNAV(fundId, date);
    return {
      date,
      estimatedNAV: snapshot.estimatedNAV,
      officialNAV: snapshot.officialNAV,
      confidence: snapshot.confidence,
      holdings: snapshot.holdings
        .filter(holding => holding.latestValuation || holding.blockedValuations?.length || holding.corporateAction)
        .map(holding => ({
          key: holding.key,
          name: holding.name,
          weight: holding.weight,
          sector: holding.sector,
          latestValuation: holding.latestValuation,
          blockedValuations: holding.blockedValuations,
          corporateAction: holding.corporateAction
        }))
    };
  }).filter(point => point.estimatedNAV > 0 || point.officialNAV);
}

// ===== Admin auth =====
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ===== Express setup =====
app.use(express.json());

// SEO headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.static(join(__dirname, 'public')));

// GET /api/funds
app.get('/api/funds', (req, res) => {
  res.json(loadFunds());
});

// GET /api/quote
app.get('/api/quote', async (req, res) => {
  try {
    const fundId = resolveFund(req);
    if (!fundId) return res.status(404).json({ error: 'Fund not found' });
    const fund = getFund(fundId);
    if (!fund.hasMarketPrice) return res.status(400).json({ error: 'Fund is not exchange-listed' });
    const symbol = fund.symbol;
    const chartResult = await getCached(`quote-${fundId}`, 10000, () => fetchYahooChart(symbol, '1d', '1m'));
    const quote = extractQuoteFromChart(chartResult);
    const ohlcv = extractOHLCV(chartResult);
    if (ohlcv.length > 0) {
      quote.open = quote.open || ohlcv[0].open;
      quote.dayHigh = quote.dayHigh || Math.max(...ohlcv.map(q => q.high).filter(Boolean));
      quote.dayLow = quote.dayLow || Math.min(...ohlcv.map(q => q.low).filter(Boolean));
      quote.volume = quote.volume || ohlcv.reduce((sum, q) => sum + (q.volume || 0), 0);
    }
    const sharesOutstanding = loadConfig(fundId).sharesOutstanding || 27250000;
    quote.marketCap = quote.price * sharesOutstanding;
    try {
      const hist = await getCached(`avgvol-${fundId}`, 300000, () => fetchYahooChart(symbol, '3mo', '1d'));
      const vols = extractOHLCV(hist).map(q => q.volume).filter(Boolean);
      if (vols.length > 0) quote.avgVolume = Math.round(vols.reduce((a, b) => a + b, 0) / vols.length);
    } catch {}
    res.json(quote);
  } catch (err) { res.status(502).json({ error: 'Failed to fetch quote', message: err.message }); }
});

// GET /api/chart
app.get('/api/chart', async (req, res) => {
  try {
    const fundId = resolveFund(req);
    if (!fundId) return res.status(404).json({ error: 'Fund not found' });
    const fund = getFund(fundId);
    if (!fund.hasMarketPrice) return res.status(400).json({ error: 'Fund is not exchange-listed' });
    const symbol = fund.symbol;
    const period = req.query.period || '3m';
    const periodConfig = { '1m': { range: '1mo', interval: '15m' }, '3m': { range: '3mo', interval: '1d' }, '6m': { range: '6mo', interval: '1d' }, '1y': { range: '1y', interval: '1d' }, 'max': { range: 'max', interval: '1d' } };
    const { range, interval } = periodConfig[period] || periodConfig['3m'];
    const chartResult = await getCached(`chart-${fundId}-${period}`, 60000, () => fetchYahooChart(symbol, range, interval));
    res.json({ quotes: extractOHLCV(chartResult), period, interval });
  } catch (err) { res.status(502).json({ error: 'Failed to fetch chart data', message: err.message }); }
});

// GET /api/nav
app.get('/api/nav', (req, res) => {
  const fundId = resolveFund(req);
  if (!fundId) return res.status(404).json({ error: 'Fund not found' });
  res.json(loadNavHistory(fundId));
});

// POST /api/nav (admin only)
app.post('/api/nav', requireAdmin, (req, res) => {
  const fundId = resolveFund(req);
  if (!fundId) return res.status(404).json({ error: 'Fund not found' });
  const { nav, date } = req.body;
  if (!nav || typeof nav !== 'number' || nav <= 0) return res.status(400).json({ error: 'Invalid NAV value' });
  const entryDate = date || new Date().toISOString().split('T')[0];
  const entries = loadNavHistory(fundId);
  const existing = entries.findIndex(e => e.date === entryDate);
  if (existing >= 0) entries[existing] = { date: entryDate, nav, source: 'manual', updatedAt: new Date().toISOString() };
  else entries.push({ date: entryDate, nav, source: 'manual', updatedAt: new Date().toISOString() });
  entries.sort((a, b) => a.date.localeCompare(b.date));
  saveNavHistory(fundId, entries);
  res.json(entries);
});

// GET /api/holdings
app.get('/api/holdings', (req, res) => {
  const fundId = resolveFund(req);
  if (!fundId) return res.status(404).json({ error: 'Fund not found' });
  const config = loadConfig(fundId);
  const activeHoldings = Object.values(config.companies).filter(c => c.weight > 0);
  const newInvestments = Object.values(config.companies).filter(c => c.weight === 0 && c.note);
  res.json({
    asOf: config.filingBaseDate,
    holdings: activeHoldings.map(c => ({ name: c.name, weight: c.weight, sector: c.sector })),
    newInvestments: newInvestments.map(c => ({ name: c.name, status: c.note }))
  });
});

// GET /api/valuations
app.get('/api/valuations', (req, res) => {
  const fundId = resolveFund(req);
  if (!fundId) return res.status(404).json({ error: 'Fund not found' });
  const config = loadConfig(fundId);
  const valuations = loadValuations(fundId);
  const result = {};
  for (const [key, company] of Object.entries(config.companies)) {
    const vals = valuations.companies[key]?.valuations || [];
    const sorted = [...vals].sort((a, b) => b.date.localeCompare(a.date));
    result[key] = {
      name: company.name, weight: company.weight, sector: company.sector,
      totalFairValue: company.totalFairValue, valuationAtFiling: company.valuationAtFiling,
      corporateAction: company.corporateAction || null,
      latestValuation: selectNavValuation(key, company, sorted) || null,
      valuationHistory: sorted.slice(0, 10).map(v => ({
        ...v,
        audit: valuationAuditFor(key, company, v, vals)
      }))
    };
  }
  res.json({ companies: result, sources: valuations.sources, lastUpdated: valuations.lastUpdated });
});

// GET /api/valuation-audit
app.get('/api/valuation-audit', (req, res) => {
  const fundId = resolveFund(req);
  if (!fundId) return res.status(404).json({ error: 'Fund not found' });
  const config = loadConfig(fundId);
  const valuations = loadValuations(fundId);
  res.json(auditFundData(fundId, config, valuations));
});

// GET /api/agent-runs - read-only harness lifecycle logs
app.get('/api/agent-runs', (req, res) => {
  if (!existsSync(HARNESS_RUNS_DIR)) return res.json({ runs: [] });
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
  const runs = readdirSync(HARNESS_RUNS_DIR)
    .filter(name => name.endsWith('.json') && !name.endsWith('.stdout.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(name => {
      const run = readJSON(join(HARNESS_RUNS_DIR, name), null);
      if (!run) return null;
      return {
        runId: run.runId,
        intent: run.intent,
        status: run.status,
        events: (run.events || []).slice(-20)
      };
    })
    .filter(Boolean);
  res.json({ runs });
});

// GET /api/estimated-nav
app.get('/api/estimated-nav', (req, res) => {
  const fundId = resolveFund(req);
  if (!fundId) return res.status(404).json({ error: 'Fund not found' });
  res.json(computeEstimatedNAV(fundId));
});

// GET /api/estimated-nav-history
app.get('/api/estimated-nav-history', (req, res) => {
  const fundId = resolveFund(req);
  if (!fundId) return res.status(404).json({ error: 'Fund not found' });
  res.json({ fundId, points: computeEstimatedNAVHistory(fundId) });
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
  const funds = loadFunds();
  console.log(`\n[Scheduler] Running official NAV fetchers for ${funds.length} funds...`);

  for (const fund of funds) {
    console.log(`\n--- ${fund.name} (${fund.id}) ---`);
    await autoFetchNAV(fund.id);
  }
  console.log('\n[Scheduler] Official NAV fetchers complete. Valuation updates are handled by Claude Code harness.\n');
}

app.listen(PORT, '0.0.0.0', () => {
  const funds = loadFunds();
  console.log(`\n  NAV Monitor`);
  console.log(`  ───────────────────────────`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Funds: ${funds.map(f => f.id).join(', ')}`);
  console.log(`  Admin key: ${ADMIN_KEY}`);
  console.log(`  Press Ctrl+C to stop\n`);

  runAllFetchers();

  setInterval(() => { for (const f of loadFunds()) autoFetchNAV(f.id); }, 6 * 3600_000);
});
