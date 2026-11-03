import json, csv, sys, collections, re
sys.path.insert(0,'../RiotTools')
from Riot.RiotClasses import ReadRflClasses
cm,cm3,readscsv,rfl,stats,out,msgf=sys.argv[1:8]
MSG=json.load(open(msgf))
J=json.load(open(cm)); K=json.load(open(cm3)); C=ReadRflClasses(rfl); S=json.load(open(stats))
VT={int(k,16):v for k,v in J['vtables'].items()}; G={int(k,16):[int(x,16) for x in v] for k,v in K['graph'].items()}
kinds=J['kinds']; rows=list(csv.DictReader(open(readscsv,encoding='utf-8')))
selfroot=re.compile(r'^\[\[(param_1|this)\+0x4\]\+0x(f0|ec)\]$|^\[(param_1|this)\+0x(f0|ec)\]$')
byfunc=collections.defaultdict(list)
for r in rows:
    if selfroot.match(r['Object']): byfunc[int(r['FunctionAddress'],16)].append(r)
def ok(kind,t):
    if kind=='f': return t==2
    if kind=='a': return bool(t&0x1000)
    return True
# which slot holds the message handler
for va,v in VT.items():
    if 0x6dbe3ab0 in v['slots']: print('msg handler slot', v['slots'].index(0x6dbe3ab0), hex(va))
out_classes={}
for cid,v in K['classes'].items():
    key='0x%08X'%int(cid,16); st=S[key]; c=C[int(cid,16)]
    entry={'name':c.Name,'vtable':v.get('vtable'),'ctor':v.get('ctor'),'size':v.get('size')}
    reads=collections.defaultdict(list)
    if v.get('vtable'):
        slots=VT[int(v['vtable'],16)]['slots']
        origin={}
        for i,s in enumerate(slots): origin.setdefault(s,(0,i,s))
        for h in MSG.get(cid,[]): origin.setdefault(int(h,16),(0,'msg',int(h,16)))
        frontier=list(origin)
        for d in (1,2,3):
            nf=[]
            for f in frontier:
                for g in G.get(f,[]):
                    if g not in origin: origin[g]=(d,origin[f][1],f); nf.append(g)
            frontier=nf
        for f,(d,slot,via) in origin.items():
            R=byfunc.get(f,[])
            if not R: continue
            good=all(0<=int(r['Prop'])<len(c.PropertyTypes) and ok(kinds.get(r['Address'],'?').split(':')[0],c.PropertyTypes[int(r['Prop'])]) for r in R)
            if d>0 and not good: continue
            for r in R:
                n=int(r['Prop'])
                if not 0<=n<len(c.PropertyTypes): continue
                reads[n].append({'func':r['Function'],'addr':r['Address'],'slot':slot,'depth':d,'kind':kinds.get(r['Address'],'?')})
    entry['props']=[]
    for n,ty in enumerate(c.PropertyTypes):
        p=dict(st['props'][n]); p['index']=n; p['type']=ty
        rr=reads.get(n,[])
        # dedupe by func
        seen={}; 
        for x in rr: seen.setdefault(x['func'],x)
        p['reads']=sorted(seen.values(),key=lambda x:(x['depth'],str(x['slot'])))
        entry['props'].append(p)
    entry['templates']=st['templates']; entry['instances']=st['instances']
    out_classes[key]=entry
# data-only classes too
for key,st in S.items():
    if key in out_classes: continue
    cid=int(key,16); c=C[cid]
    out_classes[key]={'name':c.Name,'vtable':None,'ctor':None,'size':None,'templates':st['templates'],'instances':st['instances'],
       'props':[dict(st['props'][n],index=n,type=ty,reads=[]) for n,ty in enumerate(c.PropertyTypes)]}
json.dump(out_classes,open(out,'w'))
tot=sum(len(c['props']) for c in out_classes.values()); withr=sum(1 for c in out_classes.values() for p in c['props'] if p['reads'])
print('classes',len(out_classes),'props',tot,'props with reads',withr, 'classes w/ reads', sum(1 for c in out_classes.values() if any(p['reads'] for p in c['props'])))
