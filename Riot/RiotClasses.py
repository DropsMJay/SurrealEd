"""
RiotClasses — classes de objeto (.rfl e .exe) / object classes
==============================================================

PT-BR
-----
Cada objeto do jogo (template .odu, instância .lvl) tem uma classe identificada por um hash de 32 bits.
As classes da lógica do jogo ficam no Suffering.rfl / SufferingTTB.rfl (uma DLL comum); as classes do
próprio motor (materiais, luzes, terreno…) ficam numa tabela dentro do .exe.

Entrada da tabela de classes (28 bytes, nos dois arquivos):
    u32 ClassId (hash) · u32 ? · u32 flags · u32 ponteiro para o nome · u32 PropertyCount
    · u32 GroupCount · u32 ponteiro para a lista de grupos
Cada grupo -> {u32 contagem, u32 ponteiro} -> contagem × u32 código de tipo de propriedade.
A soma dos grupos é PropertyCount. Os nomes das propriedades NÃO existem nos arquivos.

Códigos de tipo observados: 0x0001 inteiro/bool, 0x0002 float, 0x000F cor 0x00RRGGBB,
0x2003/0x3003/0x4003 referência a objeto; o bit 0x1000 marca um array.
Tabela do motor no Suffering.exe em 0x5BB348 (achada pela string "Layered Material").

EN
--
Object classes are 32-bit hashes. Game-logic classes live in the .rfl (a regular PE DLL); engine classes
(materials, lights, terrain…) live in a table inside the .exe. Entry = 28 bytes: ClassId, ?, flags, name
pointer, PropertyCount, GroupCount, group list pointer; each group -> {count, pointer} -> property type codes.
Property *names* are not stored anywhere.
"""
import re
import struct


class RiotPE:
    """
    PT: Leitor mínimo de executáveis PE (só o necessário para converter endereços).
    EN: Minimal PE reader (just enough to convert addresses).
    """

    def __init__(self, Path):
        with open(Path, 'rb') as Handle:
            self.Data = Handle.read()
        Header = struct.unpack_from('<I', self.Data, 0x3C)[0]
        SectionCount = struct.unpack_from('<H', self.Data, Header + 6)[0]
        OptionalSize = struct.unpack_from('<H', self.Data, Header + 20)[0]
        self.ImageBase = struct.unpack_from('<I', self.Data, Header + 24 + 28)[0]
        self.Sections = []
        for Number in range(SectionCount):
            Name, VirtualSize, Rva, RawSize, RawOffset = struct.unpack_from('<8s4I', self.Data, Header + 24 + OptionalSize + 40 * Number)
            self.Sections.append((Name.rstrip(b'\0'), VirtualSize, Rva, RawSize, RawOffset))

    def AddressToOffset(self, Address):
        for _Name, VirtualSize, Rva, RawSize, RawOffset in self.Sections:
            Start = self.ImageBase + Rva
            if Start <= Address < Start + max(VirtualSize, RawSize):
                Offset = Address - Start
                return RawOffset + Offset if Offset < RawSize else None
        return None

    def OffsetToAddress(self, Offset):
        for _Name, _VirtualSize, Rva, RawSize, RawOffset in self.Sections:
            if RawOffset <= Offset < RawOffset + RawSize:
                return self.ImageBase + Rva + Offset - RawOffset
        return None

    def U32At(self, Address, Count=1):
        Offset = self.AddressToOffset(Address)
        if Offset is None:
            raise ValueError('address outside image')
        return struct.unpack_from('<%dI' % Count, self.Data, Offset)

    def CString(self, Address, Limit=96):
        Offset = self.AddressToOffset(Address)
        if Offset is None:
            return None
        Text = self.Data[Offset:Offset + Limit].split(b'\0')[0]
        return Text.decode('latin1') if Text and all(32 <= Byte < 127 for Byte in Text) else None


class RiotClass:
    """PT: Uma classe: Id, Name, PropertyTypes, Source ('rfl' ou 'engine'). EN: One class."""
    __slots__ = ('ClassId', 'Name', 'PropertyTypes', 'Source')

    def __init__(self, ClassId, Name, PropertyTypes, Source):
        self.ClassId = ClassId
        self.Name = Name
        self.PropertyTypes = PropertyTypes
        self.Source = Source

    def __repr__(self):
        return 'RiotClass(0x%08X %r, %d props)' % (self.ClassId, self.Name, len(self.PropertyTypes or ()))


def ReadRflClasses(Path):
    """
    PT: Lê todas as classes de um .rfl procurando, para cada texto, um ponteiro para ele no meio de uma entrada válida.
    EN: Reads every class of a .rfl by finding pointers to name strings inside valid table entries.
    """
    Pe = RiotPE(Path)
    Data = Pe.Data
    Pointers = {}
    for Name, _VirtualSize, _Rva, RawSize, RawOffset in Pe.Sections:
        if Name.startswith(b'.text'):
            continue
        for Offset in range(RawOffset, RawOffset + RawSize - 3, 4):
            Pointers.setdefault(struct.unpack_from('<I', Data, Offset)[0], []).append(Offset)
    Classes = {}
    for Name, _VirtualSize, Rva, RawSize, RawOffset in Pe.Sections:
        if Name.startswith(b'.text'):
            continue
        for Match in re.finditer(rb'[\x20-\x7e]{3,}\x00', Data[RawOffset:RawOffset + RawSize]):
            Address = Pe.ImageBase + Rva + Match.start()
            for Offset in Pointers.get(Address, ()):
                try:
                    ClassId, _X, _Flags, _NamePointer, PropertyCount, GroupCount, GroupPointer = struct.unpack_from('<7I', Data, Offset - 12)
                    if ClassId < 0x10000 or not (0 < GroupCount <= 64) or PropertyCount > 2000:
                        continue
                    Types = []
                    for Group in range(GroupCount):
                        GroupAddress = Pe.U32At(GroupPointer + 4 * Group)[0]
                        Count, ArrayAddress = Pe.U32At(GroupAddress, 2)
                        if Count:
                            Types += list(Pe.U32At(ArrayAddress, Count))
                    if len(Types) != PropertyCount:
                        continue
                    Classes[ClassId] = RiotClass(ClassId, Match.group()[:-1].decode('latin1'), Types, 'rfl')
                except (struct.error, ValueError, TypeError):
                    continue
    return Classes


def ReadEngineClasses(ExePath):
    """
    PT: Tabela de classes do motor dentro do .exe (ancorada pela string "Layered Material").
        Só nome e número de propriedades (os tipos não são necessários para o visualizador).
    EN: Engine class table inside the .exe (anchored by "Layered Material"). Name and property count only.
    """
    Pe = RiotPE(ExePath)
    Data = Pe.Data
    StringOffset = Data.find(b'Layered Material\0')
    if StringOffset < 0:
        return {}
    Anchor = Pe.OffsetToAddress(StringOffset)
    Row = Data.find(struct.pack('<I', Anchor))
    Classes = {}
    for Step in (28, -28):
        Offset = Row
        while 12 <= Offset < len(Data) - 8:
            NamePointer, PropertyCount = struct.unpack_from('<II', Data, Offset)
            ClassId = struct.unpack_from('<I', Data, Offset - 12)[0]
            Name = Pe.CString(NamePointer)
            if not Name or PropertyCount > 1000 or ClassId < 0x10000:
                break
            Classes[ClassId] = RiotClass(ClassId, Name, None, 'engine')
            Offset += Step
    return Classes


# PT: classes sem nome no .rfl, identificadas no jogo / EN: unnamed classes identified in-game
KnownUnnamed = {0x10D88BF0: 'Godray / alpha', 0x029E9104: 'Water volume', 0x1589A3E3: 'CCTV camera'}


class RiotClassTable:
    """PT: Todas as classes do jogo (rfl + motor). EN: Every class of the game (rfl + engine)."""

    def __init__(self, Game):
        self.Classes = {}
        try:
            self.Classes.update(ReadEngineClasses(Game.Exe))
        except (OSError, struct.error, ValueError):
            pass
        if Game.Rfl:
            self.Classes.update(ReadRflClasses(Game.Rfl))

    def Get(self, ClassId):
        return self.Classes.get(ClassId)

    def Name(self, ClassId):
        """PT: Nome da classe ou "?0x…". EN: Class name or "?0x…"."""
        Found = self.Classes.get(ClassId)
        if Found:
            return Found.Name
        return KnownUnnamed.get(ClassId, '?0x%08X' % ClassId)

    def PropertyTypes(self, ClassId):
        Found = self.Classes.get(ClassId)
        return Found.PropertyTypes if Found else None
