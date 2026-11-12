import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '/home/li/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';

test('local dictionaries preserve numbers, changing source text, attributes, titles and local inputs', async () => {
  const browser = await chromium.launch({ executablePath: '/home/li/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const script = fs.readFileSync(new URL('../content/localization.js', import.meta.url), 'utf8');
    const values = { 'Official NAV': '官方 NAV', 'Estimated NAV {{0}}': '估算 NAV {{0}}', 'Sources: {{0}}': '来源：{{0}}', 'Research': '研究', 'Company not found': '未找到公司' };
    const catalog = { zh: values, ar: values, hi: values, es: Object.fromEntries(Object.keys(values).map(k => [k, 'ES ' + k])) };
    const requests = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url()); requests.push(url.pathname);
      if (url.pathname === '/localization.js') return route.fulfill({ body: script, contentType: 'application/javascript' });
      if (url.pathname === '/catalog.json') return route.fulfill({ json: catalog });
      return route.fulfill({ body: '<!doctype html><html><head><title>Research</title><script defer data-nav-i18n data-catalog="/catalog.json" src="/localization.js"></script></head><body><header></header><p id="text">Official NAV</p><input id="input" placeholder="Research" value="123.45"><pre>Official NAV</pre></body></html>', contentType: 'text/html' });
    });
    await page.goto('http://nav.test/?lang=zh');
    await page.waitForFunction(() => window.navLocalization?.language() === 'zh');
    assert.equal(await page.locator('#text').textContent(), values['Official NAV']);
    assert.equal(await page.title(), values.Research);
    assert.equal(await page.locator('#input').getAttribute('placeholder'), values.Research);
    assert.equal(await page.locator('#input').inputValue(), '123.45');
    assert.equal(await page.locator('pre').textContent(), 'Official NAV');
    assert.equal(await page.evaluate(() => window.navLocalization.translate('Estimated NAV $123.45')), '估算 NAV $123.45');
    assert.equal(await page.evaluate(() => window.navLocalization.translate('Sources: SEC EDGAR, example.org')), '来源：SEC EDGAR, example.org');
    await page.evaluate(() => { document.getElementById('text').textContent = 'Company not found'; document.title = 'Official NAV'; });
    await page.waitForFunction(() => document.title === '官方 NAV');
    await page.locator('#nav-language').selectOption('es');
    assert.equal(await page.locator('#text').textContent(), 'ES Company not found');
    await page.locator('#nav-language').selectOption('en');
    assert.equal(await page.locator('#text').textContent(), 'Company not found');
    assert.equal(await page.title(), 'Official NAV');
    assert.equal(await page.locator('#input').getAttribute('placeholder'), 'Research');
    await page.locator('#nav-language').selectOption('ar');
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    await page.goto('http://nav.test/next');
    await page.waitForFunction(() => window.navLocalization?.language() === 'ar');
    assert(requests.every(path => ['/', '/next', '/localization.js', '/catalog.json'].includes(path)), JSON.stringify(requests));
  } finally { await browser.close(); }
});
