"""
RiotTextures — texturas (.tdu) / textures
=========================================

PT-BR
-----
Cada textura é um pedaço 0x0040 (o ChunkId é a referência da textura). Leitor no jogo: 0x448FC0
(registrado por 0x4493A0). Cabeçalho de 48 bytes, confirmado em todas as texturas dos dois jogos:

    +0x00 u32 Width            +0x04 u32 Height
    +0x08 u32 BytesPerRow      (= Width × Bpp / 8)
    +0x0C u32 Bpp              4 = DXT1, 8 = DXT5 ou 8 bits com paleta
    +0x10 u32 AlphaBits        0 = opaca, 1 = recorte (DXT1 de 1 bit), 4/8 = alpha de verdade
    +0x14 u32 -1
    +0x18 u32 Flags            0x200 = comprimida; 0x2 / 0x8 muito comuns (sentido ainda aberto)
    +0x1C f32 (256.0 quase sempre; vira um expoente usado como viés de mip)
    +0x20 u32 DxtType          2 = DXT1, 3 = DXT5 (ou L8 sem compressão se AlphaBits = 8), 0 = com paleta
    +0x24 lista de u32 terminada em 0 (sempre 2, 1, 0)
Com paleta (DxtType 0): u32 tipo da paleta (1 = 256 × 4 bytes), u32 256, 8 bytes, 1024 bytes de paleta
(BGRA), depois Width × Height índices.
Depois do cabeçalho vem só o nível principal: o TS1 não guarda mipmaps (o motor gera). Algumas texturas
da TTB trazem mipmaps logo depois; eles são ignorados aqui.
As linhas da imagem estão de baixo para cima (como no Direct3D com UV invertido): ao converter para uma
imagem normal é preciso inverter na vertical.
Pedaço 0x0041 (raro): metadados do editor (ver RiotContainer).
Mipmaps (só na TTB): o primeiro u32 da lista em +0x24 é o número de níveis extras gravados depois do principal
(4 numa 512×512 = 256², 128², 64², 32²); essas texturas também trocam o f32 de +0x1C (4, 8, 16…). No TS1 esse u32 é
2 e não há mipmaps.
Importação (BuildTextureChunk): mantém o cabeçalho original e troca só tamanho, formato, AlphaBits e mipmaps; a
imagem chega pronta do editor (DXT codificado no navegador, linhas de baixo para cima).

EN
--
One 0x0040 chunk per texture; 48-byte header (fields above). Bpp 4 = DXT1, 8 = DXT5 or 8-bit paletted
(palette: u32 type, u32 256, 8 bytes, 1024-byte BGRA palette, then indices). Only the top level is stored in
TS1 (some TTB textures also carry mipmaps, ignored here). Rows are stored bottom-up.
"""
import struct

FormatDXT1 = 1
FormatDXT5 = 5
FormatPalette8 = 8
FormatL8 = 9
FormatNames = {FormatDXT1: 'DXT1', FormatDXT5: 'DXT5', FormatPalette8: 'Palette 8-bit', FormatL8: 'L8'}
HeaderSize = 48


class RiotTexture:
    """
    PT: Textura lida de um pedaço 0x0040. Payload = bytes prontos para decodificar (DXT ou paleta + índices).
    EN: Texture read from a 0x0040 chunk. Payload = bytes ready to decode (DXT or palette + indices).
    """
    __slots__ = ('Ref', 'Width', 'Height', 'Bpp', 'AlphaBits', 'Flags', 'MipBias', 'DxtType', 'Format', 'Payload')

    @property
    def FormatName(self):
        return FormatNames.get(self.Format, '?')

    @property
    def HasAlpha(self):
        return self.AlphaBits > 0 or self.Format == FormatPalette8


def ReadTexture(Container, Chunk):
    """PT: Lê uma textura (ou None se o formato não for suportado). EN: Reads a texture (or None if unsupported)."""
    Data = Container.Data
    Offset = Chunk.Offset
    Width, Height, BytesPerRow, Bpp, AlphaBits, _Minus1, Flags = struct.unpack_from('<7I', Data, Offset)
    MipBias = struct.unpack_from('<f', Data, Offset + 28)[0]
    DxtType = struct.unpack_from('<I', Data, Offset + 32)[0]
    Texture = RiotTexture()
    Texture.Ref, Texture.Width, Texture.Height, Texture.Bpp = Chunk.ChunkId, Width, Height, Bpp
    Texture.AlphaBits, Texture.Flags, Texture.MipBias, Texture.DxtType = AlphaBits, Flags, MipBias, DxtType
    Start = Offset + HeaderSize
    if DxtType == 2 and Bpp == 4:
        Texture.Format = FormatDXT1
        Size = max(1, (Width + 3) // 4) * max(1, (Height + 3) // 4) * 8
    elif DxtType == 3 and Bpp == 8 and AlphaBits == 8:
        # PT: 8 bits sem compressão (luminância = alfa); só o ponteiro do mouse do TS1 (Interface 5_0461)
        # EN: uncompressed 8-bit luminance (alpha = L); only the TS1 mouse pointer
        Texture.Format = FormatL8
        Size = Width * Height
    elif DxtType == 3 and Bpp == 8:
        Texture.Format = FormatDXT5
        Size = max(1, (Width + 3) // 4) * max(1, (Height + 3) // 4) * 16
    elif DxtType == 0 and Bpp == 8:
        Texture.Format = FormatPalette8
        PaletteType, PaletteCount = struct.unpack_from('<II', Data, Start)
        if PaletteType != 1 or PaletteCount != 256:
            return None
        Start += 16
        Size = 1024 + Width * Height
    else:
        return None
    if Start + Size > Offset + Chunk.Size:
        return None
    Texture.Payload = Data[Start:Start + Size]
    return Texture


class RiotTextureStore:
    """PT: Texturas de todos os pacotes, por referência. EN: Textures of every package, by reference."""

    def __init__(self, Game):
        self.Game = Game
        self._Cache = {}

    def Exists(self, Package, Index):
        Container = self.Game.PackageContainer(Package, '.tdu')
        return bool(Container) and 0x0040 in Container.Resource(Index)

    def Get(self, Package, Index):
        Key = (Package, Index)
        if Key not in self._Cache:
            Result = None
            Container = self.Game.PackageContainer(Package, '.tdu')
            if Container:
                Chunk = Container.Resource(Index).get(0x0040)
                if Chunk:
                    try:
                        Result = ReadTexture(Container, Chunk)
                    except struct.error:
                        Result = None
                    if Result:
                        # PT: a parte alta do ChunkId no arquivo nem sempre é o id do pacote; vale a referência pedida
                        # EN: the high half of the stored ChunkId is not always the package id; use the requested ref
                        Result.Ref = (Package << 16) | Index
            self._Cache[Key] = Result
        return self._Cache[Key]


def TextureMipCount(Container, Chunk):
    """PT: Quantos níveis extras de mipmap a textura grava (0 no TS1). EN: Extra mip levels stored."""
    Data = Container.Data
    Width, Height, _Row, _Bpp = struct.unpack_from('<4I', Data, Chunk.Offset)
    DxtType, Extra = struct.unpack_from('<II', Data, Chunk.Offset + 32)
    if DxtType not in (2, 3):
        return 0
    Block = 8 if DxtType == 2 else 16
    Base = max(1, (Width + 3) // 4) * max(1, (Height + 3) // 4) * Block
    if Chunk.Size - HeaderSize <= Base:
        return 0
    return Extra


def DxtSize(Width, Height, Format, Mips=0):
    """PT: Bytes de um nível DXT e dos mipmaps extras. EN: Bytes of a DXT level plus extra mips."""
    Block = 8 if Format == FormatDXT1 else 16
    Total = 0
    for _Level in range(Mips + 1):
        Total += max(1, (Width + 3) // 4) * max(1, (Height + 3) // 4) * Block
        Width, Height = max(1, Width // 2), max(1, Height // 2)
    return Total


def BuildTextureChunk(Original, Width, Height, Format, AlphaBits, Payload, Mips):
    """
    PT: Novo pedaço 0x0040: cabeçalho do original com tamanho/formato/alfa/mipmaps trocados + Payload (DXT, linhas de
        baixo para cima, nível principal seguido dos mipmaps).
    EN: New 0x0040 chunk: original header with size/format/alpha/mips replaced, followed by Payload.
    """
    if Format not in (FormatDXT1, FormatDXT5):
        raise ValueError('only DXT1 / DXT5 / só DXT1 ou DXT5')
    if Width < 4 or Height < 4 or Width & (Width - 1) or Height & (Height - 1) or max(Width, Height) > 4096:
        raise ValueError('size must be a power of two, 4 to 4096 / o tamanho precisa ser potência de 2, de 4 a 4096')
    if len(Payload) != DxtSize(Width, Height, Format, Mips):
        raise ValueError('payload size mismatch / tamanho dos dados não confere')
    Header = bytearray(Original[:HeaderSize])
    Bpp = 4 if Format == FormatDXT1 else 8
    struct.pack_into('<5I', Header, 0, Width, Height, Width * Bpp // 8, Bpp, AlphaBits)
    Flags = struct.unpack_from('<I', Header, 0x18)[0]
    struct.pack_into('<I', Header, 0x18, Flags | 0x200)
    struct.pack_into('<I', Header, 0x20, 2 if Format == FormatDXT1 else 3)
    if Mips:
        struct.pack_into('<I', Header, 0x24, Mips)
    return bytes(Header) + bytes(Payload)


def PackTextures(Textures):
    """
    PT: Junta várias texturas num bloco binário para o editor: u32 quantidade e, para cada uma,
        u32 Ref, u16 Width, u16 Height, u8 Format, u8 AlphaBits, u16 0, u32 tamanho, dados (alinhados a 4).
    EN: Bundles textures for the editor (layout above).
    """
    Out = bytearray(struct.pack('<I', len(Textures)))
    for Texture in Textures:
        Out += struct.pack('<IHHBBHI', Texture.Ref, Texture.Width, Texture.Height, Texture.Format, Texture.AlphaBits, 0, len(Texture.Payload))
        Out += Texture.Payload
        while len(Out) % 4:
            Out += b'\0'
    return bytes(Out)
