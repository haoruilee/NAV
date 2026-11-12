import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from '/home/li/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';
const origin = process.env.NAV_QA_ORIGIN || 'http://127.0.0.1:4179';
const build = process.argv[2];
const out = process.argv[3] || build + '/qa-i18n';
fs.mkdirSync(out, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(build + '/manifest.json'));
const catalog = JSON.parse(fs.readFileSync(build + '/source/content/locales.json'));
const languages = ['en', 'zh', 'hi', 'es', 'ar'];
const keys = Object.keys(catalog.zh);
for (const lang of languages.slice(1)) {
  assert.deepEqual(Object.keys(catalog[lang]).sort(), [...keys].sort());
  for (const [key, value] of Object.entries(catalog[lang])) {
    assert.equal(typeof value, 'string'); assert(value.trim());
    assert.deepEqual([...value.matchAll(/\{\{\d+\}\}/g)].map(m=>m[0]).sort(), [...key.matchAll(/\{\{\d+\}\}/g)].map(m=>m[0]).sort(), key);
  }
}
const routes = Object.keys(manifest.files).filter(f => f.endsWith('.html')).map(f => '/' + f.replace(/index\.html$/, ''));
const browser = await chromium.launch({ executablePath: '/home/li/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-http2', '--disable-quic', '--no-proxy-server'] });
const report = { catalogKeys: keys.length, pages: [], layouts: [], errors: [], missing: {} };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Existing owner-authorized ad script is preserved, but QA never loads/clicks ads.
  await context.route(/googlesyndication|doubleclick|google-analytics/, r => r.fulfill({ body: '', contentType: 'application/javascript' }));
  const page = await context.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  async function visit(route, lang) {
    const response = await page.goto(origin + route + (route.includes('?') ? '&' : '?') + 'lang=' + lang, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, route);
    assert.equal(await page.locator('h1').count(), 1, route);
    await page.waitForFunction(lang => window.navLocalization?.language() === lang, lang);
    assert.equal(await page.locator('html').getAttribute('lang'), lang === 'zh' ? 'zh-CN' : lang);
    assert.equal(await page.locator('html').getAttribute('dir'), lang === 'ar' ? 'rtl' : 'ltr');
    assert.equal(await page.locator('#nav-language').count(), 1, route);
  }
  for (const lang of languages) {
    for (const route of routes) {
      await visit(route, lang);
      report.pages.push({ lang, route });
      if (lang === 'zh') {
        const missing = await page.evaluate(() => {
          const list = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n; while ((n = walker.nextNode())) {
            const e = n.parentElement;
            if (!e || e.closest('script,style,code,pre,svg,canvas,[data-no-translate],[translate=no],.activity-details') || !e.getClientRects().length) continue;
            const text = n.data.trim();
            if (/[A-Za-z]{3} [A-Za-z]{3}/.test(text) && !/[\u4e00-\u9fff]/.test(text)) list.push(text);
          }
          return [...new Set(list)];
        });
        if (missing.length) report.missing[route] = missing;
      }
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ['/', '/look-through/', '/insights/estimated-nav-model/', '/news/', '/sources.html?fund=rvi&company=atlas']) {
        await visit(route, lang);
        await page.waitForTimeout(150);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'overflow: ' + lang + width + route);
        if (lang === 'ar' && route === '/') assert.equal(await page.locator('#premium-value').evaluate(e => getComputedStyle(e).direction), 'ltr');
        report.layouts.push({ lang, width, route });
        if (route === '/' || route === '/look-through/') await page.screenshot({ path: `${out}/${lang}-${width}-${route === '/' ? 'home' : 'calculator'}.png`, fullPage: true, animations: 'disabled' });
        if (route === '/') await page.screenshot({ path: `${out}/${lang}-${width}-top.png`, animations: 'disabled' });
      }
    }
  }
  await visit('/', 'zh');
  await page.evaluate(() => {
    const e = document.createElement('p'); e.id = 'i18n-test'; e.textContent = 'Estimated NAV'; document.body.append(e);
  });
  await page.waitForFunction(() => document.getElementById('i18n-test').textContent !== 'Estimated NAV');
  await page.locator('#nav-language').selectOption('es');
  assert.equal(await page.locator('#i18n-test').textContent(), catalog.es['Estimated NAV']);
  await page.evaluate(() => document.getElementById('i18n-test').textContent = 'Official NAV');
  await page.waitForFunction(() => document.getElementById('i18n-test').textContent !== 'Official NAV');
  await page.locator('#nav-language').selectOption('en');
  assert.equal(await page.locator('#i18n-test').textContent(), 'Official NAV');
  await page.locator('#nav-language').selectOption('ar');
  const number = await page.evaluate(() => window.navLocalization.translate('Estimated NAV $123.45'));
  assert(number.includes('123.45'), number);
  await page.goto(origin + '/funds/');
  await page.waitForFunction(() => window.navLocalization?.language() === 'ar');
  await visit('/look-through/', 'es');
  const calls = []; page.on('request', request => calls.push(request.url()));
  await page.locator('#equal-covered').click();
  assert.equal(await page.locator('#allocation-error').textContent(), '');
  assert(await page.locator('#issuer-results tr').count() > 0);
  await page.locator('#reset-allocations').click();
  await page.waitForFunction(() => !document.getElementById('allocation-error').textContent.includes('Allocations must'));
  assert(await page.locator('#exposure-output').isHidden());
  assert(!calls.some(url => url.includes('/api/') || url.includes('allocation=')), 'calculator submitted user input');
  assert.deepEqual(report.errors, []);
  if (origin.startsWith('http://127.0.0.1')) {
    const links = new Set();
    for (const file of Object.keys(manifest.files).filter(f => f.endsWith('.html'))) {
      const html = fs.readFileSync(build + '/dist/' + file, 'utf8');
      for (const match of html.matchAll(/href="(\/[^"#]*)"/g)) links.add(match[1].replaceAll('&amp;', '&'));
    }
    for (const route of links) assert.equal((await page.request.get(origin + route)).status(), 200, route);
    report.internalLinks = links.size;
  }
  fs.writeFileSync(out + '/acceptance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, pages: report.pages.length, layouts: report.layouts.length, missing: Object.keys(report.missing).length }));
} finally {
  fs.writeFileSync(out + '/acceptance.json', JSON.stringify(report, null, 2));
  await browser.close();
}
