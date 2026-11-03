import pyghidra,sys,json,re
pyghidra.start(install_dir='/opt/ghidra_x/Ghidra12.0.4')
from ghidra.base.project import GhidraProject
loc,pn,prn,cmjson,ctorjson,out=sys.argv[1:7]
J=json.load(open(cmjson)); CT=json.load(open(ctorjson))
VT={int(k,16):v for k,v in J['vtables'].items()}
proj = GhidraProject.openProject(loc, pn, True)
prog = proj.openProgram('/', prn, True)
af=prog.getAddressFactory(); L=prog.getListing(); FM=prog.getFunctionManager(); RM=prog.getReferenceManager()
A=lambda v: af.getDefaultAddressSpace().getAddress(v)
def callees(fa):
    f=FM.getFunctionAt(A(fa))
    if f is None: return []
    out=[]
    for ins in L.getInstructions(f.getBody(),True):
        if ins.getMnemonicString() in ('CALL','JMP'):
            for r in ins.getReferencesFrom():
                if r.getReferenceType().isCall() or r.getReferenceType().isJump():
                    t=r.getToAddress().getOffset()
                    if FM.getFunctionAt(A(t)) is not None and t!=fa: out.append(t)
    return sorted(set(out))
res={}
for cid,v in CT.items():
    ct=v.get('ctor')
    if not ct: continue
    f=FM.getFunctionAt(A(int(ct,16)))
    vts=[]
    if f:
        for ins in L.getInstructions(f.getBody(),True):
            t=str(ins)
            m=re.match(r'MOV dword ptr \[E\w\w\],0x([0-9a-f]+)$',t)
            if m and int(m.group(1),16) in VT: vts.append(int(m.group(1),16))
    # ctor may be a thunk/creator returning other ctor: follow one level
    if not vts and f:
        for c in callees(int(ct,16))[:3]:
            g=FM.getFunctionAt(A(c))
            for ins in L.getInstructions(g.getBody(),True):
                m=re.match(r'MOV dword ptr \[E\w\w\],0x([0-9a-f]+)$',str(ins))
                if m and int(m.group(1),16) in VT: vts.append(int(m.group(1),16))
            if vts: break
    res[cid]=dict(v, vtable=hex(vts[-1]) if vts else None, allvt=[hex(x) for x in vts])
# callee graph for all vtable slot functions (depth 2)
graph={}
todo=set(s for v in VT.values() for s in v['slots'])
import os
MSG=json.load(open(sys.argv[7])) if len(sys.argv)>7 else {}
todo|=set(int(x,16) for v in MSG.values() for x in v)
for depth in range(3):
    nxt=set()
    for fa in todo:
        if fa in graph: continue
        graph[fa]=callees(fa); nxt|=set(graph[fa])
    todo=nxt
json.dump({'classes':res,'graph':{hex(k):[hex(x) for x in v] for k,v in graph.items()}},open(out,'w'))
import collections
print(collections.Counter(bool(v['vtable']) for v in res.values()))
