"""
RiotContainer — pacotes SRSC do Riot Engine / Riot Engine SRSC packages
=======================================================================

PT-BR
-----
Todos os arquivos de dados do The Suffering e da Ties That Bind (.lvl, .mdu, .tdu, .odu, .adu, .sdu, .qdu,
.xdu, .ldu, .wdu, .fdu, .vdu) usam o mesmo contêiner, chamado SRSC. Ele é só um índice de "pedaços"
(chunks); o significado de cada pedaço depende do tipo dele e é tratado pelos outros módulos Riot*.

Formato (confirmado em todos os arquivos dos dois jogos):

    0x00  4 bytes   "SRSC"
    0x04  u16       versão do contêiner (0x0101)
    0x06  u32       DirectoryOffset: posição do índice no arquivo
    0x0A  u32       ChunkCount: número de pedaços
    ...             dados dos pedaços
    DirectoryOffset: ChunkCount × 14 bytes
        u16  ChunkType   tipo do pedaço (ex.: 0x0040 textura, 0x0203 vértices, 0x0020 instâncias)
        u32  ChunkId     identificador do recurso: os 16 bits baixos são o índice do recurso no pacote;
                         os 16 altos nem sempre são o id do pacote (use o id do .db, ver RiotPackages)
        u32  Offset      posição dos dados no arquivo
        u32  Size        tamanho dos dados

Um mesmo recurso pode ter vários pedaços com o mesmo ChunkId (um modelo tem 0x0200, 0x0203, 0x0204…).
O pedaço 0x0402 (ChunkId 0) de cada pacote guarda a versão do formato (u16, deve bater com a tabela de
tipos do .exe em 0x595BB8), um u16, u32 1 e as letras "WI".

Pedaço 0x0041 (metadados do editor): u16 + nome, u16 + caminho do arquivo original, 8 bytes FILETIME,
u16 + autor. Foi removido de quase todos os recursos na versão final (só sobrou 1, em Interface.tdu).

EN
--
Every The Suffering / Ties That Bind data file uses the same container, SRSC: a plain index of chunks.
The meaning of a chunk depends on its type and is handled by the other Riot* modules.

Layout: "SRSC", u16 version (0x0101), u32 DirectoryOffset, u32 ChunkCount, chunk data, then the directory:
ChunkCount × {u16 ChunkType, u32 ChunkId, u32 Offset, u32 Size}. The low 16 bits of ChunkId are the resource
index; the high 16 bits are not always the package id (use the .db id, see RiotPackages).
Several chunks may share one ChunkId (a model has 0x0200, 0x0203, 0x0204…). Chunk 0x0402 (id 0) holds the
format version. Chunk 0x0041 is the editor metadata (name, source path, FILETIME, author); it was stripped
from almost every resource in the retail build.
"""
import os
import struct

Magic = b'SRSC'
EntrySize = 14


class RiotChunk:
    """PT: Um pedaço do contêiner. EN: One container chunk."""
    __slots__ = ('ChunkType', 'ChunkId', 'Offset', 'Size')

    def __init__(self, ChunkType, ChunkId, Offset, Size):
        self.ChunkType = ChunkType
        self.ChunkId = ChunkId
        self.Offset = Offset
        self.Size = Size

    @property
    def High(self):
        """PT: Parte alta do ChunkId (nem sempre é o id do pacote). EN: High half of ChunkId (not always the package id)."""
        return self.ChunkId >> 16

    @property
    def Index(self):
        """PT: Índice do recurso no pacote. EN: Resource index inside the package."""
        return self.ChunkId & 0xFFFF

    def __repr__(self):
        return 'RiotChunk(0x%04X, 0x%08X, %d bytes)' % (self.ChunkType, self.ChunkId, self.Size)


class RiotContainer:
    """
    PT: Arquivo SRSC carregado na memória. Os dados ficam em Data (bytes) e o índice em Chunks.
    EN: SRSC file loaded in memory. Raw bytes in Data, directory in Chunks.
    """

    def __init__(self, Path=None, Data=None):
        self.Path = Path
        if Data is None:
            with open(Path, 'rb') as Handle:
                Data = Handle.read()
        self.Data = Data
        if Data[:4] != Magic:
            raise ValueError('Not an SRSC file / não é um arquivo SRSC: %s' % Path)
        self.Version, DirectoryOffset, ChunkCount = struct.unpack_from('<HII', Data, 4)
        self.Chunks = []
        for Number in range(ChunkCount):
            self.Chunks.append(RiotChunk(*struct.unpack_from('<HIII', Data, DirectoryOffset + Number * EntrySize)))
        self._ByType = None
        self._ByIndex = None

    # ------------------------------------------------------------------ consulta / lookup
    def ChunkData(self, Chunk):
        """PT: Bytes de um pedaço. EN: Bytes of one chunk."""
        return self.Data[Chunk.Offset:Chunk.Offset + Chunk.Size]

    def ChunksOfType(self, ChunkType):
        """PT: Lista de pedaços de um tipo. EN: All chunks of one type."""
        if self._ByType is None:
            self._ByType = {}
            for Chunk in self.Chunks:
                self._ByType.setdefault(Chunk.ChunkType, []).append(Chunk)
        return self._ByType.get(ChunkType, [])

    def FirstOfType(self, ChunkType):
        """PT: Primeiro pedaço de um tipo (ou None). EN: First chunk of a type (or None)."""
        Found = self.ChunksOfType(ChunkType)
        return Found[0] if Found else None

    def Resource(self, Index):
        """
        PT: Dicionário {ChunkType: RiotChunk} de um recurso, pelo índice (16 bits baixos do ChunkId).
        EN: {ChunkType: RiotChunk} for one resource, by index (low 16 bits of ChunkId).
        """
        if self._ByIndex is None:
            self._ByIndex = {}
            for Chunk in self.Chunks:
                self._ByIndex.setdefault(Chunk.Index, {})[Chunk.ChunkType] = Chunk
        return self._ByIndex.get(Index, {})

    def ResourceIndexes(self, ChunkType):
        """PT: Índices dos recursos que têm um pedaço desse tipo. EN: Indexes of resources with that chunk type."""
        return sorted({Chunk.Index for Chunk in self.ChunksOfType(ChunkType)})

    def FormatVersion(self):
        """PT: Versão do formato (pedaço 0x0402). EN: Format version (chunk 0x0402)."""
        Chunk = self.FirstOfType(0x0402)
        return struct.unpack_from('<H', self.Data, Chunk.Offset)[0] if Chunk else None

    def EditorMetadata(self, Index):
        """
        PT: Metadados do editor (pedaço 0x0041) de um recurso, se ainda existirem: Name, SourcePath, FileTime, Author.
        EN: Editor metadata (chunk 0x0041) of a resource, when still present.
        """
        Chunk = self.Resource(Index).get(0x0041)
        if not Chunk:
            return None
        Reader = RiotReader(self.ChunkData(Chunk))
        Name = Reader.String16()
        SourcePath = Reader.String16()
        FileTime = Reader.Unpack('<Q')[0]
        Author = Reader.String16()
        return {'Name': Name, 'SourcePath': SourcePath, 'FileTime': FileTime, 'Author': Author}


def WriteContainer(Path, Chunks, Version=0x0101):
    """
    PT: Grava um SRSC. Chunks = lista de (ChunkType, ChunkId, bytes), na ordem em que os dados devem ficar.
        Como nos arquivos originais: dados a partir do byte 16, cada pedaço alinhado a 8 bytes (preenchido com
        zeros) e o índice no fim. O índice é gravado na mesma ordem da lista.
        Observação: os arquivos originais às vezes têm preenchimentos maiores entre pedaços (até 30 bytes); o
        jogo lê pelo índice, então isso não muda nada, mas o arquivo regravado pode não ser idêntico byte a byte.
        A gravação é atômica (arquivo temporário + troca).
    EN: Writes an SRSC: data from byte 16, 8-byte aligned chunks (zero padded), directory last, atomic replace.
        Originals sometimes have larger padding between chunks, so a rewrite may not be byte-identical.
    """
    Body = bytearray(Magic + struct.pack('<HII', Version, 0, len(Chunks)))
    Body += b'\0' * (16 - len(Body))
    Directory = bytearray()
    for ChunkType, ChunkId, Payload in Chunks:
        while len(Body) % 8:
            Body += b'\0'
        Directory += struct.pack('<HIII', ChunkType, ChunkId, len(Body), len(Payload))
        Body += Payload
    while len(Body) % 8:
        Body += b'\0'
    struct.pack_into('<I', Body, 6, len(Body))
    Body += Directory
    TempPath = Path + '.tmp'
    with open(TempPath, 'wb') as Handle:
        Handle.write(Body)
    os.replace(TempPath, Path)


def RebuildContainer(Container, Replace=None, Add=None, Remove=None):
    """
    PT: Regrava um SRSC mudando só o necessário, mantendo o layout original (ordem física, espaços entre pedaços,
        ordem do índice). Sem mudanças, o resultado é idêntico byte a byte ao original (testado em todos os 405
        arquivos dos dois jogos, veja Tools/RiotRoundTrip.py).
          Replace  {RiotChunk: bytes}  novos dados de pedaços existentes (podem ser maiores ou menores)
          Add      [(ChunkType, ChunkId, bytes)]  pedaços novos, no fim dos dados e do índice
          Remove   {RiotChunk}  pedaços a retirar
        Todos os pedaços começam em múltiplo de 8 e os espaços são zeros, como nos originais; um pedaço trocado é
        completado até múltiplo de 8, então tudo que vem depois só se desloca e continua alinhado.
    EN: Rewrites an SRSC changing only what is needed and keeping the original layout (physical order, gaps,
        directory order). With no changes the output is byte-identical. Replaced chunks may grow or shrink.
    """
    Replace = Replace or {}
    Remove = Remove or set()
    Data = Container.Data
    Out = bytearray(Data[:16])
    NewPlace = {}                       # PT: (offset, size) original -> (offset, size) novo
    Previous = 16
    for Chunk in sorted(Container.Chunks, key=lambda Item: (Item.Offset, Item.Size)):
        Key = (Chunk.Offset, Chunk.Size)
        if Key in NewPlace and Chunk not in Replace:
            continue                    # PT: pedaço repetido no índice / EN: chunk listed twice
        Gap = max(0, Chunk.Offset - Previous)
        Previous = max(Previous, Chunk.Offset + Chunk.Size)
        if Chunk in Remove:
            continue
        Out += b'\0' * Gap
        while len(Out) % 8:
            Out += b'\0'
        Start = len(Out)
        if Chunk in Replace:
            Payload = bytes(Replace[Chunk])
            Out += Payload
            while len(Out) % 8:
                Out += b'\0'
            NewPlace[Chunk] = (Start, len(Payload))
        else:
            Out += Data[Chunk.Offset:Chunk.Offset + Chunk.Size]
            NewPlace[Key] = (Start, Chunk.Size)
    DirectoryOffset = struct.unpack_from('<I', Data, 6)[0]
    Out += b'\0' * max(0, DirectoryOffset - Previous)
    Added = []
    for ChunkType, ChunkId, Payload in Add or []:
        while len(Out) % 8:
            Out += b'\0'
        Added.append((ChunkType, ChunkId, len(Out), len(Payload)))
        Out += Payload
    while len(Out) % 8:
        Out += b'\0'
    Directory = bytearray()
    Count = 0
    for Chunk in Container.Chunks:
        if Chunk in Remove:
            continue
        Offset, Size = NewPlace[Chunk] if Chunk in NewPlace else NewPlace[(Chunk.Offset, Chunk.Size)]
        Directory += struct.pack('<HIII', Chunk.ChunkType, Chunk.ChunkId, Offset, Size)
        Count += 1
    for Entry in Added:
        Directory += struct.pack('<HIII', *Entry)
        Count += 1
    struct.pack_into('<II', Out, 6, len(Out), Count)
    Tail = Data[DirectoryOffset + EntrySize * len(Container.Chunks):]
    return bytes(Out + Directory + Tail)


def SaveContainerFile(Path, Data, GameRoot):
    """
    PT: Grava um arquivo do jogo com segurança: na primeira vez guarda o original em
        <jogo>/SurrealEd Backup/<caminho relativo> (nunca sobrescreve esse backup), depois grava num temporário e
        troca (atômico). Devolve o caminho do backup.
    EN: Safe write: the first time, keeps the original in <game>/SurrealEd Backup/<relative path> (never
        overwritten), then writes a temporary file and swaps it in. Returns the backup path.
    """
    Backup = BackupPath(Path, GameRoot)
    if not os.path.exists(Backup):
        os.makedirs(os.path.dirname(Backup), exist_ok=True)
        with open(Path, 'rb') as Source, open(Backup + '.tmp', 'wb') as Target:
            Target.write(Source.read())
        os.replace(Backup + '.tmp', Backup)
    TempPath = Path + '.surrealed.tmp'
    with open(TempPath, 'wb') as Handle:
        Handle.write(Data)
    os.replace(TempPath, Path)
    return Backup


def RebuildFromOriginal(Path, GameRoot, Current, Replace):
    """
    PT: Monta o novo arquivo a partir do ORIGINAL (backup, se existir): só os pedaços cujo conteúdo final difere do
        original são trocados. Assim, desfazer todas as mudanças devolve o arquivo idêntico byte a byte ao original
        (sem as folgas de alinhamento que gravações intermediárias deixariam). Sem backup, o atual é o original.
          Current  RiotContainer do arquivo atual;  Replace  {RiotChunk do atual: bytes novos}
    EN: Builds the new file from the ORIGINAL (backup when present): only chunks whose final content differs from the
        original are replaced, so undoing every change gives the original back byte for byte.
    """
    Backup = BackupPath(Path, GameRoot)
    if not os.path.exists(Backup):
        return RebuildContainer(Current, Replace=Replace)
    Original = RiotContainer(Backup)
    Final = {(Chunk.ChunkType, Chunk.ChunkId): (Replace[Chunk] if Chunk in Replace else Current.ChunkData(Chunk)) for Chunk in Current.Chunks}
    Keys = [(Chunk.ChunkType, Chunk.ChunkId) for Chunk in Original.Chunks]
    if sorted(Keys) != sorted(Final) or len(set(Keys)) != len(Keys):
        return RebuildContainer(Current, Replace=Replace)     # PT: estrutura mudou / EN: structure changed
    Changed = {Chunk: Final[(Chunk.ChunkType, Chunk.ChunkId)] for Chunk in Original.Chunks
               if bytes(Original.ChunkData(Chunk)) != bytes(Final[(Chunk.ChunkType, Chunk.ChunkId)])}
    return RebuildContainer(Original, Replace=Changed)


def BackupPath(Path, GameRoot):
    """PT: Onde fica o original de um arquivo. EN: Where a file's original is kept."""
    return os.path.join(GameRoot, 'SurrealEd Backup', os.path.relpath(os.path.abspath(Path), os.path.abspath(GameRoot)))


def RestoreOriginal(Path, GameRoot):
    """PT: Devolve o arquivo original (do backup). EN: Puts the original file back from the backup."""
    Backup = BackupPath(Path, GameRoot)
    if not os.path.exists(Backup):
        return False
    with open(Backup, 'rb') as Source, open(Path + '.surrealed.tmp', 'wb') as Target:
        Target.write(Source.read())
    os.replace(Path + '.surrealed.tmp', Path)
    return True


def ChunksInFileOrder(Container):
    """
    PT: Pedaços na ordem física do arquivo, como (ChunkType, ChunkId, bytes): use para regravar mantendo o layout.
    EN: Chunks in physical file order as (ChunkType, ChunkId, bytes), to rewrite keeping the layout.
    """
    return [(Chunk.ChunkType, Chunk.ChunkId, Container.ChunkData(Chunk)) for Chunk in sorted(Container.Chunks, key=lambda Chunk: Chunk.Offset)]


class RiotReader:
    """
    PT: Leitor sequencial de bytes (little-endian), usado por todos os módulos.
    EN: Sequential little-endian byte reader shared by every module.
    """
    __slots__ = ('Data', 'Position')

    def __init__(self, Data, Position=0):
        self.Data = Data
        self.Position = Position

    def Unpack(self, Format):
        Values = struct.unpack_from(Format, self.Data, self.Position)
        self.Position += struct.calcsize(Format)
        return Values

    def U8(self):
        return self.Unpack('<B')[0]

    def U16(self):
        return self.Unpack('<H')[0]

    def I16(self):
        return self.Unpack('<h')[0]

    def U32(self):
        return self.Unpack('<I')[0]

    def I32(self):
        return self.Unpack('<i')[0]

    def F32(self):
        return self.Unpack('<f')[0]

    def Bytes(self, Count):
        Value = self.Data[self.Position:self.Position + Count]
        self.Position += Count
        return Value

    def String16(self):
        """PT: u16 tamanho + texto (latin-1, cortado no primeiro zero). EN: u16 length + latin-1 text."""
        Length = self.U16()
        return self.Bytes(Length).split(b'\0')[0].decode('latin1')

    def Remaining(self):
        return len(self.Data) - self.Position
