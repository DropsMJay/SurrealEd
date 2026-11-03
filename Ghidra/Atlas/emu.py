import pyghidra,sys,json
pyghidra.start(install_dir='/opt/ghidra_x/Ghidra12.0.4')
sys.path.insert(0,'../RiotTools')
from Riot.RiotClasses import ReadRflClasses
from ghidra.base.project import GhidraProject
from ghidra.app.emulator import EmulatorHelper
from ghidra.util.task import ConsoleTaskMonitor
import java.math.BigInteger as BI
loc,pn,prn,rfl,create,newf,out=sys.argv[1:8]
C=ReadRflClasses(rfl)
proj = GhidraProject.openProject(loc, pn, True)
prog = proj.openProgram('/', prn, True)
af=prog.getAddressFactory(); L=prog.getListing(); FM=prog.getFunctionManager()
A=lambda v: af.getDefaultAddressSpace().getAddress(v)
CREATE=int(create,16); NEW=int(newf,16)
res={}
for cid,c in C.items():
    emu=EmulatorHelper(prog)
    try:
        emu.writeRegister('ESP',BI.valueOf(0x7ff00000))
        emu.writeRegister('FS_OFFSET',BI.valueOf(0x7fe00000))
        sp=0x7ff00000
        emu.writeMemoryValue(A(sp),4,0xdead0000)        # return
        emu.writeMemoryValue(A(sp+4),4,0x0e000000)      # param_1 (engine obj)
        emu.writeMemoryValue(A(sp+8),4,cid)             # param_2 class id
        emu.writeRegister('EIP',BI.valueOf(CREATE))
        target=None; size=None; steps=0; afternew=False
        while steps<4000:
            pc=emu.getExecutionAddress().getOffset()
            if pc==0xdead0000: break
            ins=L.getInstructionAt(A(pc))
            if ins is None: break
            if ins.getMnemonicString()=='CALL':
                flows=ins.getFlows()
                dst=flows[0].getOffset() if flows else None
                esp=emu.readRegister('ESP').longValue()
                if dst==NEW:
                    size=emu.readMemory(A(esp),4); size=int.from_bytes(bytes([b&0xff for b in size]),'little')
                    # skip call: return fake ptr
                    emu.writeRegister('EAX',BI.valueOf(0x0d000000)); emu.writeRegister('EIP',BI.valueOf(ins.getNext().getAddress().getOffset()))
                    afternew=True; steps+=1; continue
                target=dst; break
            emu.step(ConsoleTaskMonitor()); steps+=1
        res[hex(cid)]={'name':c.Name,'ctor':hex(target) if target else None,'size':size}
    except Exception as e:
        res[hex(cid)]={'name':c.Name,'err':str(e)[:80]}
    finally:
        emu.dispose()
json.dump(res,open(out,'w'),indent=0)
import collections
print(len(res), collections.Counter('ctor' if v.get('ctor') else ('err' if 'err' in v else 'none') for v in res.values()))
print(list(res.items())[:5])
