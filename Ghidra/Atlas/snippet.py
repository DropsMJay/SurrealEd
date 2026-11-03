import pyghidra,sys,json,collections
pyghidra.start(install_dir='/opt/ghidra_x/Ghidra12.0.4')
from ghidra.base.project import GhidraProject
from ghidra.app.decompiler import DecompInterface, DecompileOptions, PrettyPrinter
from ghidra.app.decompiler.component import DecompilerUtils
from ghidra.util.task import ConsoleTaskMonitor
loc,pn,prn,fin,out=sys.argv[1:6]
F=json.load(open(fin))
want=collections.defaultdict(set)
for c in F.values():
    for p in c['props']:
        for r in p['reads']: want[r['func']].add(r['addr'])
proj = GhidraProject.openProject(loc, pn, True)
prog = proj.openProgram('/', prn, True)
af=prog.getAddressFactory(); FM=prog.getFunctionManager(); L=prog.getListing()
d=DecompInterface(); d.setOptions(DecompileOptions()); d.openProgram(prog)
mon=ConsoleTaskMonitor(); res={}
for fname,addrs in want.items():
    f=None
    for a in addrs:
        f=FM.getFunctionContaining(af.getAddress(a)); break
    r=d.decompileFunction(f,60,mon)
    if not r.decompileCompleted(): continue
    lines=DecompilerUtils.toLines(r.getCCodeMarkup())
    texts=[]; amap=collections.defaultdict(set)
    for i,ln in enumerate(lines):
        t=''.join(str(tok) for tok in ln.getAllTokens())
        texts.append(('  '*ln.getIndent())+t)
        for tok in ln.getAllTokens():
            mn=tok.getMinAddress(); mx=tok.getMaxAddress()
            if mn is not None:
                amap[i].add(mn.getOffset())
                if mx is not None: amap[i].add(mx.getOffset())
    for a in addrs:
        ins=L.getInstructionContaining(af.getAddress(a)); off=ins.getAddress().getOffset(); end=off+ins.getLength()-1
        hit=[i for i,s in amap.items() if any(off<=x<=end for x in s)]
        if not hit: continue
        i=min(hit)
        res[a]='\n'.join(x.rstrip() for x in texts[max(0,i-2):i+3]).strip('\n')
json.dump(res,open(out,'w'))
print(len(want), len(res))
