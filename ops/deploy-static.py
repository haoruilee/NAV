#!/usr/bin/env python3
"""Verify builder artifact, stage additions first, atomically replace HTML; no restarts."""
from pathlib import Path
import sys,json,hashlib,tarfile,subprocess,urllib.request,os,shutil
archive,manifest_path,expected_sha,run_dir=sys.argv[1:]
run=Path(run_dir);run.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(Path(archive))==expected_sha,'archive hash mismatch'
m=json.loads(Path(manifest_path).read_text());files=m['files']
assert 20<len(files)<250,'unexpected artifact size'
for f in files:assert not f.startswith('/') and '..' not in Path(f).parts and (f.startswith(('assets/','funds/','holdings/','insights/','news/','look-through/','methodology/','about/','privacy/','editorial-policy/')) or f in ['index.html','sources.html','robots.txt','sitemap.xml','feed.xml','ads.txt']),'path not allowlisted'
state=json.loads(subprocess.check_output(['docker','inspect','nav-monitor']))[0]
assert state['State']['Running'] and state['State'].get('Health',{}).get('Status','healthy')=='healthy','container unhealthy'
pid=subprocess.check_output(['systemctl','show','cloudflared-releaselog.service','-p','MainPID','--value'],text=True).strip()
if subprocess.run(['systemctl','is-active','--quiet','nav-valuation-audit.service']).returncode==0:raise Exception('audit active; defer static publication')
release=run/'release';release.mkdir(exist_ok=True)
with tarfile.open(archive) as t:
 seen=set()
 for member in t.getmembers():
  if member.isdir():continue
  f=member.name.removeprefix('./');assert member.isfile() and f in files and f not in seen
  seen.add(f);p=release/f;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(t.extractfile(member).read())
 assert seen==set(files)
for f,h in files.items():assert sha(release/f)==h,'member hash mismatch '+f
baseline=run/'baseline';baseline.mkdir(exist_ok=True)
old=[];new=[]
# Small static-only backups. Never touch data, SQL, Redis, logs or media.
for f in files:
 res=subprocess.run(['docker','exec','nav-monitor','test','-f','/app/public/'+f])
 if res.returncode==0:
  p=baseline/f;p.parent.mkdir(parents=True,exist_ok=True)
  subprocess.run(['docker','cp','nav-monitor:/app/public/'+f,str(p)],check=True,stdout=subprocess.DEVNULL);old.append(f)
 else:new.append(f)
(run/'rollback-state.json').write_text(json.dumps({'old':old,'new':new,'containerId':state['Id'],'tunnelPid':pid}))
def atomic_file(src,f):
 parent=str(Path('/app/public/'+f).parent);temp=parent+'/.nav-publish-'+Path(f).name
 subprocess.run(['docker','exec','nav-monitor','mkdir','-p',parent],check=True)
 subprocess.run(['docker','cp',str(src),'nav-monitor:'+temp],check=True,stdout=subprocess.DEVNULL)
 subprocess.run(['docker','exec','nav-monitor','mv',temp,'/app/public/'+f],check=True)
def restore():
 for f in old:atomic_file(baseline/f,f)
 for f in new:subprocess.run(['docker','exec','nav-monitor','rm','-f','/app/public/'+f],check=True)
try:
 # assets, nested route entries, root entries, then discovery metadata
 order=sorted(files,key=lambda f:(3 if f in ['sitemap.xml','robots.txt','feed.xml','ads.txt'] else 2 if f in ['index.html','sources.html'] else 0 if f.startswith('assets/') else 1,f))
 for f in order:atomic_file(release/f,f)
 for f,h in files.items():
  actual=subprocess.check_output(['docker','exec','nav-monitor','sha256sum','/app/public/'+f],text=True).split()[0];assert actual==h,'runtime hash mismatch '+f
 for base in ['http://127.0.0.1:4000','https://etfnav.org','https://www.etfnav.org']:
  for route,marker in [('/','Look beyond the quote.'),('/funds/','Know the fund.'),('/look-through/','See what sits underneath.'),('/insights/','Understand the number.'),('/news/','Dates. Documents. Context.'),('/privacy/','Research without submitting a portfolio.')]:
   with urllib.request.urlopen(urllib.request.Request(base+route,headers={'User-Agent':'NAV-static-acceptance/1.0'}),timeout=30) as r:
    body=r.read().decode();assert r.status==200 and marker in body,base+route
 after=json.loads(subprocess.check_output(['docker','inspect','nav-monitor']))[0]
 assert after['Id']==state['Id'] and after['State']['StartedAt']==state['State']['StartedAt']
 assert subprocess.check_output(['systemctl','show','cloudflared-releaselog.service','-p','MainPID','--value'],text=True).strip()==pid
except Exception:
 restore();raise
# Persist accepted generated files so future container builds retain this release.
source=Path('/home/claudeuser/nav-monitor/public')
for f in files:
 p=source/f;p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_name('.nav-persist-'+p.name);shutil.copyfile(release/f,tmp);os.chown(tmp,1001,1001);os.replace(tmp,p)
 os.chown(p.parent,1001,1001)
(run/'receipt.json').write_text(json.dumps({'sha256':expected_sha,'containerId':state['Id'],'startedAt':state['State']['StartedAt'],'tunnelPid':pid,'fileCount':len(files),'indexedPages':m['indexedPages'],'sourceRecords':m['records'],'publicDomains':['etfnav.org','www.etfnav.org'],'status':'accepted'},indent=2))
print('Verified static artifact accepted on localhost and both public domains; runtime container and shared tunnel unchanged.')
