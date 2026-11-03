export const slug=value=>String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
export function positions(fund){return(fund.holdingsReport?.holdings||[]).map(p=>{const modeled=(fund.estimate?.holdings||[]).find(h=>h.name===p.name);return{...p,key:modeled?.key||slug(p.name),baselineDate:fund.holdingsReport?.asOf||fund.estimate?.filingBaseDate||null,modeled};});}
export function lookThrough(funds,allocations,amount=10000){
 const ids=new Set(funds.map(f=>f.id));let total=0;const errors=[];
 for(const[id,v]of Object.entries(allocations)){if(!ids.has(id)||!Number.isFinite(v)||v<0||v>100)errors.push('Use allocations between 0 and 100 for known funds.');total+=v;}
 if(Math.abs(total-100)>.01)errors.push('Allocations must total 100%.');if(!Number.isFinite(amount)||amount<0||amount>1e12)errors.push('Use a non-negative illustrative amount.');
 if(errors.length)return{ok:false,errors,total};
 const issuers=new Map(),sectors=new Map(),coverage=[];let known=0;
 for(const fund of funds){const allocation=allocations[fund.id]||0;if(!allocation)continue;const ps=positions(fund);const sum=ps.reduce((s,p)=>s+(Number.isFinite(p.weight)&&p.weight>0?p.weight:0),0);const valid=sum<=100&&ps.every(p=>Number.isFinite(p.weight)&&p.weight>=0&&p.weight<=100);let mapped=0;
  if(valid)for(const p of ps){const effective=allocation*p.weight/100;mapped+=effective;const row=issuers.get(p.key)||{key:p.key,name:p.name,sector:p.sector||'Unclassified',weight:0,funds:[]};row.weight+=effective;row.funds.push({fundId:fund.id,fundName:fund.name,allocation,reportedWeight:p.weight,contribution:effective,baselineDate:p.baselineDate});issuers.set(p.key,row);sectors.set(row.sector,(sectors.get(row.sector)||0)+effective);}
  known+=mapped;coverage.push({fundId:fund.id,allocation,reportedWeight:valid?sum:0,mapped,unmapped:allocation-mapped,baselineDate:fund.holdingsReport?.asOf,valid});
 }
 return{ok:true,total,known,unmapped:Math.max(0,100-known),amount,issuers:[...issuers.values()].map(i=>({...i,dollars:amount*i.weight/100})).sort((a,b)=>b.weight-a.weight),sectors:[...sectors].map(([name,weight])=>({name,weight})).sort((a,b)=>b.weight-a.weight),coverage};
}
export function safeURL(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
export function validDate(value,today='9999-12-31'){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false;const d=new Date(value+'T00:00:00Z');return!Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value&&value<=today;}
export function calendarRecords(snapshot){
 const rows=new Map(),today=snapshot.retrievedAt.slice(0,10);
 for(const fund of snapshot.funds)for(const[key,company]of Object.entries(fund.valuations?.companies||{}))for(const v of company.valuationHistory||[]){const url=safeURL(v.url),a=v.audit||{};if(!url||!validDate(v.date,today)||!a.useForNav||!['high','medium'].includes(a.trustLevel)||new URL(url).hostname==='news.google.com')continue;const id=slug(key+'-'+v.date+'-'+url.split('/').at(-1)).slice(0,130);const row=rows.get(url+'|'+v.date)||{id,companyKey:key,companyName:company.name,date:v.date,title:v.headline||v.label||company.name+' source record',url,type:'Historical valuation record',fundIds:[],trust:a.trustLevel};if(!row.fundIds.includes(fund.id))row.fundIds.push(fund.id);rows.set(url+'|'+v.date,row);}
 for(const a of snapshot.announcements||[]){if(!safeURL(a.url)||!validDate(a.date,today))continue;const previous=rows.get(a.url+'|'+a.date);rows.set(a.url+'|'+a.date,{...(previous||{}),...a,type:'Publisher announcement',fundIds:a.fundIds||previous?.fundIds||[],id:previous?.id||slug(a.companyKey+'-'+a.date+'-'+a.title).slice(0,130)});}
 return[...rows.values()].sort((a,b)=>b.date.localeCompare(a.date));
}
