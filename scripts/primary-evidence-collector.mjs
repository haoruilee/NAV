const indexes={databricks:'https://www.databricks.com/company/newsroom/press-releases',revolut:'https://www.revolut.com/news/',mercor:'https://mercor.com/blog',airwallex:'https://www.airwallex.com/company/newsroom',boom:'https://boomsupersonic.com/news',oura:'https://ouraring.com/blog/',ramp:'https://ramp.com/blog',openai:'https://openai.com/news/',elevenlabs:'https://elevenlabs.io/blog',stripe:'https://stripe.com/newsroom',xai:'https://x.ai/news',crusoe:'https://www.crusoe.ai/resources/newsroom',anthropic:'https://www.anthropic.com/news',sierra:'https://sierra.ai/blog',legora:'https://legora.com/news',vercel:'https://vercel.com/blog'};
export function primaryText(html){return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&#36;|&dollar;/g,'$').replace(/\s+/g,' ').trim();}
export function primaryLinks(html,base){
 const host=new URL(base).hostname.replace(/^www\./,'');const links=[];
 for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  try{const url=new URL(m[1].replaceAll('&amp;','&'),base);url.hash='';const title=primaryText(m[2]);
   if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname===host||url.hostname.endsWith('.'+host))||url.href===base||!/valuat|funding|financing|tender|series[-\s]+[a-z]/i.test(title+' '+url.pathname))continue;
   if(!links.some(x=>x.url===url.href))links.push({url:url.href,title});
  }catch{}
 }
 return links.sort((a,b)=>Number(/valuat/i.test(b.title))-Number(/valuat/i.test(a.title))).slice(0,2);
}
function excerpt(html){const text=primaryText(html);const snippets=[text.slice(0,700)];let used=0;for(const match of text.matchAll(/valuat|valued at/gi)){if(used++>=3)break;snippets.push(text.slice(Math.max(0,match.index-200),match.index+700));}return snippets.join('\n…\n').slice(0,3000);}
export async function collectPrimaryEvidence(candidates,fetcher=fetch){
 const cache=new Map();const copy=candidates.map(c=>({...c}));let cursor=0;
 const get=async(url,origin,depth=0)=>{
  if(depth>2)throw new Error('redirect_limit');const res=await fetcher(url,{signal:AbortSignal.timeout(8000),redirect:'manual',headers:{'User-Agent':'NAVMonitor primary source collector admin@nav-monitor.app'}});
  if(res.status>=300&&res.status<400){const next=new URL(res.headers.get('location'),url);const host=new URL(origin).hostname.replace(/^www\./,'');if(next.protocol!=='https:'||next.port||next.username||next.password||!(next.hostname===host||next.hostname.endsWith('.'+host)))throw new Error('untrusted_redirect');return get(next.href,origin,depth+1);}
  if(!res.ok)throw new Error(`HTTP_${res.status}`);
  let html='';
  if(res.body?.getReader){const reader=res.body.getReader();const decoder=new TextDecoder();let bytes=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>1500000)break;html+=decoder.decode(chunk.value,{stream:true});}}finally{await reader.cancel();}}else html=(await res.text()).slice(0,1500000);
  return{url,html};
 };
 const fetchCompany=async key=>{
  const index=indexes[key];if(!index)return{status:'unconfigured',documents:[]};
  try{
   const page=await get(index,index);const links=primaryLinks(page.html,page.url);const documents=[];
   for(const link of links){try{const article=await get(link.url,index);documents.push({url:article.url,title:link.title,text:excerpt(article.html)});}catch{}}
   if(!documents.length&&/valuat|valued at/i.test(primaryText(page.html))&&/\$\s*\d/.test(primaryText(page.html)))documents.push({url:page.url,title:'Official news index',text:excerpt(page.html)});
   return{status:documents.length?'ok':'no_verified_document',documents};
  }catch(error){return{status:'error',error:error.message,documents:[]};}
 };
 const worker=async()=>{while(cursor<copy.length){const i=cursor++;const c=copy[i];if(c.status!=='ok')continue;if(!cache.has(c.companyKey))cache.set(c.companyKey,fetchCompany(c.companyKey));c.primaryEvidence=await cache.get(c.companyKey);}};
 await Promise.all([worker(),worker()]);return copy;
}
