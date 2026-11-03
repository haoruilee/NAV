import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const source=dirname(fileURLToPath(import.meta.url));
test('synthetic daily flow: dry-run immutable, validated update visible, repeat skips model, provider exit fails promptly',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nav-flow-'));const bin=join(root,'bin');mkdirSync(bin);
 const data=join(root,'data/rvi');mkdirSync(data,{recursive:true});
 writeFileSync(join(root,'data/funds.json'),JSON.stringify([{id:'rvi'}]));
 writeFileSync(join(data,'company-config.json'),JSON.stringify({companies:{openai:{name:'OpenAI',newsQuery:'OpenAI funding',valuationAtFiling:1e9}}}));
 const initial=JSON.stringify({lastUpdated:'2026-01-01',companies:{openai:{valuations:[]}}});const valuations=join(data,'valuations.json');writeFileSync(valuations,initial);
 const settings=join(root,'settings.json');writeFileSync(settings,'{}');
 const preload=join(root,'fetch-fixture.mjs');
 writeFileSync(preload,`globalThis.fetch=async(url)=>{if(String(url).includes('news.google.com'))return new Response('<rss><item><title>OpenAI funding</title><link>https://openai.com/fixture</link><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate><source>OpenAI</source></item></rss>');if(String(url)==='https://openai.com/fixture')return new Response('<p>OpenAI today announced a standalone post-money valuation of $1 billion.</p>');throw new Error('Unexpected network request in synthetic fixture');};`);
 const mock=`#!${process.execPath}
import{readFileSync,readdirSync,writeFileSync,appendFileSync}from'node:fs';import{join}from'node:path';
if(process.argv.includes('new-session')){
 const root=process.env.NAV_MONITOR_ROOT;appendFileSync(join(root,'launches'),'1');if(process.env.FIXTURE_EXIT==='1')process.exit(0);
 const dir=join(root,'var/agent-harness/context');const text=readFileSync(join(dir,readdirSync(dir).sort().at(-1)),'utf8');
 const runId=text.match(/Run id: (.+)/)[1],path=text.match(/Required outbox path: (.+)/)[1];
 writeFileSync(path,JSON.stringify({runId,intent:'nav_valuation_audit',ready:true,riskLevel:'low',environmentUnderstanding:{dev:'fixture',runtime:'fixture',data:'fixture'},decisions:[{fundId:'rvi',companyKey:'openai',action:'update',confidence:.95,evidenceUrls:['https://openai.com/fixture'],newValuation:{value:1e9,date:'2026-01-01',source:'news',headline:'OpenAI announces new funding valuation',url:'https://openai.com/fixture',evidenceQuote:'OpenAI today announced a standalone post-money valuation of $1 billion.'}}]}));
}else if(process.argv.includes('has-session'))process.exit(1);
`;
 writeFileSync(join(bin,'tmux'),mock,{mode:0o755});
 const invoke=async(args=[],extra={})=>new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['--import',preload,join(source,'nav-valuation-audit.mjs'),...args],{cwd:root,env:{PATH:`${bin}:/usr/bin:/bin`,HOME:root,NAV_MONITOR_ROOT:root,NAV_CLAUDE_SETTINGS:settings,...extra}});
  let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);p.on('error',reject);p.on('exit',code=>resolve({code,output}));
 });
 try{
  let r=await invoke(['--no-apply']);assert.equal(r.code,0,r.output);assert.match(r.output,/dry_run/);assert.equal(readFileSync(valuations,'utf8'),initial);
  r=await invoke();assert.equal(r.code,0,r.output);assert.match(r.output,/updated/);assert.equal(JSON.parse(readFileSync(valuations)).companies.openai.valuations.length,1);
  const after=readFileSync(valuations,'utf8');r=await invoke();assert.equal(r.code,0,r.output);assert.match(r.output,/no_new_evidence/);assert.equal(readFileSync(valuations,'utf8'),after);assert.equal(readFileSync(join(root,'launches'),'utf8'),'11');
  rmSync(join(root,'var/agent-harness/state/evidence-checkpoint.json'));
  const start=Date.now();r=await invoke([],{FIXTURE_EXIT:'1'});assert.equal(r.code,1,r.output);assert.ok(Date.now()-start<5000);assert.equal(readFileSync(valuations,'utf8'),after);
  const runs=readdirSync(join(root,'var/agent-harness/runs')).filter(p=>p.endsWith('.json')).map(p=>JSON.parse(readFileSync(join(root,'var/agent-harness/runs',p))));assert.ok(runs.some(r=>r.status==='failed'&&r.events.some(e=>e.metadata.error==='provider_exited_without_outbox')));
 }finally{rmSync(root,{recursive:true,force:true});}
});
