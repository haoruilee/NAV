import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
const forms=new Set(['N-2','N-2/A','N-CSR','N-CSRS','424B1','424B3','10-Q','10-K']);
const read=(path,fallback)=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return fallback;}};
function write(path,data){mkdirSync(dirname(path),{recursive:true});const temp=`${path}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(data,null,2));renameSync(temp,path);}
export function extractOfficialNav(html,filingDate,today=new Date().toISOString().slice(0,10)){
 const text=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_,s)=>String.fromCodePoint(s[0].toLowerCase()==='x'?parseInt(s.slice(1),16):Number(s))).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ');
 const month='(?:January|February|March|April|May|June|July|August|September|October|November|December)';
 const pattern=new RegExp(`(?:net asset value|NAV)\\s+per\\s+(?:common\\s+)?share\\s+(?:on|as of|at)\\s+(${month}\\s+\\d{1,2},?\\s+\\d{4})(?:\\s*\\([^)]{0,240}\\))?\\s+(?:was|is|stood at)\\s*\\$\\s*([0-9]+(?:\\.[0-9]+)?)`,'gi');
 const records=[];
 for(const m of text.matchAll(pattern)){
  const parsed=new Date(`${m[1]} UTC`);if(Number.isNaN(parsed.getTime()))continue;const date=parsed.toISOString().slice(0,10),nav=Number(m[2]);
  if(date>filingDate||filingDate>today||nav<=0||nav>=500)continue;
  if(!records.some(x=>x.date===date&&x.nav===nav))records.push({date,nav,quote:m[0]});
 }
 // Conflicting disclosures for the same date require review, never guess.
 return records.filter(r=>!records.some(x=>x.date===r.date&&x.nav!==r.nav));
}
export async function refreshOfficialNav(root,funds,runId,fetcher=fetch){
 const statePath=join(root,'var/agent-harness/state/official-nav-fetch.json');const state=read(statePath,{});const outcomes=[];
 const get=async url=>{const res=await fetcher(url,{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'NAVMonitor admin@nav-monitor.app'}});if(!res.ok)throw new Error(`HTTP_${res.status}`);return res;};
 for(const fund of funds){
  if(!fund.cik){outcomes.push({fundId:fund.id,status:'unconfigured_cik',added:0});continue;}
  try{
   const data=await(await get(`https://data.sec.gov/submissions/CIK${fund.cik}.json`)).json();const recent=data.filings?.recent||{};let scanned=0,added=0,cached=0,failures=0;
   for(let i=0;i<(recent.form||[]).length&&scanned<3;i++){
    if(!forms.has(recent.form[i]))continue;scanned++;
    const accession=recent.accessionNumber[i],document=recent.primaryDocument[i];
    if(!/^[0-9-]+$/.test(accession)||!document||/[\\/]/.test(document))continue;
    const key=`v1/${fund.cik}/${accession}/${document}`;
    if(state[key]){cached++;continue;}
    const url=`https://www.sec.gov/Archives/edgar/data/${Number(fund.cik)}/${accession.replaceAll('-','')}/${document}`;
    try{
     const html=await(await get(url)).text();const records=extractOfficialNav(html,recent.filingDate[i]);const path=join(root,'data',fund.id,'nav-history.json');const current=read(path,[]);let changes=0;
     for(const record of records){
      const existing=current.find(x=>x.date===record.date);if(existing)continue;
      current.push({date:record.date,nav:record.nav,source:'sec-edgar',filing:accession,sourceUrl:url,evidenceQuote:record.quote,updatedAt:new Date().toISOString(),agentRunId:runId});changes++;
     }
     if(changes){write(join(root,'var/agent-harness/backups',runId,`${fund.id}-nav-history.json`),read(path,[]));current.sort((a,b)=>a.date.localeCompare(b.date));write(path,current);added+=changes;}
     state[key]={checkedAt:new Date().toISOString(),matched:records.length,added:changes};
    }catch{failures++;}
   }
   outcomes.push({fundId:fund.id,status:failures?'partial':'ok',scanned,cached,added,failures});
  }catch(error){outcomes.push({fundId:fund.id,status:'error',error:error.message,added:0});}
 }
 write(statePath,state);return outcomes;
}
