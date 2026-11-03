import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractOfficialNav, refreshOfficialNav } from './official-nav-refresh.mjs';
test('dated NAV disclosure supports common shares and parenthetical wording',()=>{
 const html='<p>The NAV per common share on January 31, 2026 (the last reported date) was $12.34.</p>';
 const result=extractOfficialNav(html,'2026-02-10','2026-03-01');assert.equal(result.length,1);assert.equal(result[0].date,'2026-01-31');assert.equal(result[0].nav,12.34);
 assert.equal(extractOfficialNav('Net asset value per share as of January 31, 2026 was $14.25','2026-02-10','2026-03-01')[0].nav,14.25);
});
test('market prices, hypothetical NAV, future dates and conflicting values never enter NAV history',()=>{
 for(const text of ['The market price per share on January 31, 2026 was $12.34','NAV per common share on January 31, 2026 will be $12.34','NAV per common share on January 31, 2099 was $12.34','NAV per common share on January 31, 2026 was $12.34. NAV per share on January 31, 2026 was $15.67'])assert.equal(extractOfficialNav(text,'2026-02-10','2026-03-01').length,0);
});
test('SEC refresh finds relevant filing after unrelated recent documents, persists once, and caches',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nav-sec-'));mkdirSync(join(root,'data/rvi'),{recursive:true});writeFileSync(join(root,'data/rvi/nav-history.json'),'[]');
 const list={filings:{recent:{form:[...Array(12).fill('4'),'N-2'],accessionNumber:[...Array(12).fill('000-0'),'000-1'],primaryDocument:[...Array(12).fill('form4.htm'),'fund.htm'],filingDate:[...Array(12).fill('2026-02-11'),'2026-02-10']}}};let filings=0;
 const fake=async url=>{if(url.includes('/submissions/'))return{ok:true,json:async()=>list};filings++;return{ok:true,text:async()=>'<p>NAV per common share on January 31, 2026 was $12.34.</p>'};};
 try{
  const funds=[{id:'rvi',cik:'0000000001'},{id:'none'}];let result=await refreshOfficialNav(root,funds,'fixture1',fake);assert.equal(result[0].added,1);assert.equal(result[1].status,'unconfigured_cik');assert.equal(JSON.parse(readFileSync(join(root,'data/rvi/nav-history.json'))).length,1);
  result=await refreshOfficialNav(root,funds,'fixture2',fake);assert.equal(result[0].added,0);assert.equal(filings,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
