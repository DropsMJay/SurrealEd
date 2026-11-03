"""
RiotLevel — fases (.lvl) / levels
=================================

PT-BR
-----
Pedaços de um .lvl (carregador FUN_004670B0):

    0x0402  versão (0x12F)
    0x0000  nome da fase (u16 + texto), largura, altura, nº de bancos e caminhos
    0x0001  terreno em camadas ("layers") — FUN_0049FEB0
    0x0003  u32 (205000…524000; provável orçamento de memória)
    0x0020  instâncias de objeto — FUN_0045A5C0 (lvl_ReadInstance)
    0x0026  árvore de células / salas — FUN_004B7120
    0x0027  portais e PVS — FUN_004BDB30
    0x0028  histórico do editor (quem criou/modificou cada instância e quando) — só o editor lê

Instância (0x0020): u16 quantidade; quantidade × {u32 id, u16 índice do template, u16 pacote}; depois um
registro por instância:
    3 f32 posição (TS1 × 2048; TTB em unidades do mundo) · u32 Flags (bit 1 = visível)
    [f32 se Flags & 0x10] · i16 n + n × u32 ligações · 3 × i16 rotação em graus (X, Y, Z)
    [3 f32 escala se Flags & 0x100] · u32 nValores, u32 nPropriedades
    [nValores × u32 valores + nPropriedades × u16 índices de propriedade, se ambos > 0]
    [se Flags & 0x8000: u32 ref de modelo próprio, 4 f32 esfera, 12 f32 matriz]
    u32 Tail (ref da luz pré-calculada no _level.ldu)
Transformação (FUN_0045A5C0): rotação Ry·Rx·Rz com yaw = arquivo − 90°, depois escala nos eixos do MUNDO,
depois translação.

Terreno (0x0001): u32 nCamadas; cada camada: id, largura, altura, tipo, origem X/Z, Y, nome, flags,
água (ref + parâmetros + ondas), normais int8×4, u32; depois u32 "comprimido" e um bloco por camada
(zlib se comprimido): (L+1)(A+1) vértices {u32 flags, u16 altura} + L×A faces de 22 bytes
{u16 flags, i32 ref do material, 8 × u16 UV}. Altura do vértice = Y + (h − 0x8000) × 2.

Células (0x0026), portais (0x0027) e histórico (0x0028): formatos completos em RiotLevel.ReadCells,
ReadPortals e ReadHistory (diferenças da TTB documentadas lá).

EN
--
Level chunks listed above. Instances (0x0020) follow FUN_0045A5C0 exactly; terrain layers (0x0001) follow
FUN_0049FEB0; cell tree / portals / PVS (0x0026/0x0027) follow FUN_004B7120 / FUN_004BDB30.
"""
import datetime
import struct
import zlib

from .RiotContainer import RiotContainer, RiotReader


class LevelFormatError(Exception):
    pass


# ---------------------------------------------------------------------------------------------- instâncias
def ReadInstances(Container):
    """
    PT: Lista de instâncias (dicionários) na ordem do arquivo, e se o pedaço foi lido até o fim.
    EN: Instance list (dicts) in file order, and whether the chunk was read to the end.
    """
    Chunk = Container.FirstOfType(0x0020)
    if not Chunk:
        return [], True
    Data = Container.ChunkData(Chunk)
    Count = struct.unpack_from('<H', Data, 0)[0]
    Index = [struct.unpack_from('<IHH', Data, 2 + 8 * Number) for Number in range(Count)]
    Reader = RiotReader(Data, 2 + 8 * Count)
    Instances = []
    for Number in range(Count):
        Start = Reader.Position
        try:
            Instance = _ReadInstance(Reader)
        except (struct.error, LevelFormatError):
            return Instances, False
        Instance['Id'], Instance['TemplateIndex'], Instance['TemplatePackage'] = Index[Number]
        Instance['Start'] = Start
        Instances.append(Instance)
    return Instances, Reader.Position == len(Data)


def _ReadInstance(Reader):
    Position = Reader.Unpack('<3f')
    Flags = Reader.U32()
    Extra = Reader.F32() if Flags & 0x10 else None
    LinkCount = Reader.I16()
    if not 0 <= LinkCount <= 1000:
        raise LevelFormatError('links')
    Links = list(Reader.Unpack('<%dI' % LinkCount)) if LinkCount else []
    Rotation = Reader.Unpack('<3h')
    Scale = Reader.Unpack('<3f') if Flags & 0x100 else (1.0, 1.0, 1.0)
    ValueCount, PropertyCount = Reader.Unpack('<II')
    if ValueCount > 4000 or PropertyCount > 4000:
        raise LevelFormatError('counts')
    Values, PropertyIndexes = [], []
    RawCounts = (ValueCount, PropertyCount)
    if ValueCount and PropertyCount:
        Values = list(Reader.Unpack('<%dI' % ValueCount))
        PropertyIndexes = list(Reader.Unpack('<%dH' % PropertyCount))
    OwnModel = None
    if Flags & 0x8000:
        OwnModel = {'ModelRef': Reader.U32(), 'Sphere': Reader.Unpack('<4f'), 'Matrix': Reader.Unpack('<12f')}
    Tail = Reader.U32()
    return {'Position': Position, 'Flags': Flags, 'Extra': Extra, 'Links': Links, 'Rotation': Rotation, 'Scale': Scale,
            'Values': Values, 'PropertyIndexes': PropertyIndexes, 'OwnModel': OwnModel, 'Tail': Tail,
            'RawValueCount': RawCounts[0], 'RawPropertyCount': RawCounts[1]}


def WriteInstances(Instances):
    """
    PT: Pedaço 0x0020 a partir da lista de instâncias (inverso de ReadInstances). Os campos opcionais seguem as
        flags: 0x10 = valor extra, 0x100 = escala, 0x8000 = modelo próprio. Ligar ou desligar uma dessas flags exige
        o campo correspondente (WriteInstances preenche com o padrão do jogo se faltar).
    EN: Chunk 0x0020 from the instance list (inverse of ReadInstances). Optional fields follow the flags.
    """
    Out = bytearray(struct.pack('<H', len(Instances)))
    for Instance in Instances:
        Out += struct.pack('<IHH', Instance['Id'], Instance['TemplateIndex'], Instance['TemplatePackage'])
    for Instance in Instances:
        Flags = Instance['Flags']
        Out += struct.pack('<3fI', *Instance['Position'], Flags)
        if Flags & 0x10:
            Extra = Instance['Extra']
            Out += struct.pack('<f', Extra if Extra is not None else struct.unpack('<f', struct.pack('<I', 0x5F0AC723))[0])
        Out += struct.pack('<h', len(Instance['Links']))
        if Instance['Links']:
            Out += struct.pack('<%dI' % len(Instance['Links']), *Instance['Links'])
        Out += struct.pack('<3h', *Instance['Rotation'])
        if Flags & 0x100:
            Out += struct.pack('<3f', *Instance['Scale'])
        Values, Indexes = Instance['Values'], Instance['PropertyIndexes']
        if Values and Indexes:
            Out += struct.pack('<II', len(Values), len(Indexes))
            Out += struct.pack('<%dI' % len(Values), *Values)
            Out += struct.pack('<%dH' % len(Indexes), *Indexes)
        else:
            Out += struct.pack('<II', Instance.get('RawValueCount', 0) if not Indexes else 0, Instance.get('RawPropertyCount', 0) if not Values else 0)
        if Flags & 0x8000:
            Own = Instance['OwnModel'] or {'ModelRef': 0, 'Sphere': (0.0,) * 4, 'Matrix': (1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0, 0, 0, 0)}
            Out += struct.pack('<I4f12f', Own['ModelRef'], *Own['Sphere'], *Own['Matrix'])
        Out += struct.pack('<I', Instance['Tail'])
    return bytes(Out)


def SetInstanceProperty(Instance, Index, Value, PropertyTypes):
    """
    PT: Sobrescreve uma propriedade simples (não lista) na instância. Os valores das listas ficam no fim de Values e o
        cabeçalho de cada lista ((n << 16) | posição) aponta para lá; ao inserir um valor novo antes deles, as posições
        são corrigidas.
    EN: Overrides a scalar property on the instance; list headers ((n << 16) | offset) are shifted when a new value is
        inserted before the list storage.
    """
    Indexes, Values = Instance['PropertyIndexes'], Instance['Values']
    if PropertyTypes and Index < len(PropertyTypes) and PropertyTypes[Index] & 0x1000:
        raise ValueError('list properties are not editable yet / listas ainda não são editáveis')
    if Index in Indexes:
        Values[Indexes.index(Index)] = Value & 0xFFFFFFFF
        return
    Position = len(Indexes)
    for Number, Other in enumerate(Indexes):
        if PropertyTypes and Other < len(PropertyTypes) and PropertyTypes[Other] & 0x1000 and Values[Number] >> 16:
            Values[Number] += 1
    Indexes.append(Index)
    Values.insert(Position, Value & 0xFFFFFFFF)


def InstanceProperties(Template, Instance):
    """
    PT: Valores finais das propriedades (template + sobrescritas da instância), como {índice: u32}.
    EN: Final property values (template + instance overrides) as {index: u32}.
    """
    Result = dict(enumerate(Template.Slots)) if Template else {}
    for PropertyIndex, Value in zip(Instance['PropertyIndexes'], Instance['Values']):
        Result[PropertyIndex] = Value
    return Result


# ---------------------------------------------------------------------------------------------- terreno
def ReadTerrainLayers(Container):
    """
    PT: Camadas de terreno (pedaço 0x0001). Cada camada pode ter um bloco de "splat" (como o jogo mistura as
        texturas do chão, desenho em FUN_004994F0, montagem em FUN_004A4A80):
            u32 textura base (ref no pacote _level; 0 = camada sem splat, usa a textura de cada face)
            u32 Size, X0, X1, Y0, Y1   retângulo da camada nessa textura (pixels, 4 por célula; u = (X0 + 0,5 +
                                       coluna·(X1−X0)/largura) / Size)
            u32 n, n × pedaço {u32 x0, x1, z0, z1 (células); u32 m, m × ref de material de paisagem;
                               u32 gx, gy, gz; gx·gy·gz bytes = um byte por vértice e por material}
        Byte do splat: bit 0x10 = a face cujo canto superior esquerdo é esse vértice recebe esse material;
        bits 0..2 = nível de alfa do vértice, tabela [0; 0,8; 0,9; 0,95; 1]. A textura do material é projetada
        de cima (u = x / prop 4 do material) e some com a distância (prop 7).
    EN: Terrain layers (chunk 0x0001) with the splat block described above (base texture atlas + per-vertex,
        per-material blend bytes).
    """
    Chunk = Container.FirstOfType(0x0001)
    if not Chunk:
        return []
    Reader = RiotReader(Container.ChunkData(Chunk))
    Layers = []
    for _Layer in range(Reader.U32()):
        Layer = {'Id': Reader.U32(), 'Width': Reader.I32(), 'Height': Reader.I32(), 'Type': Reader.U32(),
                 'OriginX': Reader.I32(), 'OriginZ': Reader.I32(), 'Y': Reader.F32(), 'Name': Reader.String16(), 'Flags': Reader.U32()}
        # PT: bloco de "splat" (mistura de texturas do terreno, ver ReadTerrainLayers acima)
        # EN: splat block (terrain texture blending, see the notes above)
        BaseTexture = Reader.U32()
        Layer['Splat'] = None
        if BaseTexture:
            Size, X0, X1, Y0, Y1 = Reader.Unpack('<5I')
            Chunks = []
            for _Chunk in range(Reader.U32()):
                CX0, CX1, CZ0, CZ1 = Reader.Unpack('<4I')
                Count = Reader.U32()
                Materials = list(Reader.Unpack('<%dI' % Count)) if Count else []
                GridX, GridY, GridZ = Reader.Unpack('<3I')
                Chunks.append({'X0': CX0, 'X1': CX1, 'Z0': CZ0, 'Z1': CZ1, 'Materials': Materials,
                               'GridX': GridX, 'GridY': GridY, 'Grid': Reader.Bytes(GridX * GridY * GridZ)})
            Layer['Splat'] = {'BaseTexture': BaseTexture, 'Size': Size, 'Rect': (X0, X1, Y0, Y1), 'Chunks': Chunks}
        VertexNormals = 1 if Layer['Flags'] & 4 else (Layer['Width'] + 1) * (Layer['Height'] + 1)
        Reader.Bytes(VertexNormals * 4)
        Layer['Tail'] = Reader.U32()
        Layers.append(Layer)
    Compressed = Reader.U32()
    for Layer in Layers:
        Size = Reader.U32()
        Blob = Reader.Bytes(Size)
        if Compressed:
            Blob = zlib.decompress(Blob)
        Width, Height = Layer['Width'], Layer['Height']
        VertexCount = (Width + 1) * (Height + 1)
        if len(Blob) != Width * Height * 22 + VertexCount * 6:
            raise LevelFormatError('terrain block size')
        Heights = struct.unpack_from('<' + 'xxxxH' * VertexCount, Blob, 0)
        Layer['Heights'] = [Layer['Y'] + (Value - 0x8000) * 2 for Value in Heights]
        Layer['Faces'] = [struct.unpack_from('<Hi8H', Blob, 6 * VertexCount + 22 * Number) for Number in range(Width * Height)]
    return Layers


# ---------------------------------------------------------------------------------------------- células e portais
def ReadCells(Data, IsTTB=None):
    """
    PT: Árvore de células (0x0026).
        TS1: cabeçalho 5 × u32 (parâmetro, nNós, a, b, c; a + b = nº de objetos).
        Nó: u32 tipo (0 célula, 1 sala com nome), u32 24, u16 pai, u16 1º filho, u16 irmão,
            6 f32 caixa (máximo xyz, mínimo xyz), u32, u16 tamanho + nome.
        Objeto (42 bytes): u32 tipo (2 = instância, 3 = peça de geometria), u32 tabela (bits 0x18…),
            u32 célula, u16 próximo, 6 f32 caixa, u32 id.
        TTB: 8 bytes antes do cabeçalho, u32 a mais depois do nome de cada nó, objeto com 46 bytes.
    EN: Cell tree (0x0026); TS1/TTB layouts as above. IsTTB=None tries both.
    """
    if IsTTB is None:
        try:
            Result = ReadCells(Data, False)
            if Result[3] == len(Data):
                return Result[:3]
        except struct.error:
            pass
        return ReadCells(Data, True)[:3]
    Base = 8 if IsTTB else 0
    Header = struct.unpack_from('<5I', Data, Base)
    Position = Base + 20
    Nodes = []
    for _Node in range(Header[1]):
        Kind, _Size, Parent, Child, Sibling = struct.unpack_from('<IIHHH', Data, Position)
        Box = struct.unpack_from('<6f', Data, Position + 14)
        Extra, Length = struct.unpack_from('<IH', Data, Position + 38)
        Name = Data[Position + 44:Position + 44 + Length].split(b'\0')[0].decode('latin1')
        Nodes.append({'Kind': Kind, 'Parent': Parent, 'Child': Child, 'Sibling': Sibling,
                      'Max': Box[0:3], 'Min': Box[3:6], 'Extra': Extra, 'Name': Name})
        Position += 44 + Length + (4 if IsTTB else 0)
    Objects = []
    EntrySize = 46 if IsTTB else 42
    for _Object in range(Header[2] + Header[3]):
        Kind, Table, Cell, Next = struct.unpack_from('<IIIH', Data, Position)
        Box = struct.unpack_from('<6f', Data, Position + 14)
        ObjectId = struct.unpack_from('<I', Data, Position + 38)[0]
        Objects.append({'Kind': Kind, 'Table': Table, 'Cell': Cell, 'Next': Next, 'Max': Box[0:3], 'Min': Box[3:6], 'Id': ObjectId})
        Position += EntrySize
    return Header, Nodes, Objects, Position


def ReadPortals(Data, IsTTB=None):
    """
    PT: Portais e PVS (0x0027). u32 nCélulas; por célula: u32 nó (índice no 0x0026), u32 n,
        n × {u32 instância Portal, u16 célula destino, u16 flags (bit 4 = inverte o plano)}
        [TTB: + u32 m, m × u32 lista extra]. Depois u32 M + M × u16: para cada célula, contagem + células visíveis.
    EN: Portals and PVS (0x0027), layout above.
    """
    if IsTTB is None:
        try:
            Cells, End = ReadPortals(Data, False)
            if End == len(Data):
                return Cells
        except struct.error:
            pass
        return ReadPortals(Data, True)[0]
    Count = struct.unpack_from('<I', Data, 0)[0]
    Position = 4
    Cells = []
    for _Cell in range(Count):
        Node, PortalCount = struct.unpack_from('<II', Data, Position)
        Position += 8
        Portals = []
        for Number in range(PortalCount):
            Instance, Target, Flags = struct.unpack_from('<IHH', Data, Position + 8 * Number)
            Portals.append({'Instance': Instance, 'Target': Target, 'Flags': Flags})
        Position += 8 * PortalCount
        Extra = []
        if IsTTB:
            ExtraCount = struct.unpack_from('<I', Data, Position)[0]
            Position += 4
            Extra = list(struct.unpack_from('<%dI' % ExtraCount, Data, Position))
            Position += 4 * ExtraCount
        Cells.append({'Node': Node, 'Portals': Portals, 'Extra': Extra})
    Total = struct.unpack_from('<I', Data, Position)[0]
    Position += 4
    Raw = struct.unpack_from('<%dH' % Total, Data, Position)
    Position += 2 * Total
    Cursor = 0
    for Cell in Cells:
        Cell['Visible'] = list(Raw[Cursor + 1:Cursor + 1 + Raw[Cursor]])
        Cursor += 1 + Raw[Cursor]
    return Cells, Position


def ReadHistory(Data):
    """
    PT: Histórico do editor (0x0028): u32 n; n × {u64 FILETIME, u16 + autor} (criação) e mais n (última alteração).
    EN: Editor history (0x0028): creation and last-change (FILETIME, author) per instance.
    """
    Reader = RiotReader(Data)
    Count = Reader.U32()

    def Entry():
        Time = Reader.Unpack('<Q')[0]
        Author = Reader.String16()
        try:
            When = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=Time // 10)
        except OverflowError:
            When = None
        return When, Author
    Created = [Entry() for _ in range(Count)]
    Changed = []
    for _ in range(Count):
        if Reader.Remaining() < 10:
            break
        Changed.append(Entry())
    return Created, Changed


class RiotLevel:
    """PT: Uma fase aberta. EN: An opened level."""

    def __init__(self, Path, IsTTB):
        self.Path = Path
        self.IsTTB = IsTTB
        self.Container = RiotContainer(Path)
        self.Instances, self.InstancesComplete = ReadInstances(self.Container)

    def TerrainLayers(self):
        return ReadTerrainLayers(self.Container)

    def Cells(self):
        Chunk = self.Container.FirstOfType(0x0026)
        if not Chunk:
            return None
        return ReadCells(self.Container.ChunkData(Chunk))

    def Portals(self):
        Chunk = self.Container.FirstOfType(0x0027)
        if not Chunk:
            return []
        return ReadPortals(self.Container.ChunkData(Chunk))

    def History(self):
        Chunk = self.Container.FirstOfType(0x0028)
        return ReadHistory(self.Container.ChunkData(Chunk)) if Chunk else ([], [])
