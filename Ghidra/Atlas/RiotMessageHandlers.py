# -*- coding: utf-8 -*-
"""
RiotMessageHandlers — onde cada mensagem é tratada / where each message is handled
===================================================================================
Variante de RiotMessageMaps.py (mesmo replay dos inicializadores e mesma busca de saídas) que grava, por classe, os
registros do mapa com a função de cada entrada (inclusive os herdados) e as funções que disparam cada saída, para
decompilar e dar nome aos slots. / Variant of RiotMessageMaps.py that also records each input's handler and the
functions that fire each output.

PT-BR
-----
Roda com o PyGhidra (fora do Ghidra) sobre um programa já analisado (Suffering.rfl / SufferingTTB.rfl, ou os .exe):

    python RiotMessageMaps.py <pasta do projeto> <nome do projeto> <programa> <classes.json> <saida.json>

classes.json = o JSON do Atlas com {id: {name, ctor, vtable, props[{index, type}]}}.

Como funciona (layout conferido também com o projeto "the-suffering-engine", docs/re/object-model.md §1):
  1. Os mapas de mensagem ficam no .data e são preenchidos por inicializadores estáticos do C++ (a tabela que o
     CRT passa para _initterm). O script acha essa tabela (PUSH fim; PUSH começo; CALL) e emula cada inicializador
     com o Unicorn, numa cópia da memória do programa.
  2. Cada construtor registra o seu mapa com `PUSH mapa; CALL [reg+0x34]`. Seguindo o construtor (e os
     construtores-base que ele chama), o último mapa registrado é o da classe mais derivada.
  3. Registro de 28 bytes: i32 mensagem, i32 propriedade, handler, 4 palavras.
       mensagem = -1, propriedade = P  -> entrada: o handler roda quando chega a mensagem guardada em P
       propriedade = -1                -> entrada fixa: roda quando chega a mensagem M
       -2, -2, …, pai (última palavra) -> continua no mapa da classe-pai
       -1, -1                          -> fim
  4. Saídas: chamadas `[despachante]->vt[1](handle próprio, propriedade, remetente)`. O despachante é o ponteiro
     global mais usado nesse padrão; o script procura PUSH <índice> antes de CALL [reg+4] nas funções da vtable,
     nos handlers e em até 2 níveis de chamadas. Só ficam índices de propriedades Enum (tipo 0x11).

EN
--
Runs under PyGhidra on an analysed program. Replays the C++ static initialisers with Unicorn to rebuild the
message maps in .data, finds each class's map from its constructor (`PUSH map; CALL [reg+0x34]`), parses the
28-byte records (inputs, fixed inputs, parent chain) and scans the class code for outputs
(`[dispatcher]->vt[1](self, property, sender)`), keeping Enum-typed properties only.
"""
import collections
import os
import json
import re
import struct
import sys

import pyghidra
import jpype

pyghidra.start(install_dir='/opt/ghidra_x/Ghidra12.0.4')
from ghidra.base.project import GhidraProject   # noqa: E402
from ghidra.app.cmd.function import CreateFunctionCmd   # noqa: E402
import unicorn                                    # noqa: E402
from unicorn import x86_const as X                # noqa: E402

Location, ProjectName, ProgramName, ClassesPath, OutPath = sys.argv[1:6]
Classes = json.load(open(ClassesPath))
Project = GhidraProject.openProject(Location, ProjectName, True)
Program = Project.openProgram('/', ProgramName, True)
Listing, Functions, Memory = Program.getListing(), Program.getFunctionManager(), Program.getMemory()
Space = Program.getAddressFactory().getDefaultAddressSpace()
Transaction = Program.startTransaction('RiotMessageMaps')   # PT: nada é salvo / EN: nothing is saved
Addr = lambda Value: Space.getAddress(Value)

# ---------------------------------------------------------------- memória / memory
Base = Program.getImageBase().getOffset()
Blocks = [Block for Block in Memory.getBlocks() if Block.isInitialized() and Block.getStart().getAddressSpace() == Space
          and Base <= Block.getStart().getOffset() < Base + 0x4000000]
Emu = unicorn.Uc(unicorn.UC_ARCH_X86, unicorn.UC_MODE_32)
Lo = min(Block.getStart().getOffset() for Block in Blocks) & ~0xFFF
Hi = (max(Block.getEnd().getOffset() for Block in Blocks) + 0x1000) & ~0xFFF
Emu.mem_map(Lo, Hi - Lo)
for Block in Blocks:
    Size = int(Block.getSize())
    JavaBytes = jpype.JArray(jpype.JByte)(Size)
    Block.getBytes(Block.getStart(), JavaBytes)
    Emu.mem_write(Block.getStart().getOffset(), bytes(bytearray(JavaBytes)) if not hasattr(JavaBytes, '__len__') else bytes((Value & 0xFF) for Value in JavaBytes))
Stack = 0x00200000
Emu.mem_map(Stack - 0x100000, 0x100000)
Sentinel = 0x00080000
Emu.mem_map(Sentinel, 0x1000)


def IsFunction(Value):
    return Functions.getFunctionAt(Addr(Value)) is not None if Lo <= Value < Hi else False


def Read32(Value):
    return struct.unpack('<I', bytes(Emu.mem_read(Value, 4)))[0]


# ---------------------------------------------------------------- 1. inicializadores / initialisers
Tables = []
Executable = [(Block.getStart().getOffset(), Block.getEnd().getOffset()) for Block in Blocks if Block.isExecute()]
InCode = lambda Value: any(Start <= Value <= End for Start, End in Executable) or IsFunction(Value)
for Instruction in Listing.getInstructions(True):
    if Instruction.getMnemonicString() != 'CALL':
        continue
    # PT: _initterm(começo, fim): "PUSH fim; PUSH começo" ou "MOV [ESP], fim; PUSH começo"
    # EN: _initterm(begin, end): "PUSH end; PUSH begin" or "MOV [ESP], end; PUSH begin"
    Previous, Scalars = Instruction.getPrevious(), []
    for _Step in range(3):
        if Previous is None:
            break
        for Operand in range(Previous.getNumOperands()):
            Scalar = Previous.getScalar(Operand)
            if Scalar is not None:
                Scalars.append(Scalar.getUnsignedValue())
        Previous = Previous.getPrevious()
    if len(Scalars) < 2:
        continue
    Begin = Scalars[0]
    for End in Scalars[1:]:
        if not (Lo <= Begin < End < Hi) or (End - Begin) % 4 or End - Begin > 0x4000:
            continue
        Entries = [Read32(Begin + 4 * Number) for Number in range((End - Begin) // 4)]
        if sum(1 for Entry in Entries if InCode(Entry)) >= 8 and all(Entry == 0 or InCode(Entry) for Entry in Entries):
            Tables.append((Begin, End, [Entry for Entry in Entries if Entry]))
Tables = sorted(set((Begin, End, tuple(Entries)) for Begin, End, Entries in Tables))
print('initialiser tables', [(hex(Begin), hex(End), len(Entries)) for Begin, End, Entries in Tables])




FunctionCache = {}


def Known(Value):
    if Value not in FunctionCache:
        FunctionCache[Value] = IsFunction(Value)
    return FunctionCache[Value]


def OnCode(UC, Address, Size, User):
    """
    PT: Pula chamadas para fora das funções conhecidas (importações, CRT): segue com EAX = 0.
    EN: Skips calls that leave the known functions (imports, CRT): continue with EAX = 0.
    """
    Code = bytes(UC.mem_read(Address, 2))
    if Code[0] == 0xE8:
        Target = (Address + 5 + struct.unpack('<i', bytes(UC.mem_read(Address + 1, 4)))[0]) & 0xFFFFFFFF
        if not Known(Target):
            UC.reg_write(X.UC_X86_REG_EIP, Address + 5)
            UC.reg_write(X.UC_X86_REG_EAX, 0)
    elif Code[0] == 0xFF and (Code[1] & 0x38) == 0x10:
        # PT: CALL indireto: só segue se o alvo for função conhecida / EN: indirect call: follow known targets only
        Length = Size
        UC.reg_write(X.UC_X86_REG_EIP, Address + Length)
        UC.reg_write(X.UC_X86_REG_EAX, 0)


Emu.hook_add(unicorn.UC_HOOK_CODE, OnCode)


Failures = 0
for _Begin, _End, Entries in Tables:
    for Entry in Entries:
        Emu.reg_write(X.UC_X86_REG_ESP, Stack - 0x1000)
        Emu.mem_write(Stack - 0x1000, struct.pack('<I', Sentinel))
        try:
            Emu.emu_start(Entry, Sentinel, count=200000)
        except unicorn.UcError:
            Failures += 1
print('initialisers run', sum(len(Entries) for _B, _E, Entries in Tables), 'failed', Failures)

# ---------------------------------------------------------------- 2. mapas pelos construtores / maps from constructors
def Registrations(Start, Depth=0, Seen=None):
    """PT: Mapas registrados por um construtor, na ordem de execução. EN: Maps registered, in execution order."""
    Seen = Seen if Seen is not None else set()
    Function = Functions.getFunctionAt(Addr(Start))
    if not Function or Start in Seen or Depth > 3:
        return []
    Seen.add(Start)
    Found, Pushes = [], []
    for Instruction in Listing.getInstructions(Function.getBody(), True):
        Text = str(Instruction)
        Mnemonic = Instruction.getMnemonicString()
        if Mnemonic == 'PUSH':
            Scalar = Instruction.getScalar(0)
            Pushes.append(Scalar.getUnsignedValue() if Scalar is not None else None)
            continue
        if Mnemonic == 'CALL':
            if re.search(r'\[(E[A-D]X|E[SD]I)\s*\+\s*0x34\]', Text) and Pushes and Pushes[-1] and Lo <= Pushes[-1] < Hi and not IsFunction(Pushes[-1]):
                Found.append(Pushes[-1])
            else:
                Target = Instruction.getFlows()
                if Target and len(Target) == 1:
                    Found += Registrations(Target[0].getOffset(), Depth + 1, Seen)
            Pushes = []
    return Found


def ParseMap(Start):
    """PT: Entradas, entradas fixas e a cadeia de mapas. EN: Inputs, fixed inputs and the map chain."""
    Inputs, Fixed, Chain, Handlers = [], [], [], set()
    global Records
    Records = []
    Map, Guard = Start, 0
    while Map and Guard < 40:
        Chain.append(Map)
        Guard += 1
        Next = None
        for Number in range(256):
            Words = struct.unpack('<7i', bytes(Emu.mem_read(Map + 28 * Number, 28)))
            if Words[0] == -2 and Words[1] == -2:
                Next = Words[6] & 0xFFFFFFFF
                break
            if Words[0] == -1 and Words[1] == -1:
                break
            Records.append((Words[0], Words[1], Words[2] & 0xFFFFFFFF, Map))
            if Words[0] == -1:
                Inputs.append(Words[1])
            else:
                Fixed.append(Words[0])
            if Words[2]:
                Handlers.add(Words[2] & 0xFFFFFFFF)
        Map = Next if Next and Lo <= Next < Hi and Next not in Chain else None
    return Inputs, Fixed, Chain, Handlers


# ---------------------------------------------------------------- 3. saídas / outputs
def EnsureFunction(Start):
    """PT: Cria a função se o Ghidra não criou (handlers e funções de vtable). EN: Creates missing functions."""
    Function = Functions.getFunctionAt(Addr(Start))
    if Function is None and Lo <= Start < Hi and Listing.getInstructionAt(Addr(Start)) is not None or (Function is None and InCode(Start)):
        CreateFunctionCmd(Addr(Start)).applyTo(Program)
        Function = Functions.getFunctionAt(Addr(Start))
    return Function


def Callees(Start, Depth):
    Function = EnsureFunction(Start)
    if not Function:
        return set()
    Result = {Start}
    if Depth <= 0:
        return Result
    for Called in Function.getCalledFunctions(None):
        Result |= Callees(Called.getEntryPoint().getOffset(), Depth - 1)
    return Result


Registers = ('EAX', 'EBX', 'ECX', 'EDX', 'ESI', 'EDI', 'EBP')


Wrappers = {}


def OutputCalls(Start):
    """
    PT: (global, índice) de cada CALL [reg+4] cujo objeto veio de MOV reg,[global]. O índice é o 2º argumento:
        um PUSH imediato ou um registrador com valor conhecido (MOV imm, XOR, NEG/SBB = {0,-1}, AND/OR/ADD/SUB/INC/DEC
        imediatos), então "cond ? A : B" compilado sem salto também é resolvido.
    EN: (global, index) of each CALL [reg+4] whose object came from MOV reg,[global]; the index is the 2nd argument,
        an immediate PUSH or a register with known values (handles branch-free "cond ? A : B").
    """
    Function = EnsureFunction(Start)
    if not Function:
        return []
    Result = []
    Values = {}           # registrador -> conjunto de valores / register -> set of values
    Loaded = {}           # registrador -> global carregado / register -> loaded global
    Pushes = []
    for Instruction in Listing.getInstructions(Function.getBody(), True):
        Mnemonic = Instruction.getMnemonicString()
        Text = str(Instruction)
        Operands = [Instruction.getDefaultOperandRepresentation(Number) for Number in range(Instruction.getNumOperands())]
        Destination = Operands[0] if Operands else None
        Scalar = Instruction.getScalar(1) if Instruction.getNumOperands() > 1 else None
        Immediate = Scalar.getSignedValue() if Scalar is not None and Destination in Registers and '[' not in Text.split(',', 1)[-1] else None
        if Mnemonic == 'PUSH':
            if Instruction.getScalar(0) is not None:
                Pushes.append({Instruction.getScalar(0).getUnsignedValue()})
            elif Destination in Values:
                Pushes.append(set(Values[Destination]))
            else:
                Pushes.append(None)
            continue
        if Mnemonic == 'CALL':
            Match = re.search(r'\[(E[A-D]X)\s*\+\s*0x4\]$', Text)
            Global = None
            if Match:
                # PT: objeto = [global]; vtable lida dele / EN: object = [global]; its vtable was read
                for Register, Source in Loaded.items():
                    if Source is not None:
                        Global = Source
            if Match and Global is not None and len(Pushes) >= 3 and Pushes[-2]:
                for Value in Pushes[-2]:
                    Value &= 0xFFFFFFFF
                    if Value < 400:
                        Result.append((Global, Value))
            elif Match and Global is not None and len(Pushes) >= 3:
                Result.append((Global, None))          # PT: índice vindo de argumento = função "fire" / EN: wrapper
            elif not Match:
                Flows = Instruction.getFlows()
                if Flows and len(Flows) == 1 and Flows[0].getOffset() in Wrappers:
                    for Pushed in Pushes[-3:]:
                        for Value in Pushed or ():
                            Value &= 0xFFFFFFFF
                            if Value < 400:
                                Result.append((Wrappers[Flows[0].getOffset()], Value))
            # PT: EBX/ESI/EDI/EBP sobrevivem a chamadas (cdecl/thiscall) / EN: callee-saved registers survive calls
            Pushes = []
            for Volatile in ('EAX', 'ECX', 'EDX'):
                Values.pop(Volatile, None)
                Loaded.pop(Volatile, None)
            continue
        if Destination not in Registers:
            continue
        if Mnemonic == 'MOV':
            Match = re.match(r'MOV E[A-D]X,(?:dword ptr )?\[0x([0-9a-f]+)\]$', Text)
            Loaded.pop(Destination, None)
            if Match:
                Loaded[Destination] = int(Match.group(1), 16)
                Values.pop(Destination, None)
            elif Immediate is not None:
                Values[Destination] = {Immediate}
            elif len(Operands) > 1 and Operands[1] in Loaded:
                Loaded[Destination] = Loaded[Operands[1]]
                Values.pop(Destination, None)
            elif len(Operands) > 1 and Operands[1] in Values:
                Values[Destination] = set(Values[Operands[1]])
            else:
                Values.pop(Destination, None)
        elif Mnemonic == 'XOR' and len(Operands) > 1 and Operands[1] == Destination:
            Values[Destination] = {0}
        elif Mnemonic == 'NEG':
            Values[Destination] = {0, 1} if Destination not in Values else {-Value for Value in Values[Destination]} | {0}
        elif Mnemonic == 'SBB' and len(Operands) > 1 and Operands[1] == Destination:
            Values[Destination] = {0, -1}
        elif Mnemonic in ('AND', 'OR', 'ADD', 'SUB') and Immediate is not None and Destination in Values:
            Operation = {'AND': lambda A: A & Immediate, 'OR': lambda A: A | Immediate, 'ADD': lambda A: A + Immediate, 'SUB': lambda A: A - Immediate}[Mnemonic]
            Values[Destination] = {Operation(Value) for Value in Values[Destination]}
        elif Mnemonic in ('INC', 'DEC') and Destination in Values:
            Values[Destination] = {Value + (1 if Mnemonic == 'INC' else -1) for Value in Values[Destination]}
        elif Mnemonic == 'SETNZ' or Mnemonic == 'SETZ':
            Values[Destination] = {0, 1}
        else:
            Values.pop(Destination, None)
            if Mnemonic != 'MOV':
                Loaded.pop(Destination, None)
    return Result


# PT: funções que disparam uma saída com o índice recebido como argumento (ex.: GameObject::Fire(índice))
# EN: functions that fire an output whose index comes from an argument (wrappers)
Wrappers = {}
for _Round in range(2):
    for Function in Functions.getFunctions(True):
        Entry = Function.getEntryPoint().getOffset()
        for Global, Index in OutputCalls(Entry):
            if Index is None and Global is not None:
                Wrappers[Entry] = Global
print('output wrappers', len(Wrappers))

Rows, Candidates, Sites = {}, {}, {}
for ClassId, Info in Classes.items():
    Types = {Prop['index']: Prop['type'] for Prop in Info.get('props', [])}
    Ctor = int(Info['ctor'], 16) if Info.get('ctor') else None
    Maps = Registrations(Ctor) if Ctor else []
    Inputs, Fixed, Chain, Handlers = ParseMap(Maps[-1]) if Maps else ([], [], [], set())
    MapRecords = [[Message, Property, hex(Handler), hex(Map)] for Message, Property, Handler, Map in (Records if Maps else [])]
    Code = set()
    Vtable = int(Info['vtable'], 16) if Info.get('vtable') else None
    if Vtable:
        for Number in range(160):
            Entry = Read32(Vtable + 4 * Number)
            if not InCode(Entry):
                break
            Code.add(Entry)
    Code |= Handlers
    Reach = set()
    for Start in Code:
        Reach |= Callees(Start, 2)
    Candidates[ClassId] = [(Global, Index) for Start in Reach for Global, Index in OutputCalls(Start) if Index is not None and Types.get(Index) == 0x11]
    Sites[ClassId] = [(Global, Index, Start) for Start in Reach for Global, Index in OutputCalls(Start) if Index is not None and Types.get(Index) == 0x11]
    Rows[ClassId] = {'name': Info.get('name'), 'maps': [hex(Map) for Map in Chain], 'inputs': sorted(set(Inputs)),
                     'fixed': sorted(set(Fixed)), 'outputs': [],
                     'inputs_enum': all(Types.get(Index) == 0x11 for Index in Inputs), 'records': MapRecords}

# PT: o despachante é o global que mais aparece com índices de propriedades Enum / EN: the dispatcher global
Dispatcher = collections.Counter(Global for Pairs in Candidates.values() for Global, _Index in Pairs)
DispatchGlobal = Dispatcher.most_common(1)[0][0] if Dispatcher else None
print('dispatcher global', hex(DispatchGlobal) if DispatchGlobal else None, [(hex(Global), Count) for Global, Count in Dispatcher.most_common(3)])
for ClassId, Pairs in Candidates.items():
    Rows[ClassId]['outputs'] = sorted({Index for Global, Index in Pairs if Global == DispatchGlobal})
    Where = collections.defaultdict(set)
    for Global, Index, Start in Sites[ClassId]:
        if Global == DispatchGlobal:
            Where[Index].add(hex(Start))
    Rows[ClassId]['output_sites'] = {str(Index): sorted(Functions_) for Index, Functions_ in Where.items()}
Result = Rows
json.dump(Result, open(OutPath, 'w'), indent=1)
print('classes', len(Result), 'with map', sum(1 for Row in Result.values() if Row['maps']),
      'with outputs', sum(1 for Row in Result.values() if Row['outputs']))
