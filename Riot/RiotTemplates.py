"""
RiotTemplates — templates de objeto (.odu) / object templates
=============================================================

PT-BR
-----
Um .odu guarda milhares de "templates": a configuração padrão de cada objeto (classe + valores das
propriedades). As instâncias do .lvl apontam para um template e só sobrescrevem algumas propriedades.

Pedaço 0x0102 (um por template):
    0x00  u16 ModelIndex, u16 ModelPackage   modelo do objeto (0 = nenhum)
    0x04  8 bytes                            (desconhecido)
    0x0C  u16 HasExtraBlock                  1 = há um bloco de 64 bytes (transformação/limites) antes da classe
    B = 0x0E (+64 se HasExtraBlock)
    B+0   u32 ClassId
    B+4   u16 ?, u16 PropertyCount, u16 0, u16 SlotCount
    B+14  SlotCount × 4 bytes                um valor por propriedade, na ordem da classe; arrays (bit 0x1000 no
                                             tipo) guardam (contagem << 16) | deslocamento e os itens vêm depois
Pedaço 0x0103 (zlib): u32 = tamanho total da "memória de parâmetros" do pacote (Ghidra 0x4609F0).
Um único 0x0102 do jogo inteiro vem compactado com zlib (começa com 78 9C); ele é ignorado aqui.

Em tempo de execução o jogo lê a propriedade N com (**(obj->params + 8))(N, elemento); N conta também as
propriedades herdadas da classe base.

EN
--
A .odu holds thousands of templates: the default setup of each object (class + property values). Level
instances point to a template and override a few properties. Chunk 0x0102 layout above: model ref, header,
optional 64-byte block, ClassId, counts, then one 4-byte slot per property (arrays store count << 16 | offset).
"""
import struct
import zlib

from .RiotPackages import SplitRef


class RiotTemplate:
    """
    PT: Template decodificado: Package, Index, ModelRef (ou 0), Flags, ClassId, PropertyCount, Slots (lista de u32).
        Flags (u32 em +4) = flags do objeto-template (+0x20 no jogo), que lvl_ReadInstance (0x45A5C0) usa quando a
        instância não sobrescreve: bit 0 = projeta sombra dinâmica, bit 1 = par da sombra (0x800), bit 6 / bit 10 =
        grupo B, bit 7 = grupo C.
    EN: Decoded template. Flags (u32 at +4) = the template object's flags (game +0x20): bit 0 = casts dynamic shadow.
    """
    __slots__ = ('Package', 'Index', 'ModelRef', 'Flags', 'ClassId', 'PropertyCount', 'Slots')

    def __init__(self, Package, Index, Data):
        self.Package = Package
        self.Index = Index
        ModelIndex, ModelPackage = struct.unpack_from('<HH', Data, 0)
        self.ModelRef = (ModelPackage << 16) | ModelIndex if ModelPackage else 0
        self.Flags = struct.unpack_from('<I', Data, 4)[0]
        Base = 14 + (64 if struct.unpack_from('<H', Data, 12)[0] == 1 else 0)
        self.ClassId = struct.unpack_from('<I', Data, Base)[0]
        _Unknown, self.PropertyCount, _Zero, SlotCount = struct.unpack_from('<HHHH', Data, Base + 4)
        Start = Base + 14
        Available = max(0, (len(Data) - Start) // 4)
        Count = min(SlotCount, Available)
        self.Slots = list(struct.unpack_from('<%dI' % Count, Data, Start)) if Count else []

    def Slot(self, Number, Default=0):
        """PT: Valor bruto (u32) de uma propriedade. EN: Raw u32 value of a property."""
        return self.Slots[Number] if Number < len(self.Slots) else Default

    def SlotFloat(self, Number, Default=0.0):
        if Number >= len(self.Slots):
            return Default
        return struct.unpack('<f', struct.pack('<I', self.Slots[Number]))[0]

    def SlotArray(self, Number):
        """
        PT: Itens de uma propriedade-array: o slot guarda (contagem << 16) | deslocamento dentro de Slots.
        EN: Items of an array property: the slot holds (count << 16) | offset into Slots.
        """
        Header = self.Slot(Number)
        Offset, Count = Header & 0xFFFF, Header >> 16
        if 0 < Count and Offset + Count <= len(self.Slots):
            return self.Slots[Offset:Offset + Count]
        return []


def TemplateSlotOffset(Data):
    """PT: Posição do primeiro slot nos bytes (descomprimidos) do template. EN: Offset of slot 0 in the template bytes."""
    Base = 14 + (64 if struct.unpack_from('<H', Data, 12)[0] == 1 else 0)
    return Base + 14


def PatchTemplate(Raw, Changes):
    """
    PT: Novos bytes do pedaço 0x0102 com slots simples trocados ({índice: u32}); recomprime se o original era zlib.
        Listas não são editáveis aqui (o slot guarda (n << 16) | posição).
    EN: New 0x0102 bytes with scalar slots replaced; recompresses when the original was zlib.
    """
    Compressed = Raw[:2] == b'\x78\x9c'
    Data = bytearray(zlib.decompress(Raw) if Compressed else Raw)
    Start = TemplateSlotOffset(Data)
    Count = min(struct.unpack_from('<H', Data, Start - 14 + 10)[0], (len(Data) - Start) // 4)
    for Index, Value in Changes.items():
        if not 0 <= Index < Count:
            raise ValueError('slot %d out of range / slot fora do intervalo' % Index)
        struct.pack_into('<I', Data, Start + 4 * Index, Value & 0xFFFFFFFF)
    return zlib.compress(bytes(Data), 9) if Compressed else bytes(Data)


class RiotTemplateStore:
    """
    PT: Acesso aos templates de todos os pacotes, com cache.
    EN: Cached access to the templates of every package.
    """

    def __init__(self, Game):
        self.Game = Game
        self._Cache = {}

    def Get(self, Package, Index):
        """PT: Template (pacote, índice) ou None. EN: Template or None."""
        Key = (Package, Index)
        if Key in self._Cache:
            return self._Cache[Key]
        Result = None
        Container = self.Game.PackageContainer(Package, '.odu')
        if Container:
            Chunk = Container.Resource(Index).get(0x0102)
            if Chunk and Chunk.Size >= 28:
                Data = Container.ChunkData(Chunk)
                if Data[:2] == b'\x78\x9c':
                    try:
                        Data = zlib.decompress(Data)
                    except zlib.error:
                        Data = None
                if Data and len(Data) >= 28:
                    try:
                        Result = RiotTemplate(Package, Index, Data)
                    except struct.error:
                        Result = None
        self._Cache[Key] = Result
        return Result

    def GetRef(self, Ref):
        Package, Index = SplitRef(Ref)
        return self.Get(Package, Index)

    def ClassOf(self, Package, Index):
        Template = self.Get(Package, Index)
        return Template.ClassId if Template else None
