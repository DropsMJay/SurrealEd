# Finds every property read in a Riot Engine module and labels it.
# Encontra toda leitura de propriedade num modulo do Riot Engine e marca.
#
# Pattern / Padrao:
#     (**(code **)(**(int **)(Object + 0xf0) + 8))(N, 0xffffffff)
#     -> "PropertySet->Get(N, -1)"
#
# What it does / O que faz:
#   1. Decompiles every function that has a "CALL [reg + 0x8]"
#      and checks in the P-code which calls take a
#      constant first argument.
#      Descompila cada funcao com "CALL [reg + 0x8]" e confere no P-code
#      quais chamadas tem primeiro argumento constante.
#   2. Detects wrapper functions (the index comes from a parameter) and
#      resolves the calls to them that pass a constant.
#      Detecta funcoes "wrapper" (o indice vem de um parametro) e resolve as
#      chamadas a elas que passam uma constante.
#   3. Writes an EOL comment "prop N" at each call, a plate-comment summary
#      on each function and a "RiotProps" bookmark.
#      Escreve comentario EOL "prop N" em cada chamada, um resumo no
#      plate comment de cada funcao e um bookmark "RiotProps".
#   4. Writes three CSV files:
#      Gera tres CSV:
#        <Program>_PropertyReads.csv      one row per call / uma linha por chamada
#        <Program>_PropertyFunctions.csv  function -> props -> callers -> vtables
#        <Program>_PropertyIndex.csv      prop N -> functions that read it
#
# Confidence / Confianca:
#   High   - the object comes from "+ 0xf0" (TS1) or "+ 0xec" (TTB): PropertySet
#   Low    - object is a global (DAT_...), probably not a PropertySet
#   Asm    - found by instruction pattern (decompiler failed or did not bind the arguments)
#   Medium - same call shape, object from somewhere else (e.g. [reg + 4])
#   Wrapper- read through a wrapper function / via funcao wrapper
#
# Note: N counts inherited properties too (base class first).
# Nota: N conta tambem as propriedades herdadas (classe base primeiro).
#
# Usage / Uso: Script Manager -> RiotEngine -> RiotPropertyReads.py -> Run.
# Works with Suffering.rfl, Suffering.exe, SufferingTTB.exe/.rfl.
#
# MIT License - SurrealEd / RiotTools.
#
# @author SurrealEd
# @category RiotEngine
# @runtime PyGhidra

import csv
import os
import re
from collections import defaultdict

from ghidra.app.decompiler import DecompInterface, DecompileOptions
from ghidra.program.model.listing import CodeUnit
from ghidra.program.model.pcode import PcodeOp
from ghidra.util.task import ConsoleTaskMonitor

# ---------------------------------------------------------------- settings
PropertySetOffsets = (0xF0, 0xEC)  # Object + 0xf0 (TS1) / + 0xec (TTB) -> PropertySet
AccessorSlot = 0x8              # vtable slot of Get(N, Element)
SecondArgs = (-1, 0xFFFFFFFF, 0)  # accepted values for the 2nd argument
DecompileTimeout = 60           # seconds per function
WriteComments = True
WriteBookmarks = True
WritePlateSummary = True
CommentTag = "prop "

Program = currentProgram  # noqa: F821 (provided by Ghidra)
try:
    Monitor = monitor  # noqa: F821
except NameError:
    Monitor = ConsoleTaskMonitor()

Listing = Program.getListing()
Functions = Program.getFunctionManager()
References = Program.getReferenceManager()
Bookmarks = Program.getBookmarkManager()

CallRegex = re.compile(r"^CALL dword ptr \[E\w\w \+ 0x%x\]$" % AccessorSlot)


def Log(Text):
    print(Text)


# ------------------------------------------------------------ candidates
def PreviousPushes(Instruction, Count=2, Limit=16):
    """Last pushes before a call, nearest first / ultimos PUSH antes da chamada."""
    Pushes = []
    Current = Listing.getInstructionBefore(Instruction.getAddress())
    Steps = 0
    while Current is not None and Steps < Limit and len(Pushes) < Count:
        Mnemonic = Current.getMnemonicString()
        if Mnemonic == "CALL" or Current.getFlowType().isJump() or Current.getFlowType().isTerminal():
            break
        if Mnemonic == "PUSH":
            Pushes.append(Current)
        Current = Listing.getInstructionBefore(Current.getAddress())
        Steps += 1
    return Pushes


def FindCandidateFunctions():
    """Functions with a CALL [reg+8] / funcoes com CALL [reg+8]."""
    Found = {}
    for Instruction in Listing.getInstructions(True):
        if Monitor.isCancelled():
            break
        if Instruction.getMnemonicString() != "CALL":
            continue
        if not CallRegex.match(str(Instruction)):
            continue
        # Any CALL [reg+8]: the decompiler decides (pushes can be far away).
        # Qualquer CALL [reg+8]: o descompilador decide (os PUSH podem estar longe).
        Function = Functions.getFunctionContaining(Instruction.getAddress())
        if Function is not None:
            Found[Function.getEntryPoint()] = Function
    return list(Found.values())


# ------------------------------------------------------------- P-code walk
def ConstantValue(Varnode, Depth=0):
    """Constant value of a varnode (through COPY/CAST), or None."""
    if Varnode is None or Depth > 6:
        return None
    if Varnode.isConstant():
        return Varnode.getOffset()
    Def = Varnode.getDef()
    if Def is None:
        return None
    if Def.getOpcode() in (PcodeOp.COPY, PcodeOp.CAST, PcodeOp.INT_ZEXT, PcodeOp.INT_SEXT):
        return ConstantValue(Def.getInput(0), Depth + 1)
    return None


def ParameterIndex(Varnode, Depth=0):
    """Index of the function parameter that feeds this varnode, or None."""
    if Varnode is None or Depth > 6:
        return None
    High = Varnode.getHigh()
    try:
        from ghidra.program.model.pcode import HighParam
        if isinstance(High, HighParam):
            Storage = High.getStorage()
            if Storage is not None and Storage.isStackStorage():
                # cdecl/thiscall: return address at +0, first stack arg at +4
                return (Storage.getStackOffset() - 4) // 4
            return None
    except Exception:
        pass
    Def = Varnode.getDef()
    if Def is not None and Def.getOpcode() in (PcodeOp.COPY, PcodeOp.CAST, PcodeOp.INT_ZEXT, PcodeOp.INT_SEXT):
        return ParameterIndex(Def.getInput(0), Depth + 1)
    return None


def Describe(Varnode, Depth=0):
    """Short text of where a pointer comes from, e.g. '[[param_1+0x4]+0xf0]'."""
    if Varnode is None:
        return "?"
    if Varnode.isConstant():
        return "0x%x" % Varnode.getOffset()
    if Depth > 7:
        return "..."
    Def = Varnode.getDef()
    if Def is None:
        High = Varnode.getHigh()
        if High is not None and High.getName() is not None:
            return str(High.getName())
        return str(Varnode)
    Op = Def.getOpcode()
    if Op == PcodeOp.LOAD:
        return "[" + Describe(Def.getInput(1), Depth + 1) + "]"
    if Op in (PcodeOp.INT_ADD, PcodeOp.PTRSUB, PcodeOp.PTRADD):
        Left = Describe(Def.getInput(0), Depth + 1)
        Right = Def.getInput(1)
        if Right.isConstant():
            Offset = Right.getOffset()
            if Op == PcodeOp.PTRADD:
                Offset *= Def.getInput(2).getOffset()
            return "%s+0x%x" % (Left, Offset & 0xFFFFFFFF)
        return "%s+%s" % (Left, Describe(Right, Depth + 1))
    if Op in (PcodeOp.COPY, PcodeOp.CAST):
        return Describe(Def.getInput(0), Depth + 1)
    if Op == PcodeOp.MULTIEQUAL:
        return "phi(" + ",".join(Describe(Def.getInput(k), Depth + 2) for k in range(min(2, Def.getNumInputs()))) + ")"
    if Op in (PcodeOp.CALL, PcodeOp.CALLIND):
        return "call()"
    High = Varnode.getHigh()
    if High is not None and High.getName() is not None:
        return str(High.getName())
    return Def.getMnemonic()


def IsAccessorTarget(Varnode, Depth=0):
    """True when the call target is LOAD(LOAD(this) + 8)."""
    if Varnode is None or Depth > 4:
        return False
    Def = Varnode.getDef()
    if Def is None:
        return False
    if Def.getOpcode() in (PcodeOp.COPY, PcodeOp.CAST):
        return IsAccessorTarget(Def.getInput(0), Depth + 1)
    if Def.getOpcode() != PcodeOp.LOAD:
        return False
    Address = Def.getInput(1)
    AddDef = Address.getDef()
    while AddDef is not None and AddDef.getOpcode() in (PcodeOp.COPY, PcodeOp.CAST):
        AddDef = AddDef.getInput(0).getDef()
    if AddDef is None:
        return False
    if AddDef.getOpcode() in (PcodeOp.INT_ADD, PcodeOp.PTRSUB, PcodeOp.PTRADD):
        Right = AddDef.getInput(1)
        if Right.isConstant():
            Offset = Right.getOffset()
            if AddDef.getOpcode() == PcodeOp.PTRADD:
                Offset *= AddDef.getInput(2).getOffset()
            return Offset == AccessorSlot
    return False


def Unwrap(Varnode):
    Def = Varnode.getDef() if Varnode is not None else None
    while Def is not None and Def.getOpcode() in (PcodeOp.COPY, PcodeOp.CAST):
        Varnode = Def.getInput(0)
        Def = Varnode.getDef()
    return Varnode, Def


def AccessorObject(Target):
    """From LOAD(LOAD(Object) + 8) return Object / devolve o objeto."""
    _, Def = Unwrap(Target)
    if Def is None or Def.getOpcode() != PcodeOp.LOAD:
        return None
    _, Add = Unwrap(Def.getInput(1))
    if Add is None:
        return None
    _, VtableLoad = Unwrap(Add.getInput(0))
    if VtableLoad is None or VtableLoad.getOpcode() != PcodeOp.LOAD:
        return None
    return VtableLoad.getInput(1)


def SignedArg(Value):
    if Value is None:
        return None
    Value &= 0xFFFFFFFF
    return Value - 0x100000000 if Value & 0x80000000 else Value


# ---------------------------------------------------------------- analysis
def Confidence(ObjectText):
    for Offset in PropertySetOffsets:
        if ("+0x%x]" % Offset) in ObjectText:
            return "High"
    if ObjectText.startswith("DAT_") or ObjectText == "?":
        return "Low"       # global singleton / objeto global, provavelmente nao e PropertySet
    return "Medium"


StackLoad = re.compile(r"^MOV (E\w\w),dword ptr \[ESP \+ 0x([0-9a-f]+)\]$")


def AsmReads(Function, Wrappers, Skip=()):
    """Instruction-level fallback when the decompiler fails.
    Plano B em nivel de instrucao quando o descompilador falha."""
    Reads = []
    for Instruction in Listing.getInstructions(Function.getBody(), True):
        if Instruction.getMnemonicString() != "CALL" or not CallRegex.match(str(Instruction)):
            continue
        Pushes = PreviousPushes(Instruction)
        if len(Pushes) < 2 or str(Pushes[1]) not in ("PUSH -0x1", "PUSH 0x0"):
            continue
        Second = -1 if str(Pushes[1]) == "PUSH -0x1" else 0
        Scalar = Pushes[0].getScalar(0)
        if Instruction.getAddress() in Skip:
            continue
        if Scalar is not None:
            Reads.append({"Address": Instruction.getAddress(), "Function": Function,
                          "Prop": SignedArg(Scalar.getValue()), "Second": Second,
                          "Object": "(asm)", "Confidence": "Asm", "Via": ""})
            continue
        Register = str(Pushes[0].getDefaultOperandRepresentation(0))
        # Wrapper: index loaded from a stack argument before any PUSH in the function.
        Current = Listing.getInstructionAt(Function.getEntryPoint())
        Steps = 0
        while Current is not None and Steps < 12 and Current.getAddress() < Instruction.getAddress():
            if Current.getMnemonicString() == "PUSH":
                break
            Match = StackLoad.match(str(Current))
            if Match and Match.group(1) == Register:
                Wrappers[Function.getEntryPoint()] = (Function, (int(Match.group(2), 16) - 4) // 4, Second, "(asm)")
                break
            Current = Current.getNext()
            Steps += 1
    return Reads


def AnalyzeFunctions(Candidates):
    Decompiler = DecompInterface()
    Decompiler.setOptions(DecompileOptions())
    Decompiler.toggleCCode(False)
    Decompiler.openProgram(Program)

    Reads = []        # dicts
    Wrappers = {}     # entry -> (function, param slot of N, second arg)
    Failed = []

    Monitor.initialize(len(Candidates))
    for Number, Function in enumerate(Candidates):
        if Monitor.isCancelled():
            break
        Monitor.setProgress(Number)
        Monitor.setMessage("RiotPropertyReads %d/%d %s" % (Number + 1, len(Candidates), Function.getName()))
        Result = Decompiler.decompileFunction(Function, DecompileTimeout, Monitor)
        if Result is None or not Result.decompileCompleted():
            Failed.append(Function)
            Reads += AsmReads(Function, Wrappers)
            continue
        HighFunction = Result.getHighFunction()
        Before = len(Reads)
        for Op in HighFunction.getPcodeOps():
            if Op.getOpcode() != PcodeOp.CALLIND or Op.getNumInputs() < 3:
                continue
            if not IsAccessorTarget(Op.getInput(0)):
                continue
            # The decompiler may or may not show "this" (ECX) as an input:
            # O descompilador pode ou nao mostrar o "this" (ECX) como entrada:
            #   CALLIND target, this, N, Element   or   CALLIND target, N, Element
            First = 2 if Op.getNumInputs() >= 4 else 1
            Second = SignedArg(ConstantValue(Op.getInput(First + 1)))
            if Second not in (-1, 0):
                continue
            Address = Op.getSeqnum().getTarget()
            ObjectText = Describe(AccessorObject(Op.getInput(0)))
            IndexNode = Op.getInput(First)
            Index = ConstantValue(IndexNode)
            if Index is not None:
                Reads.append({
                    "Address": Address, "Function": Function, "Prop": SignedArg(Index),
                    "Second": Second, "Object": ObjectText,
                    "Confidence": Confidence(ObjectText),
                    "Via": "",
                })
                continue
            Slot = ParameterIndex(IndexNode)
            if Slot is not None:
                Wrappers[Function.getEntryPoint()] = (Function, Slot, Second, ObjectText)
        # PT: chamadas em que o descompilador não ligou os argumentos: pega pelas instruções
        # EN: calls whose arguments the decompiler did not bind: take them from the instructions
        Seen = set(Read['Address'] for Read in Reads[Before:])
        Reads += AsmReads(Function, Wrappers, Seen)
    Decompiler.dispose()
    return Reads, Wrappers, Failed


def ResolveWrapperCalls(Wrappers):
    """Calls to wrapper functions with a constant index argument."""
    Reads = []
    for Entry, (Wrapper, Slot, Second, ObjectText) in Wrappers.items():
        for Reference in References.getReferencesTo(Entry):
            if not Reference.getReferenceType().isCall():
                continue
            Call = Listing.getInstructionAt(Reference.getFromAddress())
            if Call is None:
                continue
            # Arg k is the (k+1)-th push before the call (thiscall: ECX is not pushed).
            Pushes = PreviousPushes(Call, Count=Slot + 1)
            if len(Pushes) <= Slot:
                continue
            Push = Pushes[Slot]
            Scalar = Push.getScalar(0)
            if Scalar is None:
                continue
            Caller = Functions.getFunctionContaining(Call.getAddress())
            if Caller is None:
                continue
            Reads.append({
                "Address": Call.getAddress(), "Function": Caller, "Prop": SignedArg(Scalar.getValue()),
                "Second": Second, "Object": "%s -> %s" % (Wrapper.getName(), ObjectText),
                "Confidence": "Wrapper", "Via": Wrapper.getName(),
            })
    return Reads


def Callers(Function):
    Names = set()
    for Reference in References.getReferencesTo(Function.getEntryPoint()):
        if Reference.getReferenceType().isCall():
            Caller = Functions.getFunctionContaining(Reference.getFromAddress())
            Names.add(Caller.getName() if Caller else str(Reference.getFromAddress()))
    return sorted(Names)


def VtableRefs(Function):
    """Data references to the function (usually vtable slots)."""
    Places = []
    for Reference in References.getReferencesTo(Function.getEntryPoint()):
        if Reference.getReferenceType().isData():
            From = Reference.getFromAddress()
            Symbol = Program.getSymbolTable().getPrimarySymbol(From)
            Places.append(str(From) + ("(" + Symbol.getName() + ")" if Symbol else ""))
    return Places


# ------------------------------------------------------------------ output
def MergeComment(Address, Text):
    Old = Listing.getComment(CodeUnit.EOL_COMMENT, Address)
    if Old:
        if Text in Old:
            return
        Old = re.sub(r"(^|; )" + CommentTag + r"-?\d+(\b.*?)?(?=;|$)", "", Old).strip("; ")
        Text = (Old + "; " + Text) if Old else Text
    Listing.setComment(Address, CodeUnit.EOL_COMMENT, Text)


def MergePlate(Function, Text):
    Old = Function.getComment() or ""
    Lines = [Line for Line in Old.split("\n") if not Line.startswith("RiotProps:")]
    Lines.append(Text)
    Function.setComment("\n".join(Line for Line in Lines if Line))


def ChooseFolder():
    try:
        return askDirectory("RiotPropertyReads - output folder / pasta de saida", "OK").getAbsolutePath()  # noqa: F821
    except Exception:
        Folder = os.environ.get("RIOT_PROPS_OUT") or os.getcwd()
        return Folder


def WriteReports(Reads, Wrappers, Failed, Folder):
    Base = os.path.join(Folder, Program.getName().replace(".", "_"))
    ByFunction = defaultdict(list)
    ByProp = defaultdict(set)
    for Read in Reads:
        ByFunction[Read["Function"]].append(Read)
        ByProp[Read["Prop"]].add(Read["Function"].getName())

    with open(Base + "_PropertyReads.csv", "w", newline="", encoding="utf-8") as Handle:
        Out = csv.writer(Handle)
        Out.writerow(["Address", "Function", "FunctionAddress", "Prop", "PropHex", "SecondArg", "Object", "Confidence", "Via"])
        for Read in sorted(Reads, key=lambda R: R["Address"].getOffset()):
            Out.writerow([str(Read["Address"]), Read["Function"].getName(), str(Read["Function"].getEntryPoint()),
                          Read["Prop"], "0x%x" % (Read["Prop"] & 0xFFFFFFFF), Read["Second"], Read["Object"],
                          Read["Confidence"], Read["Via"]])

    with open(Base + "_PropertyFunctions.csv", "w", newline="", encoding="utf-8") as Handle:
        Out = csv.writer(Handle)
        Out.writerow(["Function", "Address", "Props", "Count", "Callers", "VtableRefs", "IsWrapper"])
        for Function in sorted(ByFunction, key=lambda F: F.getEntryPoint().getOffset()):
            Props = sorted(set(R["Prop"] for R in ByFunction[Function]))
            Out.writerow([Function.getName(), str(Function.getEntryPoint()), " ".join(str(P) for P in Props),
                          len(ByFunction[Function]), " ".join(Callers(Function)), " ".join(VtableRefs(Function)),
                          "yes" if Function.getEntryPoint() in Wrappers else ""])
        for Entry, (Function, Slot, Second, ObjectText) in Wrappers.items():
            if Function not in ByFunction:
                Out.writerow([Function.getName(), str(Entry), "stackarg%d" % (Slot + 1), 0,
                              " ".join(Callers(Function)), " ".join(VtableRefs(Function)), "yes"])

    with open(Base + "_PropertyIndex.csv", "w", newline="", encoding="utf-8") as Handle:
        Out = csv.writer(Handle)
        Out.writerow(["Prop", "PropHex", "FunctionCount", "Functions"])
        for Prop in sorted(ByProp):
            Out.writerow([Prop, "0x%x" % (Prop & 0xFFFFFFFF), len(ByProp[Prop]), " ".join(sorted(ByProp[Prop]))])

    if Failed:
        with open(Base + "_PropertyFailed.txt", "w", encoding="utf-8") as Handle:
            for Function in Failed:
                Handle.write("%s %s\n" % (Function.getEntryPoint(), Function.getName()))
    return Base, ByFunction


def Annotate(Reads, ByFunction):
    for Read in Reads:
        Text = CommentTag + str(Read["Prop"])
        if Read["Via"]:
            Text += " (via " + Read["Via"] + ")"
        if WriteComments:
            MergeComment(Read["Address"], Text)
        if WriteBookmarks:
            Bookmarks.setBookmark(Read["Address"], "Analysis", "RiotProps", Text + " " + Read["Confidence"])
    if WritePlateSummary:
        for Function, Items in ByFunction.items():
            Props = sorted(set(R["Prop"] for R in Items))
            MergePlate(Function, "RiotProps: " + ", ".join(str(P) for P in Props))


# -------------------------------------------------------------------- main
def Main():
    Log("RiotPropertyReads: %s" % Program.getName())
    Candidates = FindCandidateFunctions()
    Log("  candidate functions / funcoes candidatas: %d" % len(Candidates))
    Reads, Wrappers, Failed = AnalyzeFunctions(Candidates)
    Log("  direct reads / leituras diretas: %d" % len(Reads))
    Log("  wrappers: %d" % len(Wrappers))
    WrapperReads = ResolveWrapperCalls(Wrappers)
    Log("  reads via wrappers / via wrappers: %d" % len(WrapperReads))
    Reads += WrapperReads
    Folder = ChooseFolder()
    Base, ByFunction = WriteReports(Reads, Wrappers, Failed, Folder)
    Annotate(Reads, ByFunction)
    Counts = defaultdict(int)
    for Read in Reads:
        Counts[Read["Confidence"]] += 1
    Log("  total: %d  %s" % (len(Reads), dict(Counts)))
    Log("  functions / funcoes: %d   failed / falharam: %d" % (len(ByFunction), len(Failed)))
    Log("  CSV: %s_Property*.csv" % Base)


Main()
