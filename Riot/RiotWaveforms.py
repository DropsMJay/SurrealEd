"""
RiotWaveforms — curvas do .wdu / .wdu waveforms
===============================================

PT-BR
-----
O .wdu guarda "waveforms": curvas amostradas usadas pelo motor (rolagem de UV de material, efeitos de luz,
vibração). Cada curva é um pedaço do tipo 0x0060 cujo índice é o da referência (pacote << 16 | índice):

    +0   u32  tipo do elemento: 0 int8, 1 int16, 2 int32, 3 float32 (4 = não é curva: texto, morph)
    +4   u16  canais (1..4)
    +8   u32  amostras por segundo
    +16  u32  bytes de amostras
    +20  amostras intercaladas por canal

Inteiros são normalizados (int8 / 127, int16 / 32767, int32 / 2^31). A curva repete: duração = amostras / taxa,
e o motor amostra em fmod(tempo, duração) com interpolação linear. (Fatos conferidos com o projeto
"the-suffering-engine"; leitor escrito aqui.)

EN
--
.wdu waveforms: chunk 0x0060, header above, samples interleaved by channel; integers normalised; looped with
duration = samples / rate and linear interpolation.
"""
import struct

ChunkWaveform = 0x0060
_Sizes = {0: (1, 'b', 127.0), 1: (2, 'h', 32767.0), 2: (4, 'i', 2.0 ** 31), 3: (4, 'f', 1.0)}


def ParseWaveform(Data):
    """
    PT: (taxa, canais, [amostras...], duração) ou None. TS1: cabeçalho de 20 bytes acima. TTB: f32 duração, u16 canais,
        u16 tipo, u32 flags, u32 bytes, amostras a partir de +16; as amostras cobrem a duração de ponta a ponta
        (taxa = (n − 1) / duração: 81 amostras em 2,667 s = 30/s, 319 em 53 s = 6/s).
    EN: (rate, channels, samples, duration) or None; TS1 20-byte header, TTB header described above.
    """
    if len(Data) < 16:
        return None
    Type, Channels = struct.unpack_from('<IH', Data, 0)
    if Type in _Sizes and len(Data) >= 20:
        Rate, _Skip, Bytes = struct.unpack_from('<III', Data, 8)
        Start, Duration = 20, None
    else:
        Duration, Channels, Type, _Flags, Bytes = struct.unpack_from('<fHHII', Data, 0)
        Start, Rate = 16, None
        if not (Duration == Duration and 0 < Duration < 1e5):
            return None
    if Type not in _Sizes or not 1 <= Channels <= 4:
        return None
    Size, Code, Scale = _Sizes[Type]
    Count = min(Bytes, len(Data) - Start) // Size // Channels
    if Count < 1:
        return None
    if Rate is None:
        Rate = (Count - 1) / Duration if Count > 1 else 1.0
    elif not 0 < Rate <= 1000:
        return None
    if Duration is None:
        Duration = Count / Rate
    Values = struct.unpack_from('<%d%s' % (Count * Channels, Code), Data, Start)
    Samples = [(Value / Scale) if Value == Value and abs(Value) < 1e9 else 0.0 for Value in Values]
    return Rate, Channels, Samples, Duration


class RiotWaveformStore:
    """PT: Curvas por referência, com cache. EN: Cached waveforms by reference."""

    def __init__(self, Game):
        self.Game = Game
        self._Cache = {}

    def Get(self, Package, Index):
        Key = (Package, Index)
        if Key not in self._Cache:
            Result = None
            Container = self.Game.PackageContainer(Package, '.wdu') if Package in self.Game.Packages else None
            if Container:
                Chunk = Container.Resource(Index).get(ChunkWaveform)
                if Chunk:
                    Result = ParseWaveform(Container.ChunkData(Chunk))
            self._Cache[Key] = Result
        return self._Cache[Key]
