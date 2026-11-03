# Template defaults + level overrides per class/prop
import sys, json, collections, struct
sys.path.insert(0,'../RiotTools')
from Riot.RiotPackages import RiotGame
from Riot.RiotTemplates import RiotTemplateStore
from Riot.RiotClasses import ReadRflClasses
from Riot.RiotLevel import ReadInstances
from Riot.RiotProperties import FormatValue
root,out=sys.argv[1:3]
G=RiotGame(root); T=RiotTemplateStore(G); C=ReadRflClasses(G.Rfl)
vals=collections.defaultdict(lambda: collections.defaultdict(collections.Counter))  # cid->prop->Counter(text)
refcls=collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
ntemp=collections.Counter(); over=collections.defaultdict(collections.Counter); ninst=collections.Counter()
def tname(ref):
    if not ref: return None
    t=T.GetRef(ref)
    if t is None: return '?'
    c=C.get(t.ClassId); return c.Name if c else '0x%08X'%t.ClassId
for pid in G.Packages:
    cont=G.PackageContainer(pid,'.odu')
    if not cont: continue
    for idx in cont.ResourceIndexes(0x0102):
        t=T.Get(pid,idx)
        if t is None or t.ClassId not in C: continue
        c=C[t.ClassId]; ntemp[t.ClassId]+=1
        for n,ty in enumerate(c.PropertyTypes):
            if n>=len(t.Slots): break
            v=t.Slots[n]
            if ty&0x1000:
                items=t.SlotArray(n); vals[t.ClassId][n]['len=%d'%len(items)]+=1
                if ty&0x2000 or ty in (0x3003,0x5003):
                    for it in items[:8]:
                        if it: refcls[t.ClassId][n][tname(it)]+=1
            else:
                vals[t.ClassId][n][FormatValue(ty,v)]+=1
                if (ty&0x6000 or ty==3) and v: refcls[t.ClassId][n][tname(v)]+=1
for lv in G.Levels():
    try:
        cont=G.Container(lv['Path']); inst,_=ReadInstances(cont)
    except Exception: continue
    for i in inst:
        t=T.Get(i['TemplatePackage'],i['TemplateIndex'])
        if t is None: continue
        ninst[t.ClassId]+=1
        for p in i['PropertyIndexes']: over[t.ClassId][p]+=1
res={}
for cid,c in C.items():
    props=[]
    for n,ty in enumerate(c.PropertyTypes):
        cn=vals[cid][n]
        props.append({'values':cn.most_common(6),'distinct':len(cn),'refclasses':refcls[cid][n].most_common(4),'overrides':over[cid][n]})
    res['0x%08X'%cid]={'name':c.Name,'types':c.PropertyTypes,'templates':ntemp[cid],'instances':ninst[cid],'props':props}
json.dump(res,open(out,'w'))
print(len(res), sum(ntemp.values()), sum(ninst.values()))
