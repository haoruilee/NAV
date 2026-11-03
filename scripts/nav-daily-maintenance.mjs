import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { collectNewsCandidates } from './nav-valuation-audit.mjs';
const root=process.env.NAV_MONITOR_ROOT||join(dirname(fileURLToPath(import.meta.url)),'..');
export async function dailyMaintenance(directory,collector=collectNewsCandidates,execute=executeChild){
 const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-daily-maintenance';
 const harness=join(directory,'var/agent-harness');mkdirSync(join(harness,'runs'),{recursive:true});mkdirSync(join(harness,'context'),{recursive:true});
 const path=join(harness,'runs',runId+'.json');const run={runId,intent:'daily_maintenance',status:'running',events:[]};
 const record=(phase,message,metadata={})=>{run.events.push({phase,message,metadata,at:new Date().toISOString()});writeFileSync(path,JSON.stringify(run,null,2));};
 try{
  record('queued','Daily source collection and serialized GLM review started.');
  const funds=JSON.parse(readFileSync(join(directory,'data/funds.json')));const candidates=await collector(funds);
  if(!candidates.some(c=>c.status==='ok'))throw new Error('all_collectors_failed');
  const snapshot=join(harness,'context',runId+'-candidates.json');writeFileSync(snapshot,JSON.stringify(candidates));
  const batches=Math.ceil(candidates.filter(c=>c.status==='ok').length/2);
  record('sources_collected',`Collected ${candidates.length} company inputs once; at most ${batches} serial two-company batches.`,{companies:candidates.length,batches});
  for(let index=0;index<batches;index++){
   record('batch_started',`Review batch ${index+1}/${batches}.`,{index});
   const result=await execute(directory,snapshot,index,8/batches);
   if(result.code!==0)throw new Error(`review_batch_failed:${index+1}`);
   record('batch_completed',`Review batch ${index+1}/${batches} completed.`,{index,outcome:result.outcome});
   if(result.outcome==='no_new_evidence')break;
  }
  run.status='ready';record('completed','Daily maintenance completed; only verified changes were applied.');return run;
 }catch(error){run.status='failed';record('failed',error.message);throw error;}
}
function executeChild(directory,snapshot,index,budget){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[join(directory,'scripts/nav-valuation-audit.mjs'),'--timeout-ms=600000',`--max-budget-usd=${(Math.floor(budget*100)/100).toFixed(2)}`,...(index?['--skip-official-nav']:[])],{cwd:directory,env:{...process.env,NAV_MONITOR_ROOT:directory,NAV_CANDIDATES_SNAPSHOT:snapshot,NAV_AUDIT_BATCH_LIMIT:'2'}});
  let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>process.stderr.write(data));child.on('error',reject);
  child.on('exit',code=>{let outcome;try{outcome=JSON.parse(output).outcome;}catch{}resolve({code,outcome});});
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url))dailyMaintenance(root).then(run=>console.log(JSON.stringify({runId:run.runId,status:run.status}))).catch(error=>{console.error(error.message);process.exitCode=1;});
