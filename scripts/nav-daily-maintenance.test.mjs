import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dailyMaintenance } from './nav-daily-maintenance.mjs';
test('daily orchestrator collects once, serializes bounded batches and caps total model budget',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nav-daily-'));mkdirSync(join(root,'data'));writeFileSync(join(root,'data/funds.json'),'[]');let collections=0,calls=0,active=0,max=0,budget=0;
 try{
 const result=await dailyMaintenance(root,async()=>{collections++;return Array.from({length:5},()=>({status:'ok'}));},async(_root,_snapshot,index,amount)=>{calls++;active++;max=Math.max(active,max);budget+=amount;await new Promise(r=>setTimeout(r,5));active--;return{code:0,outcome:'completed_no_change'};});
 assert.equal(result.status,'ready');assert.equal(collections,1);assert.equal(calls,3);assert.equal(max,1);assert.ok(budget<=8.0001);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('failed batch is never retried and empty/cached work ends without extra batches',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nav-daily-'));mkdirSync(join(root,'data'));writeFileSync(join(root,'data/funds.json'),'[]');let calls=0;
 try{
  const collect=async()=>Array.from({length:5},()=>({status:'ok'}));await assert.rejects(dailyMaintenance(root,collect,async()=>{calls++;return{code:1};}),/batch_failed/);assert.equal(calls,1);
  calls=0;const result=await dailyMaintenance(root,collect,async()=>{calls++;return{code:0,outcome:'no_new_evidence'};});assert.equal(calls,1);assert.equal(result.status,'ready');
 }finally{rmSync(root,{recursive:true,force:true});}
});
