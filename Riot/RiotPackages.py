"""
RiotPackages — jogo, pacotes e referências / game, packages and references
==========================================================================

PT-BR
-----
* Detecta o jogo pela pasta: Suffering.exe (The Suffering, 2004) ou SufferingTTB.exe (Ties That Bind, 2005).
* Cada pacote é um conjunto de arquivos com o mesmo nome (System.mdu, System.tdu, System.odu…) e um
  arquivo .db de texto com o id do pacote ("id 2") e as dependências.
* Referência de recurso (4 bytes) usada em todos os formatos: u16 índice + u16 pacote, isto é,
  Ref = (Package << 16) | Index. Ref 0 = nenhum.
* Fases: arquivos .lvl dentro de LEVELS (TS1) ou Levels (TTB). O nome de exibição da fase fica no
  pedaço 0x0000 do .lvl (u16 tamanho + texto).
* Posições: o TS1 guarda as posições das instâncias multiplicadas por 2048 (FUN_0045A5C0); a TTB já guarda
  em unidades do mundo. PositionScale devolve o divisor certo.

EN
--
Detects the game from the folder (Suffering.exe / SufferingTTB.exe), indexes packages through their .db
files ("id N"), resolves 4-byte references (Ref = Package << 16 | Index) and lists levels with their display
names (chunk 0x0000 of the .lvl). TS1 stores instance positions ×2048; TTB stores world units.
"""
import os
import struct

from .RiotContainer import RiotContainer

GameTS1 = 'TS1'
GameTTB = 'TTB'
GameTitles = {GameTS1: 'The Suffering', GameTTB: 'The Suffering: Ties That Bind'}
PackageExtensions = ('.mdu', '.tdu', '.odu', '.adu', '.sdu', '.qdu', '.xdu', '.ldu', '.wdu', '.fdu', '.vdu', '.gdu')


def SplitRef(Ref):
    """PT: Ref -> (pacote, índice). EN: Ref -> (package, index)."""
    return Ref >> 16, Ref & 0xFFFF


def MakeRef(Package, Index):
    """PT: (pacote, índice) -> Ref. EN: (package, index) -> Ref."""
    return (Package << 16) | Index


def RefName(Package, Index):
    """PT: Código de exibição de um recurso ("2_000d"). EN: Display code of a resource."""
    return '%d_%04x' % (Package, Index)


class RiotGame:
    """
    PT: Pasta do jogo: detecta a versão, indexa os pacotes e abre os contêineres sob demanda (com cache).
    EN: Game folder: detects the version, indexes packages and opens containers on demand (cached).
    """

    def __init__(self, Root):
        self.Root = os.path.abspath(Root)
        Names = {Name.lower(): Name for Name in os.listdir(self.Root)}
        if 'sufferingttb.exe' in Names:
            self.Game, self.Exe = GameTTB, os.path.join(self.Root, Names['sufferingttb.exe'])
        elif 'suffering.exe' in Names:
            self.Game, self.Exe = GameTS1, os.path.join(self.Root, Names['suffering.exe'])
        else:
            raise FileNotFoundError('Suffering.exe / SufferingTTB.exe not found in ' + self.Root)
        Rfl = [Name for Lower, Name in Names.items() if Lower.endswith('.rfl')]
        self.Rfl = os.path.join(self.Root, Rfl[0]) if Rfl else None
        self.Title = GameTitles[self.Game]
        self.IsTTB = self.Game == GameTTB
        self.PositionScale = 1.0 if self.IsTTB else 2048.0
        self.Packages = {}          # id -> caminho base sem extensão / base path without extension
        self.PackageNames = {}      # id -> nome / name
        self._Containers = {}
        self._IndexPackages()

    def _IndexPackages(self):
        for Folder, Dirs, Files in os.walk(self.Root):
            Dirs[:] = [Name for Name in Dirs if Name != 'SurrealEd Backup']   # PT: originais guardados / EN: kept originals
            for FileName in Files:
                if not FileName.lower().endswith('.db'):
                    continue
                Path = os.path.join(Folder, FileName)
                try:
                    with open(Path, encoding='latin1') as Handle:
                        for Line in Handle:
                            if Line.startswith('id '):
                                PackageId = int(Line.split()[1])
                                self.Packages[PackageId] = Path[:-3]
                                self.PackageNames[PackageId] = FileName[:-3]
                                break
                except (OSError, ValueError):
                    pass

    # ------------------------------------------------------------------ arquivos / files
    def PackagePath(self, PackageId, Extension):
        """PT: Caminho de um arquivo do pacote (ou None se não existir). EN: Path of a package file (or None)."""
        Base = self.Packages.get(PackageId)
        if not Base:
            return None
        Path = Base + Extension
        return Path if os.path.exists(Path) else None

    def Container(self, Path):
        """PT: Abre um SRSC com cache. EN: Opens an SRSC (cached)."""
        if Path not in self._Containers:
            self._Containers[Path] = RiotContainer(Path)
        return self._Containers[Path]

    def PackageContainer(self, PackageId, Extension):
        """PT: Contêiner de um arquivo do pacote (ou None). EN: Container of a package file (or None)."""
        Path = self.PackagePath(PackageId, Extension)
        return self.Container(Path) if Path else None

    def ForgetContainer(self, Path):
        """PT: Descarta o cache depois de gravar um arquivo. EN: Drops the cache after a file is written."""
        self._Containers.pop(Path, None)

    # ------------------------------------------------------------------ fases / levels
    def Levels(self):
        """
        PT: Lista de fases: [{'Key', 'File', 'Name', 'Path', 'Folder'}], na ordem do jogo.
        EN: Level list in game order.
        """
        Result = []
        for Folder, Dirs, Files in os.walk(self.Root):
            Dirs[:] = [Name for Name in Dirs if Name != 'SurrealEd Backup']   # PT: originais guardados / EN: kept originals
            for FileName in Files:
                if FileName.lower().endswith('.lvl'):
                    Path = os.path.join(Folder, FileName)
                    Stem = FileName[:-4]
                    Result.append({'Key': Stem.replace(' ', '_'), 'File': Stem, 'Name': LevelDisplayName(Path) or Stem,
                                   'Path': Path, 'Folder': os.path.basename(Folder)})

        def Order(Level):
            Digits = ''
            for Character in Level['File']:
                if Character.isdigit():
                    Digits += Character
                else:
                    break
            return (int(Digits) if Digits else 999, Level['File'].lower())
        Result.sort(key=Order)
        return Result

    def LevelByKey(self, Key):
        for Level in self.Levels():
            if Level['Key'] == Key:
                return Level
        return None


def LevelDisplayName(Path):
    """PT: Nome da fase guardado no pedaço 0x0000 do .lvl. EN: Level name stored in chunk 0x0000."""
    try:
        Container = RiotContainer(Path)
    except (OSError, ValueError):
        return None
    Chunk = Container.FirstOfType(0x0000)
    if not Chunk:
        return None
    Length = struct.unpack_from('<H', Container.Data, Chunk.Offset)[0]
    return Container.Data[Chunk.Offset + 2:Chunk.Offset + 2 + Length].split(b'\0')[0].decode('latin1') or None
