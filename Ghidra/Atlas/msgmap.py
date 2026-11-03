import pyghidra,sys,json,re,bisect,collections
pyghidra.start(install_dir='/opt/ghidra_x/Ghidra12.0.4')
from ghidra.base.project import GhidraProject
loc,pn,prn,ctorjson,out=sys.argv[1:6]
CT=json.load(open(ctorjson))
proj = GhidraProject.openProject(loc, pn, True)
prog = proj.openProgram('/', prn, True)
af=prog.getAddressFactory(); L=prog.getListing(); FM=prog.getFunctionManager(); mem=prog.getMemory()
A=lambda v: af.getDefaultAddressSpace().getAddress(v)
DS=prog.getMinAddress().getOffset(); DE=prog.getMaxAddress().getOffset()
TS=DS; TE=DE
bases={}
for cid,v in CT.items():
    ct=v.get('ctor')
    if not ct: continue
    f=FM.getFunctionAt(A(int(ct,16)))
    if not f: continue
    for ins in L.getInstructions(f.getBody(),True):
        if ins.getMnemonicString()=='PUSH':
            s=ins.getScalar(0)
            if s is not None and DS<=s.getUnsignedValue()<=DE and L.getInstructionContaining(A(s.getUnsignedValue())) is None: bases.setdefault(s.getUnsignedValue(),set()).add(cid)
print('tables',len(bases))
B=sorted(bases)
writes=[]
for ins in L.getInstructions(True):
    if ins.getMnemonicString()!='MOV': continue
    t=str(ins)
    m=re.match(r'MOV (?:dword ptr )?\[0x([0-9a-f]+)\],(EAX|EBX|ECX|EDX|ESI|EDI|0x[0-9a-f]+)$',t)
    if not m: continue
    addr=int(m.group(1),16)
    if not (DS<=addr<=DE) or L.getInstructionContaining(A(addr)) is not None: continue
    src=m.group(2)
    if src.startswith('0x'): val=int(src,16)
    else:
        val=None; p=ins.getPrevious(); n=0
        while p is not None and n<8:
            mm=re.match(r'MOV '+src+r',0x([0-9a-f]+)$',str(p))
            if mm: val=int(mm.group(1),16); break
            if str(p.getDefaultOperandRepresentation(0))==src: break
            p=p.getPrevious(); n+=1
    if val is not None and TS<=val<=TE and FM.getFunctionAt(A(val)) is not None:
        writes.append((addr,val))
handlers=collections.defaultdict(set)
for addr,val in writes:
    i=bisect.bisect_right(B,addr)-1
    if i>=0 and addr-B[i]<0x800:
        for cid in bases[B[i]]: handlers[cid].add(val)
print('writes',len(writes),'classes with handlers',len(handlers), sum(len(v) for v in handlers.values()))
json.dump({k:[hex(x) for x in sorted(v)] for k,v in handlers.items()},open(out,'w'))
