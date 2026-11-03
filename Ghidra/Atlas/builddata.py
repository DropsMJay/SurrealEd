import json, re, csv, sys
sys.path.insert(0,'../RiotTools')
from Riot.RiotProperties import TypeNames
F=json.load(open(sys.argv[1])); S=json.load(open(sys.argv[2]))
pat=re.compile(r'\(\*\*\(code \*\*\)\(\*\*\(int \*\*\)\((?:\(int\))?(.*?) \+ 0x(?:f0|ec)\) \+ 8\)\)\((\w+),0xffffffff\)')
def clean(s):
    s=pat.sub(lambda m:'GetProp(%s)'%(int(m.group(2),0) if re.match(r'^(0x[0-9a-f]+|\d+)$',m.group(2)) else m.group(2)),s)
    lines=s.split('\n'); ind=min((len(l)-len(l.lstrip()) for l in lines if l.strip()),default=0)
    return '\n'.join(l[ind:] for l in lines)
def tn(t):
    if t in TypeNames: return TypeNames[t]
    if t&0x1000: return tn(t&~0x1000)+'[]'
    return '0x%04X'%t
snips={}; sid={}
classes=[]
rows=[]
for cid,c in sorted(F.items(), key=lambda kv: kv[1]['name'].lower()):
    props=[]
    for p in c['props']:
        rd=[]
        for r in p['reads']:
            a=r['addr']
            if a in S and a not in sid: sid[a]=len(snips); snips[len(snips)]=clean(S[a])
            k=r['kind'].split(':')[0]
            rd.append([r['func'],r['slot'],r['depth'],k,sid.get(a,-1),a])
        props.append([p['type'],tn(p['type']),p['distinct'],p['values'][:4],[x for x in p['refclasses'][:3]],p['overrides'],rd])
        rows.append([c['name'],cid,p['index'],tn(p['type']),'0x%04X'%p['type'],p['distinct'],' | '.join('%s ×%d'%(v,n) for v,n in p['values'][:4]),' | '.join('%s ×%d'%(v,n) for v,n in p['refclasses'][:3]),p['overrides'],' '.join('%s@%s/d%d/%s'%(r[0],r[1],r[2],r[3]) for r in rd)])
    classes.append([c['name'],cid,c['templates'],c['instances'],c.get('vtable'),props])
data={'classes':classes,'snips':[snips[i] for i in range(len(snips))]}
s=json.dumps(data,separators=(',',':'),ensure_ascii=False)
open(sys.argv[3],'w').write(s); print(len(s), len(snips))
with open(sys.argv[4],'w',newline='',encoding='utf-8') as h:
    w=csv.writer(h); w.writerow(['Class','ClassId','Prop','Type','TypeCode','DistinctValues','CommonValues','RefTargetClasses','LevelOverrides','ReadBy(func@slot/depth/kind)']); w.writerows(rows)
