import fs from 'node:fs/promises';
import {announcements} from './announcements.mjs';
const origin=process.env.NAV_PUBLIC_ORIGIN||'https://etfnav.org';
if(!['https://etfnav.org','http://127.0.0.1:4179'].includes(origin))throw Error('origin_not_allowlisted');
async function get(route){const r=await fetch(origin+route,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('public_get_'+r.status+'_'+route);return r.json();}
const list=await get('/api/funds');if(!Array.isArray(list)||list.length>30||list.length<2)throw Error('invalid_fund_list');
const funds=[];for(const meta of list){if(!/^[a-z0-9-]+$/.test(meta.id))throw Error('invalid_fund_id');const q='?fund='+meta.id;const nav=await get('/api/nav'+q),holdingsReport=await get('/api/holdings'+q),estimate=await get('/api/estimated-nav'+q);const valuations=holdingsReport.holdings?.length?await get('/api/valuations'+q):{companies:{}};funds.push({...meta,nav,holdingsReport,estimate,valuations});}
const retrievedAt=new Date().toISOString();const news=origin.startsWith('https')?await announcements(funds,retrievedAt):{announcements:[],checks:[]};
await fs.writeFile(process.argv[2],JSON.stringify({retrievedAt,funds,...news},null,2));console.log('Collected unauthenticated public records for '+funds.length+' funds; no quote, model, SQL or credential access.');
