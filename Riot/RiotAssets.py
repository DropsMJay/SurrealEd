"""
RiotAssets — navegação de texturas, modelos e animações / texture, model and animation browsing
===============================================================================================

PT-BR
-----
Serve as abas Texturas, Modelos e Animação do editor. Tudo é lido sob demanda dos arquivos do jogo:

    Packages()                 pacotes com quantas texturas (.tdu 0x0040), modelos (.mdu 0x0203) e animações
                               (.adu 0x0501) cada um tem, agrupados como no disco (Common, World Common, capítulo, fase)
    TextureList(p)             cabeçalhos das texturas de um pacote (sem ler os pixels)
    TextureBundle(p, i)        uma textura no formato de PackTextures (o navegador decodifica)
    ModelList(p)               modelos: vértices, faces do LOD 0, materiais, ossos, LODs e as classes que o usam
    ModelBundle(p, i)          grupos por material (mesmo formato da aba Fase), geometria binária, texturas e,
                               se tiver esqueleto, ossos e pesos do LOD 0
    AnimationList(p)           animações: duração, repetição, ossos, eventos e o modelo compatível mais provável
    Animation(p, i)            trilhas por osso, eventos, ligações e modelos compatíveis
    AnimationUsage()           quais modelos usam cada animação de verdade, seguindo os templates
    ModelAnimations(ref)       as animações de um modelo, de todos os pacotes
Compatível = o modelo tem os ossos (mesmos hashes) das trilhas da animação. Isso não basta para separar as animações
por modelo: muitos personagens (sobretudo no TTB) dividem o mesmo esqueleto. O uso real vem dos templates: um template
com o modelo (NPC, Animating Static…) aponta para comportamentos, que apontam para as animações. Seguimos essas
referências (sem entrar em templates de outros modelos com esqueleto) e só aceitamos animações cujos ossos o modelo tem.
Também contam as propriedades sobrescritas das instâncias nas fases (.lvl) e os eventos de animação das sequências
STOMP (a trilha aponta para uma instância, que tem o modelo).

EN
--
Backs the Textures, Models and Animation tabs. Everything is read on demand from the game files. A model is
"compatible" with an animation when its skeleton has the bone hashes the animation's tracks use.
"""
import os
import struct

from .RiotAnimations import ReadAnimationHeader, ReadAnimationInfo, ReadBoneIds, ReadEvents, ReadLinks, ReadTracks
from .RiotModels import ReadModel, ReadSkeleton, ReadSkinLods, SkinWeights
from .RiotPackages import RefName
from .RiotProperties import MessageName
from .RiotLevel import ReadInstances
from .RiotMedia import ParseSequence
from .RiotTextures import FormatDXT1, FormatDXT5, FormatL8, FormatNames, FormatPalette8, PackTextures, TextureMipCount


def _Group(Game, PackageId):
    """PT: Grupo do pacote pela pasta. EN: Package group from its folder."""
    Base = Game.Packages.get(PackageId, '')
    Parts = os.path.relpath(Base, Game.Root).replace('\\', '/').split('/')
    Top = Parts[0].lower() if Parts else ''
    Name = Game.PackageNames.get(PackageId, '').lower()
    if Top == 'common':
        return 'Common'
    if Top == 'world common':
        return 'World'
    if Top == 'levels':
        return 'Level' if Name.endswith('_level') else 'Chapter'
    return 'Other'


class RiotAssetBrowser:
    """PT: Consultas das abas de recursos, com cache. EN: Asset tab queries, cached."""

    def __init__(self, Game, Classes, Templates, Models, Textures, Materials, Builder):
        self.Game = Game
        self.Classes = Classes
        self.Templates = Templates
        self.Models = Models
        self.Textures = Textures
        self.Materials = Materials
        self.Builder = Builder
        self._Packages = None
        self._ModelClasses = None
        self._Skinned = None
        self._Usage = None
        self._AnimationRows = {}
        self._ModelCache = {}

    # ------------------------------------------------------------------ pacotes / packages
    def Packages(self):
        if self._Packages is not None:
            return self._Packages
        Result = []
        for PackageId in sorted(self.Game.Packages):
            Counts = {}
            for Extension, ChunkType, Key in (('.tdu', 0x0040, 'Textures'), ('.mdu', 0x0203, 'Models'), ('.adu', 0x0501, 'Animations'),
                                             ('.sdu', 0x0302, 'Sounds'), ('.qdu', 0x0311, 'Sequences'), ('.vdu', 0x0342, 'Videos')):
                Container = self.Game.PackageContainer(PackageId, Extension)
                Counts[Key] = len(Container.ResourceIndexes(ChunkType)) if Container else 0
            Folder = os.path.relpath(os.path.dirname(self.Game.Packages[PackageId]), self.Game.Root).replace('\\', '/')
            Result.append(dict(Counts, Id=PackageId, Name=self.Game.PackageNames.get(PackageId, '?'), Folder=Folder,
                               Group=_Group(self.Game, PackageId)))
        self._Packages = Result
        return Result

    # ------------------------------------------------------------------ texturas / textures
    def TextureList(self, PackageId):
        Container = self.Game.PackageContainer(PackageId, '.tdu')
        if not Container:
            return []
        Result = []
        for Index in Container.ResourceIndexes(0x0040):
            Chunk = Container.Resource(Index)[0x0040]
            Width, Height, _Row, Bpp, AlphaBits, _Minus1, Flags = struct.unpack_from('<7I', Container.Data, Chunk.Offset)
            DxtType = struct.unpack_from('<I', Container.Data, Chunk.Offset + 32)[0]
            Format = FormatDXT1 if (DxtType, Bpp) == (2, 4) else FormatL8 if (DxtType, Bpp, AlphaBits) == (3, 8, 8) else FormatDXT5 if (DxtType, Bpp) == (3, 8) else FormatPalette8 if (DxtType, Bpp) == (0, 8) else 0
            Result.append({'Index': Index, 'Ref': RefName(PackageId, Index), 'Width': Width, 'Height': Height,
                           'Format': FormatNames.get(Format, '?'), 'AlphaBits': AlphaBits, 'Flags': Flags, 'Bytes': Chunk.Size,
                           'Mips': TextureMipCount(Container, Chunk)})
        return Result

    def TextureBundle(self, PackageId, Index):
        Texture = self.Textures.Get(PackageId, Index)
        return PackTextures([Texture]) if Texture else None

    # ------------------------------------------------------------------ modelos / models
    def ModelClasses(self):
        """
        PT: {ref do modelo: [nomes de classe]} pelos templates de todos os pacotes, das mais usadas para as menos.
            Comportamentos e dados de IA (classes "...Behavior", Attack etc.) também carregam o modelo do dono;
            ficam no fim da lista.
        EN: model ref -> class names from every template, most used first (behaviours last).
        """
        if self._ModelClasses is not None:
            return self._ModelClasses
        Counts = {}
        for PackageId in self.Game.Packages:
            Container = self.Game.PackageContainer(PackageId, '.odu')
            if not Container:
                continue
            for TemplateIndex in Container.ResourceIndexes(0x0102):
                Template = self.Templates.Get(PackageId, TemplateIndex)
                if Template and Template.ModelRef:
                    Name = self.Classes.Name(Template.ClassId)
                    Table = Counts.setdefault(Template.ModelRef, {})
                    Table[Name] = Table.get(Name, 0) + 1
        Secondary = ('Behavior', 'Attack', 'Info', 'Properties', 'Modifier', 'Controller', 'Waypoint', 'Set', 'Part Cap', 'Line of Dialog', 'BouncingObject')
        self._ModelClasses = {Ref: sorted(Table, key=lambda Name: (any(Word in Name for Word in Secondary), -Table[Name], Name))
                              for Ref, Table in Counts.items()}
        return self._ModelClasses

    def Warm(self):
        """PT: Prepara as listas lentas (chamado numa thread ao abrir). EN: Builds the slow indexes ahead of time."""
        self.Packages()
        self.ModelClasses()
        self.SkinnedModels()
        self.AnimationUsage()

    def ModelList(self, PackageId):
        Container = self.Game.PackageContainer(PackageId, '.mdu')
        if not Container:
            return []
        Data = Container.Data
        Classes = self.ModelClasses()
        Result = []
        for Index in Container.ResourceIndexes(0x0203):
            Chunks = Container.Resource(Index)
            Row = {'Index': Index, 'Ref': RefName(PackageId, Index), 'Skinned': 0x0208 in Chunks,
                   'Vertices': struct.unpack_from('<H', Data, Chunks[0x0203].Offset)[0],
                   'Faces': struct.unpack_from('<H', Data, Chunks[0x0204].Offset)[0] if 0x0204 in Chunks else 0,
                   'Materials': 0, 'Bones': 0, 'Lods': 1,
                   'Classes': Classes.get((PackageId << 16) | Index, [])[:6]}
            if 0x0200 in Chunks:
                Chunk = Chunks[0x0200]
                Position = Chunk.Offset + 8 + (4 if struct.unpack_from('<I', Data, Chunk.Offset)[0] & 0x20000 else 0)
                Row['Materials'] = struct.unpack_from('<I', Data, Position)[0]
            if Row['Skinned']:
                try:
                    LodCount, _VertexCount, BoneCount = struct.unpack_from('<3I', Data, Chunks[0x0208].Offset + 64)
                    Row['Bones'], Row['Lods'] = BoneCount, LodCount
                    Row['Faces'] = ReadSkinLods(Data, Chunks[0x0208].Offset)[0][4]
                except struct.error:
                    pass
            Result.append(Row)
        return Result

    def ModelBundle(self, PackageId, Index):
        """PT: (json, geometria, texturas) de um modelo, com cache. EN: (json, geometry, textures), cached."""
        Key = (PackageId, Index)
        if Key in self._ModelCache:
            return self._ModelCache[Key]
        Model = self.Models.Get(PackageId, Index)
        if not Model:
            return None
        Buffer = bytearray()
        TextureRefs = set()
        Groups = self.Builder._ModelGroups(Model, Buffer, TextureRefs)
        Xs = [Point[0] for Point in Model.Positions] or [0]
        Ys = [Point[1] for Point in Model.Positions] or [0]
        Zs = [Point[2] for Point in Model.Positions] or [0]
        Used = sorted({Vertex for _Material, Corners in Model.Faces for Vertex in Corners})
        if Used:
            Xs, Ys, Zs = ([Model.Positions[Vertex][Axis] for Vertex in Used] for Axis in range(3))
        Info = {'Ref': RefName(PackageId, Index), 'Groups': Groups, 'Vertices': len(Model.Positions), 'Faces': len(Model.Faces),
                'Box': [min(Xs), min(Ys), min(Zs), max(Xs), max(Ys), max(Zs)],
                'Materials': [RefName(Ref >> 16, Ref & 0xFFFF) for Ref in Model.Materials],
                'Classes': self.ModelClasses().get((PackageId << 16) | Index, [])[:6], 'Skeleton': None}
        Container = self.Game.PackageContainer(PackageId, '.mdu')
        Chunk = Container.Resource(Index).get(0x0208)
        if Chunk:
            Skeleton = ReadSkeleton(Container.Data, Chunk.Offset)
            Info['Skeleton'] = {
                'Bones': [{'Id': Bone['Id'], 'Parent': Bone['Parent'], 'Matrix': [round(Value, 6) for Value in Bone['Matrix']]} for Bone in Skeleton['Bones']],
                'Weights': SkinWeights(Container, Index, Model, Skeleton),
                'Lods': [[round(Lod[0] / (1 if self.Game.IsTTB else 2048), 3)] + list(Lod[1:]) for Lod in Skeleton['Lods']]}
        Textures = PackTextures([Texture for Texture in (self.Textures.Get(*Ref) for Ref in sorted(TextureRefs)) if Texture])
        Bundle = (Info, bytes(Buffer), Textures)
        self._ModelCache[Key] = Bundle
        while len(self._ModelCache) > 6:
            self._ModelCache.pop(next(iter(self._ModelCache)))
        return Bundle

    # ------------------------------------------------------------------ animações / animations
    def SkinnedModels(self):
        """PT: [(ref, nome do pacote, ids dos ossos, classes)] de todos os modelos com esqueleto. EN: Every skinned model."""
        if self._Skinned is not None:
            return self._Skinned
        Classes = self.ModelClasses()
        Result = []
        for PackageId in sorted(self.Game.Packages):
            Container = self.Game.PackageContainer(PackageId, '.mdu')
            if not Container:
                continue
            for Chunk in Container.ChunksOfType(0x0208):
                try:
                    Position = Chunk.Offset + 64
                    LodCount, _VertexCount, BoneCount = struct.unpack_from('<3I', Container.Data, Position)
                    Position += 12
                    Ids = []
                    for _Bone in range(BoneCount):
                        Ids.append(struct.unpack_from('<I', Container.Data, Position)[0])
                        Position += 60
                        for _Lod in range(LodCount):
                            Position += 2 + 8 * struct.unpack_from('<H', Container.Data, Position)[0]
                except struct.error:
                    continue
                Ref = (PackageId << 16) | Chunk.Index
                Result.append((Ref, self.Game.PackageNames.get(PackageId, '?'), frozenset(Ids), Classes.get(Ref, [])[:3]))
        self._Skinned = Result
        return Result

    def Compatible(self, BoneIds, PackageId, Limit=12):
        """PT: Modelos que têm os ossos da animação, melhores primeiro. EN: Models that have the animation's bones."""
        Wanted = set(BoneIds)
        if not Wanted:
            return []
        Found = []
        for Ref, PackageName, Ids, Classes in self.SkinnedModels():
            Hit = len(Wanted & Ids)
            Share = Hit / len(Wanted)
            if Share < 0.8:
                continue
            Found.append((-Share, Ref >> 16 != PackageId, abs(len(Ids) - len(Wanted)), Ref, PackageName, Classes))
        Found.sort()
        return [{'Ref': RefName(Ref >> 16, Ref & 0xFFFF), 'Package': PackageName, 'Classes': Classes, 'Match': round(-Share, 3)}
                for Share, _Other, _Extra, Ref, PackageName, Classes in Found[:Limit]]

    def AnimationUsage(self):
        """
        PT: ({animação: [modelos]}, {modelo: [animações]}) a partir dos templates (veja o topo do arquivo).
        EN: ({animation: [models]}, {model: [animations]}) from the templates (see the top of the file).
        """
        if self._Usage is not None:
            return self._Usage
        Animations, Bones = {}, {}
        for PackageId in self.Game.Packages:
            Container = self.Game.PackageContainer(PackageId, '.adu')
            if Container:
                Animations[PackageId] = set(Container.ResourceIndexes(0x0501))
                for Index in Animations[PackageId]:
                    Bones[(PackageId << 16) | Index] = frozenset(ReadBoneIds(Container, Index))
        Templates = {}
        for PackageId in self.Game.Packages:
            Container = self.Game.PackageContainer(PackageId, '.odu')
            if not Container:
                continue
            for Index in Container.ResourceIndexes(0x0102):
                Template = self.Templates.Get(PackageId, Index)
                if Template:
                    Templates[(PackageId << 16) | Index] = Template
        Skeletons = {Ref: Ids for Ref, _Package, Ids, _Classes in self.SkinnedModels()}
        Users, ByModel = {}, {}

        def Walk(Model, Values, Seen):
            """PT: Segue as refs a partir de uns valores de propriedade. EN: Follows refs from some property values."""
            if Model not in Skeletons:
                return
            Stack = [Values]
            while Stack:
                for Value in Stack.pop():
                    if Value >> 16 in Animations and (Value & 0xFFFF) in Animations[Value >> 16]:
                        Wanted = Bones.get(Value)
                        if Wanted and len(Wanted & Skeletons[Model]) >= 0.8 * len(Wanted):
                            Users.setdefault(Value, set()).add(Model)
                            ByModel.setdefault(Model, set()).add(Value)
                    if Value in Templates and Value not in Seen:
                        Other = Templates[Value].ModelRef
                        if Other in Skeletons and Other != Model:
                            continue    # PT: outro personagem / EN: another character
                        Seen.add(Value)
                        Stack.append(Templates[Value].Slots)

        # PT: 1) templates com modelo / EN: 1) templates that carry a model
        for Root, Template in Templates.items():
            Walk(Template.ModelRef, Template.Slots, {Root})
        # PT: 2) instâncias das fases (propriedades sobrescritas, modelo próprio) e 3) eventos de animação do STOMP
        # EN: 2) level instances (overridden properties, own model) and 3) STOMP animation events
        InstanceModels = {}
        for Level in self.Game.Levels():
            try:
                Instances, _Complete = ReadInstances(self.Game.Container(Level['Path']))
            except (OSError, ValueError, struct.error):
                continue
            Folder = os.path.dirname(Level['Path'])
            for Instance in Instances:
                Template = Templates.get((Instance['TemplatePackage'] << 16) | Instance['TemplateIndex'])
                Model = (Instance['OwnModel'] or {}).get('ModelRef') or (Template.ModelRef if Template else 0)
                if Model in Skeletons:
                    InstanceModels[(Folder, Instance['Id'])] = Model
                    if Instance['Values']:
                        Walk(Model, Instance['Values'], set())
        for PackageId in self.Game.Packages:
            Container = self.Game.PackageContainer(PackageId, '.qdu')
            if not Container:
                continue
            Folder = os.path.dirname(self.Game.Packages[PackageId])
            for Chunk in Container.ChunksOfType(0x0311):
                try:
                    Sequence, _Used = ParseSequence(Container.ChunkData(Chunk), self.Game.IsTTB)
                except struct.error:
                    continue
                for Track in Sequence['Tracks']:
                    Model = InstanceModels.get((Folder, Track['Object']))
                    if Model:
                        Walk(Model, [Values[1] for Type, _Time, Values in Track['Events'] if Type == 1], set())
        self._Usage = ({Ref: sorted(Models) for Ref, Models in Users.items()}, {Ref: sorted(Refs) for Ref, Refs in ByModel.items()})
        return self._Usage

    def _ModelInfo(self, Ref, Match=1.0):
        for Model, PackageName, _Ids, Classes in self.SkinnedModels():
            if Model == Ref:
                return {'Ref': RefName(Ref >> 16, Ref & 0xFFFF), 'Package': PackageName, 'Classes': Classes, 'Match': Match, 'Used': True}
        return None

    def _AnimationRow(self, Container, PackageId, Index):
        Key = (PackageId, Index)
        if Key in self._AnimationRows:
            return self._AnimationRows[Key]
        Header = ReadAnimationHeader(Container, Index)
        if not Header:
            return None
        Duration, Loop, _BoneCount = Header
        Events, _Dependencies = ReadEvents(Container, Index)
        Ids = ReadBoneIds(Container, Index)
        Users = self.AnimationUsage()[0].get((PackageId << 16) | Index, [])
        if Users:
            Same = [Ref for Ref in Users if Ref >> 16 == PackageId]
            Model = self._ModelInfo((Same or Users)[0])
        else:
            Best = self.Compatible(Ids, PackageId, 1)
            Model = Best[0] if Best else None
        Row = {'Index': Index, 'Ref': RefName(PackageId, Index), 'Package': self.Game.PackageNames.get(PackageId, '?'),
               'Duration': round(Duration, 3), 'Loop': Loop, 'Bones': len(Ids), 'Events': len(Events),
               'Links': len(ReadLinks(Container, Index)), 'Model': Model,
               'Users': [RefName(Ref >> 16, Ref & 0xFFFF) for Ref in Users]}
        self._AnimationRows[Key] = Row
        return Row

    def AnimationList(self, PackageId):
        Container = self.Game.PackageContainer(PackageId, '.adu')
        if not Container:
            return []
        Rows = (self._AnimationRow(Container, PackageId, Index) for Index in Container.ResourceIndexes(0x0501))
        return [Row for Row in Rows if Row]

    def ModelAnimations(self, ModelRef):
        """
        PT: Animações de um modelo em todos os pacotes: as que os templates dele usam; sem templates, as compatíveis.
        EN: A model's animations across packages: the ones its templates use, or the bone-compatible ones as a fallback.
        """
        Refs = self.AnimationUsage()[1].get(ModelRef)
        Source = 'templates'
        if not Refs:
            Source = 'bones'
            Skeleton = next((Ids for Ref, _Package, Ids, _Classes in self.SkinnedModels() if Ref == ModelRef), None)
            Refs = []
            if Skeleton:
                for PackageId in sorted(self.Game.Packages):
                    Container = self.Game.PackageContainer(PackageId, '.adu')
                    if not Container:
                        continue
                    for Index in Container.ResourceIndexes(0x0501):
                        Wanted = set(ReadBoneIds(Container, Index))
                        if Wanted and len(Wanted & Skeleton) >= 0.8 * len(Wanted):
                            Refs.append((PackageId << 16) | Index)
        Rows = []
        for Ref in Refs:
            Container = self.Game.PackageContainer(Ref >> 16, '.adu')
            Row = self._AnimationRow(Container, Ref >> 16, Ref & 0xFFFF) if Container else None
            if Row:
                Rows.append(Row)
        return {'Model': RefName(ModelRef >> 16, ModelRef & 0xFFFF), 'Source': Source, 'Animations': Rows}

    def Animation(self, PackageId, Index):
        Container = self.Game.PackageContainer(PackageId, '.adu')
        if not Container:
            return None
        Header = ReadAnimationHeader(Container, Index)
        if not Header:
            return None
        Tracks = ReadTracks(Container, Index)
        Events, Dependencies = ReadEvents(Container, Index)
        Info = ReadAnimationInfo(Container, Index) or {}
        return {'Ref': RefName(PackageId, Index), 'Duration': round(Header[0], 4), 'Loop': Header[1],
                'PlaysOnce': bool(Header[1] & 1), 'BlendTime': round(Info.get('BlendTime', 0), 4), 'Rate': round(Info.get('Rate', 0), 4),
                'Tracks': {str(BoneId): Track for BoneId, Track in Tracks.items()},
                'Events': [dict(Event, Name=MessageName(Event['Code'], self.Game.IsTTB)) if Event['Type'] == 1 else Event for Event in Events],
                'Dependencies': [RefName(Ref >> 16, Ref & 0xFFFF) for Ref in Dependencies],
                'Links': [{'Ref': RefName(PackageId, Ref & 0xFFFF), 'Value': round(Value, 3)} for Ref, Value in ReadLinks(Container, Index)],
                'Compatible': self._CompatibleWithUsers(list(Tracks), PackageId, Index)}

    def _CompatibleWithUsers(self, BoneIds, PackageId, Index):
        """PT: Modelos que usam a animação (templates) primeiro, depois os compatíveis. EN: Users first, then compatible."""
        Compatible = self.Compatible(BoneIds, PackageId)
        Users = self.AnimationUsage()[0].get((PackageId << 16) | Index, [])
        Names = {RefName(Ref >> 16, Ref & 0xFFFF) for Ref in Users}
        Wanted = set(BoneIds)
        Front = []
        for Ref in Users:
            Ids = next((Ids for Model, _Package, Ids, _Classes in self.SkinnedModels() if Model == Ref), frozenset())
            Info = self._ModelInfo(Ref, round(len(Wanted & Ids) / max(1, len(Wanted)), 3))
            if Info:
                Front.append(Info)
        return Front + [Model for Model in Compatible if Model['Ref'] not in Names]
