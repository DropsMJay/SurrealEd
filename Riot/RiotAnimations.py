"""
RiotAnimations — animações (.adu) / animations
==============================================

PT-BR
-----
Leitores registrados em 0x474010 (Suffering.exe). Uma animação é um recurso com estes pedaços:

    0x0501  cabeçalho   f32 duração, u32 flags (bit 0 = toca uma vez e para; bit 1 = atualização em taxa cheia, sem
                        LOD de distância), u32 nº de ossos, f32 tempo de mistura, f32 velocidade, 2 × f32 não lidos
                        (conferido com o projeto "the-suffering-engine", docs/re/animation.md §7)
    0x0502  chaves      u32 nOssos, nOssos × {u32 id do osso, u32 deslocamento, i16 nChaves, u16 flags, 3 f32 posição
                        de repouso}, u32 tamanho das chaves, depois as chaves de cada osso.
                        TS1: f32 tempo + 4 f32 quaternião (x, y, z, w) [+ 3 f32 posição se flags == 0x8000]
                        TTB: u16 tempo (× 1/30 s) + 3 × s16 quaternião x, y, z (÷ 32767; w = +√(1 − x² − y² − z²))
                             [+ 3 f32 posição]. O formato certo é o que fecha exatamente com o tamanho das chaves.
    0x0504  ligações    u16 n, n × {u32 animação, f32 tempo de mistura}: a mistura usada quando ESTE clipe substitui aquele
    0x0505  eventos     u32 n, n × {u32 tipo, f32 tempo, u32 hash do osso [, u32 código se tipo 0 ou 1]},
                        u32 m, m × u32 dependências. Tipo 0 = recurso anexado (código = ref); tipo 1 = marcador
                        (mensagem enviada ao ator: 100…460).
As chaves são locais ao osso pai. Ossos com flags 0xC000 usam a posição de repouso como translação fixa.
O id do osso é o mesmo hash da lista de ossos do modelo (0x0208): é assim que a animação acha o esqueleto.

EN
--
Readers registered at 0x474010. Header 0x0501, keys 0x0502 (TS1 float keys, TTB packed 8-byte keys), links 0x0504
and events 0x0505 (layouts above). Keys are local to the parent bone; bone ids are the same hashes as in the
model's 0x0208 bone list.
"""
import struct


def ReadAnimationHeader(Container, Index):
    """PT: (duração, repetir, nº de ossos) ou None. EN: (duration, loop, bone count) or None."""
    Chunk = Container.Resource(Index).get(0x0501)
    if not Chunk or Chunk.Size < 12:
        return None
    return struct.unpack_from('<fII', Container.Data, Chunk.Offset)


def ReadAnimationInfo(Container, Index):
    """PT: Cabeçalho completo: {Duration, Flags, Bones, BlendTime, Rate}. EN: Full header."""
    Chunk = Container.Resource(Index).get(0x0501)
    if not Chunk or Chunk.Size < 20:
        return None
    Duration, Flags, Bones, BlendTime, Rate = struct.unpack_from('<fIIff', Container.Data, Chunk.Offset)
    return {'Duration': Duration, 'Flags': Flags, 'Bones': Bones, 'BlendTime': BlendTime, 'Rate': Rate}


def ReadBoneIds(Container, Index):
    """PT: Ids dos ossos que têm trilha. EN: Ids of the bones that have a track."""
    Chunk = Container.Resource(Index).get(0x0502)
    if not Chunk:
        return []
    Data, Offset = Container.Data, Chunk.Offset
    Count = struct.unpack_from('<I', Data, Offset)[0]
    if Count > 512:
        return []
    return [struct.unpack_from('<I', Data, Offset + 4 + 24 * Number)[0] for Number in range(Count)]


def ReadTracks(Container, Index):
    """
    PT: Trilhas por osso: {id: {'Keys': [t, x, y, z, w (, px, py, pz)] achatado, 'Stride': 5 ou 8, 'Rest': [x, y, z]}}.
    EN: Tracks per bone (flat key arrays, stride 5 or 8).
    """
    Chunk = Container.Resource(Index).get(0x0502)
    if not Chunk:
        return {}
    Data = Container.ChunkData(Chunk)
    Count = struct.unpack_from('<I', Data, 0)[0]
    Headers = [struct.unpack_from('<IIhH3f', Data, 4 + 24 * Number) for Number in range(Count)]
    KeyStart = 4 + 24 * Count + 4
    KeyBytes = struct.unpack_from('<I', Data, KeyStart - 4)[0]
    PackedSize = sum(Keys * (20 if Flags == 0x8000 else 8) for _Id, _Offset, Keys, Flags, *_ in Headers)
    FloatSize = sum(Keys * (32 if Flags == 0x8000 else 20) for _Id, _Offset, Keys, Flags, *_ in Headers)
    Packed = PackedSize == KeyBytes and FloatSize != KeyBytes
    Tracks = {}
    Position = KeyStart
    for BoneId, KeyOffset, KeyCount, Flags, RestX, RestY, RestZ in Headers:
        HasPosition = Flags == 0x8000
        if Packed:
            Position = KeyStart + KeyOffset
        Keys = []
        for _Key in range(max(0, KeyCount)):
            if Packed:
                Time, A, B, C = struct.unpack_from('<H3h', Data, Position)
                Position += 8
                X, Y, Z = A / 32767, B / 32767, C / 32767
                W = max(0.0, 1 - X * X - Y * Y - Z * Z) ** 0.5
                Keys += [round(Time / 30, 4), round(X, 5), round(Y, 5), round(Z, 5), round(W, 5)]
            else:
                Values = struct.unpack_from('<5f', Data, Position)
                Position += 20
                Keys += [round(Values[0], 4)] + [round(Value, 5) for Value in Values[1:]]
            if HasPosition:
                Keys += [round(Value, 5) for Value in struct.unpack_from('<3f', Data, Position)]
                Position += 12
        Tracks[BoneId] = {'Keys': Keys, 'Stride': 8 if HasPosition else 5, 'Rest': [round(RestX, 5), round(RestY, 5), round(RestZ, 5)]}
    return Tracks


def ReadEvents(Container, Index):
    """
    PT: Eventos (0x0505): [{Type, Time, Bone, Code}] e dependências [ref].
    EN: Events (0x0505) and dependency refs.
    """
    Chunk = Container.Resource(Index).get(0x0505)
    if not Chunk:
        return [], []
    Data, Position, End = Container.Data, Chunk.Offset, Chunk.Offset + Chunk.Size
    Count = struct.unpack_from('<I', Data, Position)[0]
    Position += 4
    Events = []
    for _Event in range(Count):
        Type, Time, Bone = struct.unpack_from('<IfI', Data, Position)
        Position += 12
        Code = None
        if Type in (0, 1):
            Code = struct.unpack_from('<I', Data, Position)[0]
            Position += 4
        Events.append({'Type': Type, 'Time': round(Time, 4), 'Bone': Bone, 'Code': Code})
    Dependencies = []
    if Position + 4 <= End:
        Total = struct.unpack_from('<I', Data, Position)[0]
        Dependencies = list(struct.unpack_from('<%dI' % Total, Data, Position + 4)) if Position + 4 + 4 * Total <= End else []
    return Events, Dependencies


def ReadLinks(Container, Index):
    """PT: Ligações (0x0504): [(ref da animação, f32)]. EN: Links (0x0504)."""
    Chunk = Container.Resource(Index).get(0x0504)
    if not Chunk:
        return []
    Data = Container.Data
    Count = struct.unpack_from('<H', Data, Chunk.Offset)[0]
    return [struct.unpack_from('<If', Data, Chunk.Offset + 2 + 8 * Number) for Number in range(Count)]
