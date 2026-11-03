import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const VALUATION_AUDIT_VERSION = 1;

const TRUSTED_MEDIA = [
  'Reuters',
  'Bloomberg.com',
  'CNBC',
  'The Information',
  'Wall Street Journal',
  'WSJ',
  'Financial Times',
  'TechCrunch',
  'Crunchbase News'
];

const PRIMARY_WIRE = ['Business Wire', 'PR Newswire', 'GlobeNewswire'];

function readJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function extractPublisher(entry) {
  if (entry.publisher) return entry.publisher;
  const label = entry.headline || entry.label || '';
  const match = label.match(/\s-\s([^-]+)$/);
  return match ? match[1].trim() : null;
}

function isSameValue(a, b) {
  if (!a || !b) return false;
  const spread = Math.abs(a - b) / Math.max(a, b);
  return spread <= 0.02;
}

function companyAliases(company) {
  return [company.name, company.cbInsightsName, ...(company.aliases || [])]
    .filter(Boolean)
    .map(v => String(v).toLowerCase());
}

function sourceClass(entry, company) {
  if (entry.source === 'sec-edgar') return 'regulatory';
  if (entry.source === 'formD') return 'regulatory-offering';
  if (entry.source === 'cbinsights') return 'aggregator';

  const publisher = extractPublisher(entry);
  if (publisher) {
    const publisherLower = publisher.toLowerCase();
    if (companyAliases(company).some(alias => publisherLower.includes(alias))) return 'company-official';
    if (PRIMARY_WIRE.some(name => publisherLower.includes(name.toLowerCase()))) return 'primary-wire';
    if (TRUSTED_MEDIA.some(name => publisherLower.includes(name.toLowerCase()))) return 'trusted-media';
  }

  if (entry.url && /sec\.gov/i.test(entry.url)) return 'regulatory';
  return entry.source === 'news' ? 'unverified-news' : 'unknown';
}

function subjectMatchesCompany(entry, company) {
  if (entry.source === 'cbinsights') return true;
  const text = `${entry.headline || ''} ${entry.label || ''}`.toLowerCase();
  if (!text) return true;
  return companyAliases(company).some(alias => text.includes(alias));
}

function isCombinedEntityHeadline(entry, key) {
  const text = `${entry.headline || ''} ${entry.label || ''}`.toLowerCase();
  if (!text) return false;
  if (key === 'xai' && /spacex/.test(text) && /(combine|combines|combined|merger|merge|acquire|acquisition)/.test(text)) {
    return true;
  }
  return /(combined entity|post-merger|merged company)/.test(text);
}

export function auditValuationEntry({ key, company, entry, peers = [], now = new Date() }) {
  const issues = [];
  const publisher = extractPublisher(entry);
  const klass = sourceClass(entry, company);
  const ageDays = entry.date ? Math.floor((now.getTime() - new Date(entry.date).getTime()) / 86400000) : null;

  if (!subjectMatchesCompany(entry, company)) issues.push('subject_mismatch');
  if (isCombinedEntityHeadline(entry, key)) issues.push('combined_entity_not_standalone_valuation');
  if (klass === 'unverified-news') issues.push('non_official_news_source');
  if (klass === 'aggregator') issues.push('aggregator_not_primary_source');
  if (klass === 'regulatory-offering') issues.push('form_d_offering_amount_is_not_company_valuation');
  if (ageDays !== null && ageDays > 180) issues.push('stale_valuation');

  const independentPeers = peers.filter(peer => {
    if (peer === entry) return false;
    if (!isSameValue(peer.value, entry.value)) return false;
    const peerPublisher = extractPublisher(peer) || peer.source;
    const thisPublisher = publisher || entry.source;
    return peerPublisher && thisPublisher && peerPublisher !== thisPublisher;
  });

  const crossVerified = independentPeers.length > 0;
  if (!crossVerified && !['company-official', 'regulatory', 'primary-wire'].includes(klass)) {
    issues.push('not_cross_verified');
  }

  if (company.valuationAtFiling && entry.value > company.valuationAtFiling * 5) {
    issues.push('large_jump_vs_filing_baseline');
  }

  let trustLevel = 'low';
  if (['company-official', 'regulatory', 'primary-wire'].includes(klass)) trustLevel = crossVerified ? 'high' : 'medium';
  else if (klass === 'trusted-media' && crossVerified) trustLevel = 'medium';
  else if (klass === 'aggregator' && crossVerified) trustLevel = 'medium';

  const hardBlocks = [
    'subject_mismatch',
    'combined_entity_not_standalone_valuation',
    'form_d_offering_amount_is_not_company_valuation'
  ];
  const useForNav = !issues.some(issue => hardBlocks.includes(issue)) &&
    !(issues.includes('not_cross_verified') && issues.includes('non_official_news_source')) &&
    !(issues.includes('large_jump_vs_filing_baseline') && !['company-official', 'regulatory', 'primary-wire', 'aggregator'].includes(klass)) &&
    !(issues.includes('stale_valuation') && !crossVerified);

  return {
    version: VALUATION_AUDIT_VERSION,
    checkedAt: now.toISOString(),
    sourceClass: klass,
    publisher,
    ageDays,
    crossVerified,
    crossVerificationCount: independentPeers.length,
    trustLevel,
    useForNav,
    issues
  };
}

export function auditFundData(fundId, config, valuations, now = new Date()) {
  const companies = {};
  let blocked = 0;
  let warnings = 0;

  for (const [key, company] of Object.entries(config.companies || {})) {
    const entries = valuations.companies?.[key]?.valuations || [];
    companies[key] = { name: company.name, entries: [] };

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const audit = auditValuationEntry({ key, company, entry, peers: entries, now });
      companies[key].entries.push({
        index,
        value: entry.value,
        date: entry.date,
        source: entry.source,
        label: entry.label || entry.headline || null,
        audit
      });
      if (!audit.useForNav) blocked++;
      else if (audit.trustLevel !== 'high') warnings++;
    }
  }

  return {
    version: VALUATION_AUDIT_VERSION,
    fundId,
    checkedAt: now.toISOString(),
    summary: { blocked, warnings },
    companies
  };
}

export function applyDeterministicAuditToValuations(config, valuations, now = new Date()) {
  for (const [key, company] of Object.entries(config.companies || {})) {
    const entries = valuations.companies?.[key]?.valuations || [];
    for (const entry of entries) {
      entry.audit = auditValuationEntry({ key, company, entry, peers: entries, now });
    }
  }
  valuations.audit = {
    version: VALUATION_AUDIT_VERSION,
    checkedAt: now.toISOString(),
    mode: 'deterministic'
  };
  return valuations;
}

export function loadFundData(repoRoot, fundId) {
  const configPath = join(repoRoot, 'data', fundId, 'company-config.json');
  const valuationsPath = join(repoRoot, 'data', fundId, 'valuations.json');
  return {
    configPath,
    valuationsPath,
    config: readJSON(configPath, { companies: {} }),
    valuations: readJSON(valuationsPath, { sources: {}, companies: {} })
  };
}

export function writeFundValuations(path, valuations) {
  writeJSON(path, valuations);
}
