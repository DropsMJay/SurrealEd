"""
RiotModels — modelos (.mdu) / models
====================================

PT-BR
-----
Um modelo é um conjunto de pedaços com o mesmo ChunkId. Leitores registrados em 0x483C90 (Suffering.exe):

    0x0200  cabeçalho      u32 flags, u32 tipo, [f32 se flags & 0x20000], u32 n, n × ref de material
    0x0203  vértices       u16 n, n × 3 f32 posição, n × 4 int8 normal (÷127, o 4º byte é preenchimento)
    0x0204  faces + UVs    u16 F, F × {u16 0, u16 k, u16 material, k × u16 vértice}, u16, F × 6 f32 (UV dos 3 cantos)
    0x0207  colisão        (estáticos) LOD, esfera, caixa orientada, árvore de volumes — ver RiotCollision
    0x0208  esqueleto      (animados) esfera + caixa, u32 nLOD, u32 nVértices, u32 nOssos, ossos com pesos por LOD,
                           tabela de LOD {f32 distância, u32 1º vértice, u32 nº vértices, u32 1ª face, u32 nº faces},
                           grupos de ossos, 3 distâncias, árvore de esferas de impacto
    0x0211  lotes da GPU   um lote por LOD: vértices duplicados nas emendas, UV por vértice, faixas de triângulos
                           por material (confere 100% com 0x0204)
    0x0214  pano/molas     só 1 no jogo inteiro (NPCs)
    0x0216  costura        ligação com o esqueleto
As posições estão em unidades do modelo (o motor multiplica por 2048 internamente).
Em modelos com esqueleto, as faces de cada LOD usam índices relativos ao 1º vértice do LOD; o
visualizador usa só o LOD 0.

EN
--
A model is a group of chunks sharing one ChunkId (readers registered at 0x483C90). Vertices (0x0203), faces
with per-corner UVs (0x0204) and material refs (0x0200) are enough to draw it; 0x0207/0x0208/0x0211/0x0214/
0x0216 hold collision, skeleton, GPU batches, cloth and skin seams. Skinned models: faces of each LOD are
relative to the LOD's first vertex; the viewer uses LOD 0.
"""
import struct


class RiotModel:
    """
    PT: Modelo decodificado: Positions [(x,y,z)], Normals [(x,y,z)], Faces [(material, (a,b,c))],
        FaceUVs [(u0,v0,u1,v1,u2,v2)] (pode ser vazio), Materials [ref], IsSkinned.
    EN: Decoded model.
    """
    __slots__ = ('Ref', 'Positions', 'Normals', 'Faces', 'FaceUVs', 'Materials', 'IsSkinned')


def ReadSkinLods(Data, Offset):
    """
    PT: Tabela de LOD do 0x0208 (0x47AD70): lista de (distância, 1º vértice, nº vértices, 1ª face, nº faces).
    EN: LOD table of chunk 0x0208.
    """
    Position = Offset + 64
    LodCount, _VertexCount, BoneCount = struct.unpack_from('<3I', Data, Position)
    Position += 12
    for _Bone in range(BoneCount):
        Position += 4 + 48 + 8
        for _Lod in range(LodCount):
            Count = struct.unpack_from('<H', Data, Position)[0]
            Position += 2 + 8 * Count
    return [struct.unpack_from('<f4I', Data, Position + 20 * Number) for Number in range(LodCount)]


def ReadModel(Container, Index, AllLods=False):
    """
    PT: Lê um modelo do contêiner .mdu (ou None se faltar vértice/face).
    EN: Reads one model from a .mdu container (None if vertices/faces are missing).
    """
    Chunks = Container.Resource(Index)
    if 0x0203 not in Chunks or 0x0204 not in Chunks:
        return None
    Data = Container.Data
    Model = RiotModel()
    Model.Ref = None   # PT: preenchido pelo store / EN: set by the store

    Offset = Chunks[0x0203].Offset
    Count = struct.unpack_from('<H', Data, Offset)[0]
    Flat = struct.unpack_from('<%df' % (3 * Count), Data, Offset + 2)
    Model.Positions = [Flat[3 * Number:3 * Number + 3] for Number in range(Count)]
    NormalOffset = Offset + 2 + 12 * Count
    Raw = struct.unpack_from('<%db' % (4 * Count), Data, NormalOffset)
    Model.Normals = [(Raw[4 * Number] / 127.0, Raw[4 * Number + 1] / 127.0, Raw[4 * Number + 2] / 127.0) for Number in range(Count)]

    Chunk = Chunks[0x0204]
    Position = Chunk.Offset
    End = Chunk.Offset + Chunk.Size
    FaceCount = struct.unpack_from('<H', Data, Position)[0]
    Position += 2
    Faces = []
    for _Face in range(FaceCount):
        _Zero, Corners, Material = struct.unpack_from('<3H', Data, Position)
        Position += 6
        Faces.append((Material, struct.unpack_from('<%dH' % Corners, Data, Position)))
        Position += 2 * Corners
    Position += 2
    FaceUVs = []
    if Position + 24 * FaceCount <= End:
        Flat = struct.unpack_from('<%df' % (6 * FaceCount), Data, Position)
        FaceUVs = [Flat[6 * Number:6 * Number + 6] for Number in range(FaceCount)]

    Model.IsSkinned = 0x0208 in Chunks
    if Model.IsSkinned and not AllLods:
        try:
            _Distance, FirstVertex, _VertexCount, FirstFace, LodFaces = ReadSkinLods(Data, Chunks[0x0208].Offset)[0]
            if FirstFace + LodFaces <= len(Faces):
                Faces = [(Material, tuple(Vertex + FirstVertex for Vertex in Corners)) for Material, Corners in Faces[FirstFace:FirstFace + LodFaces]]
                if FaceUVs:
                    FaceUVs = FaceUVs[FirstFace:FirstFace + LodFaces]
        except struct.error:
            pass
    Model.Faces = Faces
    Model.FaceUVs = FaceUVs

    Model.Materials = []
    if 0x0200 in Chunks:
        Chunk = Chunks[0x0200]
        Position = Chunk.Offset + 8 + (4 if struct.unpack_from('<I', Data, Chunk.Offset)[0] & 0x20000 else 0)
        MaterialCount = struct.unpack_from('<I', Data, Position)[0]
        MaterialCount = min(MaterialCount, (Chunk.Offset + Chunk.Size - Position - 4) // 4)
        for Number in range(MaterialCount):
            MaterialIndex, MaterialPackage = struct.unpack_from('<HH', Data, Position + 4 + 4 * Number)
            Model.Materials.append((MaterialPackage << 16) | MaterialIndex)
    return Model


def ModelBounds(Container, Index):
    """
    PT: Esfera (4 floats) + caixa (12 floats) que o modelo declara: no 0x0207 (estáticos, depois de u16, u16, f) ou no
        começo do 0x0208 (animados). É exatamente o que o bloco "modelo próprio" de uma instância (.lvl, flag 0x8000)
        guarda: conferido nas 119 instâncias do TS1 que têm o bloco (todas idênticas byte a byte).
    EN: The model's declared sphere + box (0x0207 after u16, u16, f; or the start of 0x0208). Exactly what an
        instance's own-model block stores (checked on all 119 TS1 instances with the block).
    """
    Resource = Container.Resource(Index)
    for Type, Offset in ((0x0207, 8), (0x0208, 0)):
        Chunk = Resource.get(Type)
        if Chunk and Chunk.Size >= Offset + 64:
            return struct.unpack_from('<16f', Container.Data, Chunk.Offset + Offset)
    return None


def SetModelMaterial(Data, Offset, Size, Slot, MaterialRef):
    """
    PT: Pedaço 0x0200 com a referência de material Slot trocada (mesmo tamanho). EN: 0x0200 chunk with one material ref swapped.
    """
    Chunk = bytearray(Data[Offset:Offset + Size])
    Position = 8 + (4 if struct.unpack_from('<I', Chunk, 0)[0] & 0x20000 else 0)
    Count = struct.unpack_from('<I', Chunk, Position)[0]
    if not 0 <= Slot < Count or Position + 4 + 4 * (Slot + 1) > len(Chunk):
        raise ValueError('no material slot %d / slot de material inexistente' % Slot)
    struct.pack_into('<HH', Chunk, Position + 4 + 4 * Slot, MaterialRef & 0xFFFF, MaterialRef >> 16)
    return bytes(Chunk)


class RiotModelStore:
    """PT: Modelos de todos os pacotes, por referência (com cache). EN: Models of every package, cached."""

    def __init__(self, Game):
        self.Game = Game
        self._Cache = {}

    def Exists(self, Package, Index):
        Container = self.Game.PackageContainer(Package, '.mdu')
        return bool(Container) and 0x0203 in Container.Resource(Index)

    def Get(self, Package, Index):
        Key = (Package, Index)
        if Key not in self._Cache:
            Result = None
            Container = self.Game.PackageContainer(Package, '.mdu')
            if Container:
                try:
                    Result = ReadModel(Container, Index)
                except struct.error:
                    Result = None
                if Result:
                    Result.Ref = (Package << 16) | Index
            self._Cache[Key] = Result
        return self._Cache[Key]


def ReadSkeleton(Data, Offset):
    """
    PT: Esqueleto do pedaço 0x0208 (0x47AD70): lista de ossos {Id, Matrix (3×4, linhas), Parent, Weights por LOD}
        e a tabela de LOD. Matrix é a matriz de bind inversa (modelo -> espaço do osso); a rotação vem gravada
        coluna por coluna. Pais: árvore primeiro filho / próximo irmão (0 = nenhum; o osso 0 é a raiz).
    EN: Skeleton of chunk 0x0208: bones {Id, Matrix (3×4 rows, inverse bind), Parent, Weights per LOD} and the
        LOD table. Rotation is stored column by column; parents come from the first-child / next-sibling tree.
    """
    Position = Offset + 64
    LodCount, VertexCount, BoneCount = struct.unpack_from('<3I', Data, Position)
    Position += 12
    Bones = []
    for _Bone in range(BoneCount):
        BoneId = struct.unpack_from('<I', Data, Position)[0]
        Values = struct.unpack_from('<12f', Data, Position + 4)
        FirstChild, NextSibling = struct.unpack_from('<2I', Data, Position + 52)
        Position += 60
        Weights = []
        for _Lod in range(LodCount):
            Count = struct.unpack_from('<H', Data, Position)[0]
            Weights.append([struct.unpack_from('<If', Data, Position + 2 + 8 * Number) for Number in range(Count)])
            Position += 2 + 8 * Count
        Translation, Rotation = Values[:3], Values[3:]
        Matrix = []
        for Row in range(3):
            Matrix += [Rotation[Column * 3 + Row] for Column in range(3)] + [Translation[Row]]
        Bones.append({'Id': BoneId, 'Matrix': Matrix, 'FirstChild': FirstChild, 'NextSibling': NextSibling, 'Parent': -1, 'Weights': Weights})
    Lods = [struct.unpack_from('<f4I', Data, Position + 20 * Number) for Number in range(LodCount)]
    # PT: pais pela árvore filho/irmão / EN: parents from the child/sibling tree
    Stack = [(0, -1)] if Bones else []
    Seen = set()
    while Stack:
        Bone, Parent = Stack.pop()
        while Bone not in Seen and Bone < len(Bones):
            Seen.add(Bone)
            Bones[Bone]['Parent'] = Parent
            if Bones[Bone]['FirstChild']:
                Stack.append((Bones[Bone]['FirstChild'], Bone))
            Bone = Bones[Bone]['NextSibling']
            if not Bone:
                break
    return {'Bones': Bones, 'Lods': Lods, 'VertexCount': VertexCount}


def SkinWeights(Container, Index, Model, Skeleton):
    """
    PT: Pesos por vértice do LOD 0: [[osso, peso, osso, peso, ...]]. Corrige como o visualizador de cenas:
        vértices duplicados na emenda de UV (pedaço 0x0216, valor >= 0x8000 = cópia do vértice 0xFFFF − valor)
        herdam os pesos do original; vértices ainda sem peso herdam os de um vértice com peso na mesma posição;
        o resto segue o osso raiz (partes rígidas).
    EN: LOD 0 per-vertex weights with the seam (0x0216), coincident-vertex and root-bone fixes.
    """
    Count = len(Model.Positions)
    Weights = [[] for _ in range(Count)]
    for BoneNumber, Bone in enumerate(Skeleton['Bones']):
        for Vertex, Weight in (Bone['Weights'][0] if Bone['Weights'] else []):
            if Vertex < Count:
                Weights[Vertex] += [BoneNumber, round(Weight, 4)]
    Chunk = Container.Resource(Index).get(0x0216)
    if Chunk:
        Data = Container.Data
        Total = struct.unpack_from('<H', Data, Chunk.Offset)[0]
        Map = struct.unpack_from('<%dH' % Total, Data, Chunk.Offset + 2)
        for Vertex in range(min(Total, Count)):
            if not Weights[Vertex] and Map[Vertex] >= 0x8000:
                Source = 0xFFFF - Map[Vertex]
                if Source < Count:
                    Weights[Vertex] = list(Weights[Source])
    Used = {Vertex for _Material, Corners in Model.Faces for Vertex in Corners}
    Missing = [Vertex for Vertex in sorted(Used) if Vertex < Count and not Weights[Vertex]]
    if Missing:
        ByPoint = {}
        for Vertex, Value in enumerate(Weights):
            if Value:
                Point = tuple(round(Coordinate, 4) for Coordinate in Model.Positions[Vertex])
                ByPoint.setdefault(Point, Vertex)
        for Vertex in Missing:
            Source = ByPoint.get(tuple(round(Coordinate, 4) for Coordinate in Model.Positions[Vertex]))
            Weights[Vertex] = list(Weights[Source]) if Source is not None else [0, 1.0]
    return Weights
