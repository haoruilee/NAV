// Builder-only public/synthetic UI extraction. No settings or private data access.
import fs from 'node:fs';
import { chromium } from '/home/li/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';
const origin = process.env.NAV_QA_ORIGIN || 'http://127.0.0.1:4179';
if (!['http://127.0.0.1:4179', 'https://etfnav.org'].includes(origin)) throw Error('origin not allowed');
const browser = await chromium.launch({ executablePath: '/home/li/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args: ['--no-sandbox', '--disable-http2', '--disable-quic', '--no-proxy-server'] });
try {
 const page = await browser.newPage();
 await page.route(/googlesyndication|doubleclick|google-analytics/, r => r.fulfill({ body: '' }));
 const result = new Set();
 for (const route of ['/', '/look-through/', '/sources.html?fund=rvi&company=spacex']) {
  await page.goto(origin + route + (route.includes('?') ? '&' : '?') + 'lang=en', { waitUntil: 'networkidle' });
  const texts = await page.evaluate(() => {
   const out = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
   let n; while ((n = walker.nextNode())) if (n.parentElement && !n.parentElement.closest('script,style,code,pre,svg,canvas,.activity-details,[data-no-translate]')) out.push(n.data);
   return out;
  });
  for (const text of texts) result.add(text);
 }
 fs.writeFileSync(process.argv[2], JSON.stringify([...result]));
 console.log(`Collected ${result.size} public UI text nodes.`);
} finally { await browser.close(); }
