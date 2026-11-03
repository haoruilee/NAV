import test from 'node:test';import assert from 'node:assert/strict';
import { primaryLinks,collectPrimaryEvidence,primaryText } from './primary-evidence-collector.mjs';
test('primary discovery follows only direct same-company financing links and bounds inputs',()=>{
 const html='<a href="/announcements/funding">Company financing valuation</a><a href="https://evil.invalid/funding">Valuation</a><a href="http://127.0.0.1/funding">funding</a><a href="/other">Other news</a>';
 assert.deepEqual(primaryLinks(html,'https://openai.com/news/'),[{url:'https://openai.com/announcements/funding',title:'Company financing valuation'}]);assert.equal(primaryText('<script>SECRET</script><p>Value $1 billion</p>'),'Value $1 billion');
});
test('collector independently fetches primary text once per company and contains failures',async()=>{
 let calls=0;
 const fake=async url=>{calls++;return new Response(url.includes('/news/')?'<a href="/funding">Official funding valuation</a>':'<p>OpenAI today reported a company valuation of $1 billion.</p>');};
 const input=[{fundId:'rvi',companyKey:'openai',status:'ok'},{fundId:'usvc',companyKey:'openai',status:'ok'},{fundId:'none',companyKey:'unknown',status:'ok'}];
 const result=await collectPrimaryEvidence(input,fake);assert.equal(calls,2);assert.equal(result[0].primaryEvidence.status,'ok');assert.ok(result[0].primaryEvidence.documents[0].text.includes('$1 billion'));assert.equal(result[1].primaryEvidence,result[0].primaryEvidence);assert.equal(result[2].primaryEvidence.status,'unconfigured');assert.equal(input[0].primaryEvidence,undefined);
 const failed=await collectPrimaryEvidence(input,async()=>{throw new Error('HTTP_403');});assert.equal(failed[0].primaryEvidence.status,'error');assert.deepEqual(failed[0].primaryEvidence.documents,[]);
});
