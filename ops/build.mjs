import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import cp from 'node:child_process';
import {renderSite,navLinks,ad} from '../content/pages.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=path.resolve(process.argv[3]||root+'/../dist'),snapshot=JSON.parse(fs.readFileSync(process.argv[2])),config=JSON.parse(fs.readFileSync(root+'/content/site-config.json'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const expected=JSON.parse(fs.readFileSync(root+'/../inputs.json'));for(const[p,h]of Object.entries(expected))if(sha(fs.readFileSync(root+'/'+p))!==h)throw Error('input_drift:'+p);
fs.mkdirSync(out+'/assets',{recursive:true});
for(const name of fs.readdirSync(root+'/public/assets'))fs.copyFileSync(root+'/public/assets/'+name,out+'/assets/'+name);
const combined=root+'/../combined.css';fs.writeFileSync(combined,fs.readFileSync(root+'/ui/nav-theme.css')+'\n'+fs.readFileSync(root+'/ui/research.css'));
const css=cp.spawnSync(process.execPath,['/home/li/nav-apple-ui-20261103/tools/node_modules/tailwindcss/lib/cli.js','-c','ui/tailwind.config.cjs','-i',combined,'-o',out+'/assets/tmp.css','--minify'],{cwd:root,encoding:'utf8'});if(css.status)throw Error(css.stderr);
function asset(name,ext,bytes){const file=name+'.'+sha(bytes).slice(0,12)+'.'+ext;fs.writeFileSync(out+'/assets/'+file,bytes);return'/assets/'+file;}
const cssPath=asset('nav-research','css',fs.readFileSync(out+'/assets/tmp.css'));fs.unlinkSync(out+'/assets/tmp.css');
const math=asset('research-math','js',fs.readFileSync(root+'/content/research-math.mjs'));
const app=asset('research-app','js',fs.readFileSync(root+'/content/research-app.mjs','utf8').replace('./research-math.js','.'+math.replace('/assets','')));
const ads=asset('publisher','js',fs.readFileSync(root+'/content/ads.js'));
fs.writeFileSync(out+'/assets/publisher-config.json',JSON.stringify({adsense:config.adsense}));
// Original native brand graphic generated and visually accepted on the builder.
const cover='/assets/nav-research-cover.e18c7a3e9c42.png';
if(sha(fs.readFileSync(out+cover)).slice(0,12)!=='e18c7a3e9c42')throw Error('brand_asset_drift');
const {pages,featured,footer,records}=renderSite(snapshot,{css:cssPath,app,ads,cover},config);
for(const[route,page]of pages){const file=out+route+'index.html';fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,page.html);}
for(const name of ['index.html','sources.html']){let html=fs.readFileSync(root+'/content/templates/'+name,'utf8').replace(/\/assets\/nav-apple\.[a-f0-9]+\.css/g,cssPath);
 if(name==='index.html'){
 html=html.replace(/\s*<!-- Structured Data: FinancialProduct -->[\s\S]*?<\/script>/,'');
 html=html.replace('</a><button type="button" class="method-button"','</a><nav class="primary-nav" aria-label="Research navigation">'+navLinks()+'</nav><button type="button" class="method-button"');
 html=html.replace('</main>',ad('dashboard_banner')+featured+ad('research_footer')+'</main>'+footer);
 html=html.replace(/<title>[\s\S]*?<\/title>/,'<title>Fund NAV, Holdings Look-through & Research | NAV Monitor</title>');
 html=html.replace(/<meta name="description" content="[^"]*">/,'<meta name="description" content="Explore dated fund NAV, disclosed company holdings, portfolio overlap, valuation methods and original source-backed research guides.">');
 html=html.replace(/<meta property="og:title" content="[^"]*">/,'<meta property="og:title" content="NAV Monitor — Look beyond the quote">').replace(/<meta property="og:description" content="[^"]*">/,'<meta property="og:description" content="Fund NAV, holdings look-through and transparent valuation research.">');
 html=html.replace(/<meta property="og:image"[^>]*>/g,'').replace(/<meta name="twitter:image"[^>]*>/g,'');
 html=html.replace('</head>',`<meta property="og:image" content="${config.siteURL}${cover}"><meta name="twitter:image" content="${config.siteURL}${cover}"><link rel="alternate" type="application/rss+xml" title="NAV Monitor source calendar" href="/feed.xml"><script defer src="${ads}"></script></head>`);
 }else{html=html.replace(/<meta name="robots"[^>]*>/g,'').replace('</head>','<meta name="robots" content="noindex,follow"></head>');}
 fs.writeFileSync(out+'/'+name,html);
}
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const indexed=[{route:'/',modified:'2026-11-03'},...[...pages.values()].filter(p=>p.index)];
fs.writeFileSync(out+'/sitemap.xml','<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+indexed.map(p=>`<url><loc>${config.siteURL}${p.route}</loc></url>`).join('')+'</urlset>');
fs.writeFileSync(out+'/robots.txt','User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: '+config.siteURL+'/sitemap.xml\n');
const publisher=config.adsense?.clientId;
fs.writeFileSync(out+'/ads.txt', /^ca-pub-\d{16}$/.test(publisher||'') ? `google.com, ${publisher.slice(3)}, DIRECT, f08c47fec0942fa0\n` : '# Advertising is disabled. Add the verified publisher entry only after account and consent setup.\n');
fs.writeFileSync(out+'/feed.xml','<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NAV Monitor source calendar</title><link>'+config.siteURL+'/news/</link><description>Dated source records, not a real-time news wire.</description>'+records.map(r=>`<item><title>${xml(r.title)}</title><link>${xml(r.url)}</link><guid isPermaLink="false">${xml(r.id)}</guid><pubDate>${new Date(r.date+'T12:00:00Z').toUTCString()}</pubDate><description>${xml(r.type+' · '+r.companyName+' · Event date '+r.date+'. A source record is not a fund NAV change.')}</description></item>`).join('')+'</channel></rss>');
const files={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else files[path.relative(out,p)]=sha(fs.readFileSync(p));}}walk(out);
fs.writeFileSync(out+'/../manifest.json',JSON.stringify({inputHashes:expected,files,records:records.length,indexedPages:indexed.length,pages:pages.size,retrievedAt:snapshot.retrievedAt},null,2));
console.log(JSON.stringify({pages:pages.size,indexed:indexed.length,sourceRecords:records.length,files:Object.keys(files).length}));
