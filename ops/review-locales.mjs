import fs from 'node:fs';
import assert from 'node:assert/strict';
const file = process.argv[2];
const catalog = JSON.parse(fs.readFileSync(file));
const corrections = [];
const glossary = JSON.parse(fs.readFileSync(new URL('../content/localization-glossary.json', import.meta.url)));
for (const [key, translations] of Object.entries(glossary)) for (const [lang, value] of Object.entries(translations)) catalog[lang][key] = value;
const moneyHeadline = 'Anthropic raises ${{0}} billion in Series G funding at ${{1}} billion post-money valuation - Anthropic';
if (catalog.zh[moneyHeadline]?.includes('}}0亿')) {
  catalog.zh[moneyHeadline] = 'Anthropic 完成 {{0}} 十亿美元 G 轮融资，投后估值为 {{1}} 十亿美元 - Anthropic';
  corrections.push({ language: 'zh', key: moneyHeadline, reason: 'preserve billion scale without changing numeric placeholders' });
}
for (const key of Object.keys(catalog.zh)) {
  if (!key.startsWith('Suppose the hypothetical ${{0}} NAV describes March {{1}}')) continue;
  const replacements = { zh: ['{{1}} 年 3 月', '三月 {{1}} 日'], es: ['marzo de {{1}}', 'el {{1}} de marzo'], hi: ['मार्च {{1}}', '{{1}} मार्च'], ar: ['شهر مارس {{1}}', 'يوم {{1}} من مارس'] };
  for (const [lang, [before, after]] of Object.entries(replacements)) {
    if (catalog[lang][key].includes(before)) {
      catalog[lang][key] = catalog[lang][key].replace(before, after);
      corrections.push({ language: lang, key, reason: 'March 31 is a day of month, not a year' });
    }
  }
}
if (catalog.ar['RONB NAV & holdings']?.includes('RVI')) {
  catalog.ar['RONB NAV & holdings'] = 'صافي قيمة الأصول (NAV) وحيازات RONB';
  corrections.push({ language: 'ar', key: 'RONB NAV & holdings', reason: 'preserve the RONB ticker' });
}
for (const lang of ['zh', 'hi', 'es', 'ar']) for (const key of Object.keys(catalog[lang])) {
  if (key.startsWith('RONB ') && !catalog[lang][key].includes('RONB') && catalog[lang][key].includes('RVI')) {
    catalog[lang][key] = catalog[lang][key].replaceAll('RVI', 'RONB');
    corrections.push({ language: lang, key, reason: 'preserve the RONB ticker' });
  }
}
// Reviewed terminology correction: "sankalpana" means concept, not valuation.
for (const [key, value] of Object.entries(catalog.hi)) {
  if (/valuation/i.test(key) && value.includes('संकल्पना')) {
    catalog.hi[key] = value.replaceAll('संकल्पना', 'मूल्यांकन');
    corrections.push({ language: 'hi', key, reason: 'financial valuation terminology' });
  }
}
for (const key of Object.keys(catalog.zh)) {
  if (/quote/i.test(key)) {
    catalog.hi[key] = catalog.hi[key].replaceAll('उद्धरण', 'भाव');
    catalog.ar[key] = catalog.ar[key].replaceAll('الاقتباس', 'عرض السعر').replaceAll('اقتباس', 'عرض سعر').replaceAll('سعر الحشة', 'سعر الحصة');
  }
  catalog.ar[key] = catalog.ar[key].replaceAll('صافي القيمة الأصلية المقدر', 'صافي قيمة الأصول التقديري');
  if (key.startsWith('Suppose the hypothetical')) catalog.zh[key] = catalog.zh[key].replace('假设假设性的', '假设示例中的').replace('描述的是 三月', '对应三月').replace('6 月', '六月').replace('每日核查来源并不会使该融资日期提前', '每日核查来源不会改变该融资的发生日期');
  if (key.endsWith('The absence of a quote is not a zero-dollar share price.')) catalog.zh[key] = catalog.zh[key].replace('0美元', '零美元');
}
const keys = Object.keys(catalog.zh).sort(), warnings = [];
for (const [lang, values] of Object.entries(catalog)) {
  assert.deepEqual(Object.keys(values).sort(), keys);
  for (const [key, value] of Object.entries(values)) {
    assert.equal(typeof value, 'string'); assert(value.trim());
    const slots = text => [...text.matchAll(/\{\{\d+\}\}/g)].map(m => m[0]).sort();
    assert.deepEqual(slots(value), slots(key), `${lang}: ${key}`);
    if (/\d/.test(value.replace(/\{\{\d+\}\}/g, ''))) warnings.push({ lang, key, issue: 'additional literal digits', value });
    for (const name of ['NAV', 'KiT', 'SEC', 'OHLCV', 'RankIC', 'RVI', 'RONB', 'USVC', 'DXYZ', 'AGIX', 'VCX', 'SSSS', 'XOVR', 'NASA', 'Anthropic', 'Crusoe', 'Legora', 'Airwallex', 'Databricks', 'Revolut', 'Vercel', 'ElevenLabs', 'Stripe']) {
      if (new RegExp(`\\b${name}\\b`).test(key) && !value.includes(name)) warnings.push({ lang, key, issue: `missing identifier ${name}`, value });
    }
  }
}
fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
fs.writeFileSync(process.argv[3], JSON.stringify({ keys: keys.length, corrections, warnings }, null, 2));
console.log(JSON.stringify({ keys: keys.length, corrections: corrections.length, warnings: warnings.length }));
