# Extract: vtables, constructors, read usage kinds -> JSON
import pyghidra, json, csv, re, sys
pyghidra.start(install_dir='/opt/ghidra_x/Ghidra12.0.4')
from ghidra.base.project import GhidraProject
loc,pname,prog_name,reads_csv,out=sys.argv[1:6]
proj = GhidraProject.openProject(loc, pname, True)
prog = proj.openProgram('/', prog_name, True)
L=prog.getListing(); FM=prog.getFunctionManager(); RM=prog.getReferenceManager(); mem=prog.getMemory()
af=prog.getAddressFactory()
A=lambda s: af.getAddress(s)
def u32(a):
    try: return mem.getInt(a) & 0xffffffff
    except: return None
entries=set(f.getEntryPoint().getOffset() for f in FM.getFunctions(True))
def isfunc(v): return v in entries
def istext(v):
    if v is None: return False
    try: a=A(hex(v))
    except Exception: return False
    return L.getInstructionAt(a) is not None or FM.getFunctionAt(a) is not None
# vtables: addresses in non-text blocks referenced by instructions (MOV [..],imm) whose dword is function ptr
vt={}
for blk in mem.getBlocks():
    if blk.getName() in ('Headers','.rsrc','.reloc') or not blk.isInitialized(): continue
    a=blk.getStart()
    while a.compareTo(blk.getEnd())<0:
        if L.getInstructionContaining(a) is not None:
            a=a.add(4); continue
        v=u32(a)
        if istext(v):
            refs=[r for r in RM.getReferencesTo(a) if L.getInstructionAt(r.getFromAddress()) is not None and str(L.getInstructionAt(r.getFromAddress())).startswith('MOV dword ptr [')]
            if refs:
                slots=[]; b=a
                while True:
                    w=u32(b)
                    if not istext(w): break
                    if slots and any(str(L.getInstructionAt(r.getFromAddress())).startswith('MOV dword ptr [') for r in RM.getReferencesTo(b) if L.getInstructionAt(r.getFromAddress())): break
                    slots.append(w); b=b.add(4)
                writers=[]
                for r in refs:
                    ins=L.getInstructionAt(r.getFromAddress())
                    if ins.getMnemonicString()=='MOV' and str(ins).startswith('MOV dword ptr ['):
                        f=FM.getFunctionContaining(ins.getAddress())
                        if f: writers.append(f.getEntryPoint().getOffset())
                vt[a.getOffset()]={'slots':slots,'writers':sorted(set(writers))}
        a=a.add(4)
print('vtables',len(vt))
# calls in each writer (constructor) -> other constructors called (base)
ctor_vt=collections_dd={}
for va,v in vt.items():
    for w in v['writers']: ctor_vt.setdefault(w,[]).append(va)
calls={}
for w in ctor_vt:
    f=FM.getFunctionAt(af.getDefaultAddressSpace().getAddress(w))
    cs=[]
    for ins in L.getInstructions(f.getBody(),True):
        if ins.getMnemonicString()=='CALL':
            for r in ins.getReferencesFrom():
                if r.getReferenceType().isCall(): cs.append(r.getToAddress().getOffset())
    calls[w]=cs
# usage kind per read
kinds={}
rows=list(csv.DictReader(open(reads_csv,encoding='utf-8')))
for r in rows:
    a=A(r['Address']); ins=L.getInstructionContaining(a)
    k='?'; nxt=ins.getNext() if ins else None; n=0; reg='EAX'
    while nxt is not None and n<8:
        t=str(nxt); m=nxt.getMnemonicString()
        if '['+reg+']' in t or '['+reg+' +' in t:
            if m.startswith('F'): k='f'
            elif 'ffff0000' in t or 'ffff' in t: k='a'
            elif m in('MOV','CMP','TEST','PUSH','MOVSX','MOVZX','AND','OR','ADD','SUB','LEA'): k='i:'+m
            else: k='?:'+m
            break
        if m=='MOV' and t.endswith(','+reg) and nxt.getNumOperands()==2 and not t.startswith('MOV dword ptr'):
            reg=str(nxt.getDefaultOperandRepresentation(0)); nxt=nxt.getNext(); n+=1; continue
        if m=='CALL' or nxt.getFlowType().isJump(): k='?:'+m; break
        if str(nxt.getDefaultOperandRepresentation(0))==reg and nxt.getNumOperands()>=1 and m not in ('CMP','TEST','PUSH'): k='?:clobber'; break
        nxt=nxt.getNext(); n+=1
    kinds[r['Address']]=k
json.dump({'vtables':{hex(k):v for k,v in vt.items()},'ctor_calls':{hex(k):v for k,v in calls.items()},'kinds':kinds},open(out,'w'))
import collections; print(collections.Counter(v.split(':')[0] for v in kinds.values()), collections.Counter(kinds.values()).most_common(12))
