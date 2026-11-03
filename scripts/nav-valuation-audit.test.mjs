import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateOutbox, validateDecision, valuationAlreadyExists, candidateFingerprint, selectChangedCandidates, verifyPrimaryEvidence, trustedEvidenceHost, evidenceValueMatches, buildContext } from './nav-valuation-audit.mjs';
const company={name:'OpenAI'};
const candidate={fundId:'rvi',companyKey:'openai',companyName:'OpenAI',status:'ok',items:[{title:'A report',url:'https://example.invalid/a',pubDate:'2026-01-01'}]};
const funds=new Map([['rvi',{config:{companies:{openai:company}}}]]);
const decision={fundId:'rvi',companyKey:'openai',action:'update',confidence:0.95,evidenceUrls:['https://openai.com/news/funding'],newValuation:{value:1000000000,date:'2026-01-01',source:'news',headline:'OpenAI announces a new funding round',url:'https://openai.com/news/funding',evidenceQuote:'OpenAI today announced a standalone post-money valuation of $1 billion.'}};
test('valid decision accepted and low confidence, nonfinite, unknown/future rejected',()=>{
 assert.equal(validateDecision(decision,funds),null);
 for(const patch of [{confidence:.84},{confidence:NaN},{companyKey:'wrong'},{newValuation:{...decision.newValuation,value:Infinity}},{newValuation:{...decision.newValuation,date:'2099-01-01'}},{newValuation:{...decision.newValuation,evidenceQuote:undefined}}])assert.ok(validateDecision({...decision,...patch},funds));
});
test('outbox fails closed on wrong run, intent, risk, missing/partial/duplicate decisions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nav-contract-'));const p=join(dir,'outbox.json');
 const valid={runId:'fixture',intent:'nav_valuation_audit',ready:true,riskLevel:'low',environmentUnderstanding:{dev:'fixture',runtime:'fixture',data:'fixture'},decisions:[decision]};
 try{
  for(const patch of [{runId:'stale'},{intent:'wrong'},{riskLevel:'high'},{decisions:[]},{decisions:[decision,decision]},{decisions:[{...decision,companyKey:'wrong'}]}]){writeFileSync(p,JSON.stringify({...valid,...patch}));assert.equal(validateOutbox(p,'fixture',[candidate]).ok,false);}
  writeFileSync(p,JSON.stringify(valid));assert.equal(validateOutbox(p,'fixture',[candidate]).ok,true);
  writeFileSync(p,'not JSON');assert.equal(validateOutbox(p,'fixture',[candidate]).ok,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('unchanged evidence skips model; weekly audit/changed evidence eligible',()=>{
 const cache={'rvi/openai':{fingerprint:candidateFingerprint(candidate),at:1000}};
 assert.deepEqual(selectChangedCandidates([candidate],cache,2000),[]);
 assert.deepEqual(selectChangedCandidates([candidate],cache,1000+7*86400000),[candidate]);
 assert.equal(selectChangedCandidates([{...candidate,items:[{...candidate.items[0],title:'Changed'}]}],cache,2000).length,1);
 assert.equal(selectChangedCandidates([{...candidate,status:'error'}],cache,2000).length,0);
});
test('only direct allowlisted HTTPS primary hosts are fetched',()=>{
 assert.equal(trustedEvidenceHost('https://openai.com/news','openai'),true);
 for(const url of ['http://openai.com/news','https://openai.com.evil.invalid/','https://evilopenai.com/','http://127.0.0.1/','https://news.google.com/rss/a','https://user:secret@openai.com/','https://openai.com:8443/'])assert.equal(trustedEvidenceHost(url,'openai'),false,url);
});
test('primary verification checks source quote, subject, amount and HTTP failure',async()=>{
 const fake=body=>async()=>({ok:true,text:async()=>`<html><body>${body}</body></html>`});
 assert.equal((await verifyPrimaryEvidence(decision,company,fake(decision.newValuation.evidenceQuote))).ok,true);
 assert.equal((await verifyPrimaryEvidence(decision,company,fake('Unrelated document'))).ok,false);
 const wrong={...decision,newValuation:{...decision.newValuation,value:2000000000}};
 assert.equal((await verifyPrimaryEvidence(wrong,company,fake(decision.newValuation.evidenceQuote))).error,'primary_amount_mismatch');
 assert.equal((await verifyPrimaryEvidence(decision,company,async()=>({ok:false,status:403}))).error,'primary_http_403');
});
test('duplicate records are idempotent and amount extraction understands scaled dollars',()=>{
 assert.equal(valuationAlreadyExists([decision.newValuation],decision.newValuation),true);
 assert.equal(evidenceValueMatches('A valuation of $1.25 billion',1250000000),true);
 assert.equal(evidenceValueMatches('A valuation of $1,250,000,000',1250000000),true);
 assert.equal(evidenceValueMatches('Raised $100 million',1250000000),false);
 assert.equal(evidenceValueMatches('OpenAI raised $1 billion at a $20 billion valuation',1000000000),false);
 assert.equal(evidenceValueMatches('OpenAI raised $1 billion at a $20 billion valuation',20000000000),true);
});
test('context bounds history and preserves complete primary evidence contract',()=>{
 const audits=[{fundId:'rvi',companies:{openai:{name:'OpenAI',entries:Array.from({length:100},(_,i)=>({value:i,date:'2026-01-01',source:'news',label:'record',audit:{useForNav:false,issues:[]}}))}}}];
 const context=buildContext({runId:'fixture',outboxPath:'/fixture/outbox.json',audits,candidates:[candidate]});
 assert.ok(context.includes('evidenceQuote'));assert.ok(context.includes('0.85'));assert.ok(!context.includes('"value": 99'));assert.ok(context.length<12000);
});
