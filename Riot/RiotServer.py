"""
RiotServer — servidor local do editor / the editor's local server
=================================================================

PT-BR
-----
Servidor HTTP que roda só no seu computador (127.0.0.1). Ele lê os arquivos do jogo na hora e entrega
para a interface do editor (pasta Editor/), que roda no navegador.

Endereços:
    /                              interface (Editor/index.html) e arquivos estáticos
    /api/Game                      jogo detectado, título e lista de fases
    /api/Level/<Key>               cena da fase (JSON: modelos, instâncias, luzes, texturas usadas)
    /api/LevelGeometry/<Key>       bloco binário com a geometria e as cores pré-calculadas
    /api/LevelTextures/<Key>       texturas da fase, comprimidas como no jogo (DXT1/DXT5/paleta)
    /api/LevelCells/<Key>          salas, células, portais e PVS
    /api/Materials/<Pkg>           materiais de um pacote (aba Material)
    /api/Material/<Pkg>/<Idx>      um material: slots, texturas, quadros, camadas, curva
    /api/StringPackages            pacotes com .xdu (textos)
    /api/Strings/<Pkg>             textos de um .xdu
    /api/LevelScript/<Key>         objetos ligados da fase (saídas, entradas, ligações) para a aba Scripting
    /api/LevelScriptNode/<Key>/<Id> um objeto sozinho (sem ligações) para a aba Scripting
    /api/LevelSequences/<Key>      sequências STOMP da fase (os .qdu da mesma pasta cujos objetos são dela)
    /api/Instance/<Key>/<Id>       flags e propriedades de uma instância (painel de propriedades)
    /api/Packages                  pacotes com contagem de texturas, modelos e animações
    /api/Textures/<P>, /api/Texture/<P>/<I>             lista de texturas / uma textura (bloco PackTextures)
    /api/Models/<P>, /api/Model/<P>/<I>, /api/ModelGeometry/<P>/<I>, /api/ModelTextures/<P>/<I>
    /api/Animations/<P>, /api/Animation/<P>/<I>         lista de animações / trilhas, eventos e modelos compatíveis
    /api/ModelAnimations/<P>/<I>                         animações usadas por um modelo (todos os pacotes)
    /api/Sounds/<P>, /api/SoundInfo/<P>/<I>, /api/Sound/<P>/<I> (WAV)       sons
    /api/Sequences/<P>, /api/Sequence/<P>/<I>                              sequências STOMP (.qdu)
    /api/SequenceRaw/<P>/<I>       sequência STOMP em forma editável (valores crus de cada evento)
    POST /api/PreviewSequence/<P>/<I>, /api/SaveSequence/<P>/<I>, /api/RestoreSequence/<P>/<I>   editar STOMP
    /api/Videos/<P>, /api/VideoWmv/<P>/<I>, /api/VideoMp4/<P>/<I>         vídeos (MP4 só com ffmpeg)
    /api/LevelEnvironment/<Key>    ambiente da fase: Level Properties, Sky Properties (neblina), switchers, névoa volumétrica
Nada é gravado nos arquivos do jogo por este módulo.

EN
--
Local-only HTTP server (127.0.0.1). Reads the game files on demand and serves the browser UI in Editor/.
Endpoints listed above. This module never writes to the game files.
"""
import http.server
import json
import mimetypes
import os
import socketserver
import struct
import threading
import traceback
import urllib.parse
import zlib

from .RiotAssets import RiotAssetBrowser
from .RiotClasses import RiotClassTable
from .RiotEnvironment import RiotEnvironment
from .RiotMaterialCatalog import MaterialClasses as MaterialClassIds, RiotMaterialCatalog
from .RiotMaterials import RiotMaterialResolver
from .RiotLighting import RiotBakedLight
from .RiotModels import ModelBounds, RiotModelStore, SetModelMaterial
from .RiotContainer import BackupPath, RebuildContainer, RebuildFromOriginal, RestoreOriginal, RiotContainer, SaveContainerFile
import copy
from .RiotLevel import InstanceProperties, ReadInstances, ReadPortals, RiotLevel, SetInstanceProperty, WriteInstances
from .RiotLevelEdit import RiotCellTree, RiotHistory
from .RiotMedia import ParseSequence, WriteSequence
from .RiotMedia import RiotMedia
from .RiotPackages import RiotGame
from .RiotProperties import DescribeInstance, MessageName, MessageNames, MessageSlots, SlotLabel


def MessageNamesFor(IsTTB):
    return {str(Id): Name for Id, Name in MessageNames.get('TTB' if IsTTB else 'TS1', {}).items()}
from .RiotRendering import RiotSceneBuilder
from .RiotTemplates import PatchTemplate, RiotTemplateStore
from .RiotTextures import BuildTextureChunk, FormatDXT1, FormatDXT5, PackTextures, RiotTextureStore, TextureMipCount

Version = '0.1.0'
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')


class RiotSession:
    """
    PT: Estado compartilhado: o jogo aberto, os stores e um cache das últimas fases montadas.
    EN: Shared state: opened game, stores and a cache of the last built levels.
    """

    def __init__(self, GameRoot, EditorFolder):
        self.Game = RiotGame(GameRoot)
        self.EditorFolder = EditorFolder
        self.Classes = RiotClassTable(self.Game)
        self.Templates = RiotTemplateStore(self.Game)
        self.Models = RiotModelStore(self.Game)
        self.Textures = RiotTextureStore(self.Game)
        self.Materials = RiotMaterialResolver(self.Game, self.Templates, self.Textures)
        self.MaterialCatalog = RiotMaterialCatalog(self.Game, self.Templates, self.Textures, self.Materials)
        self.Builder = RiotSceneBuilder(self.Game, self.Classes, self.Templates, self.Models, self.Textures, self.Materials)
        self.LevelList = self.Game.Levels()
        self.Environment = RiotEnvironment(self.Game, self.Classes, self.Templates)
        self.Media = RiotMedia(self.Game, self.Classes, self.Templates)
        self.Assets = RiotAssetBrowser(self.Game, self.Classes, self.Templates, self.Models, self.Textures, self.Materials, self.Builder)
        self.Lock = threading.Lock()
        self.Cache = {}
        self.CacheOrder = []
        threading.Thread(target=self.WarmAssets, daemon=True).start()

    def WarmAssets(self):
        """PT: Monta as listas das abas de recursos em segundo plano. EN: Builds the asset tab indexes in the background."""
        with self.Lock:
            try:
                self.Assets.Warm()
            except Exception:   # PT: nunca derruba o servidor / EN: never takes the server down
                traceback.print_exc()

    def OpenLevel(self, Key):
        """PT: Fase aberta (RiotLevel), com cache. EN: Opened level (RiotLevel), cached."""
        Info = self.LevelInfo(Key)
        if not Info:
            return None
        with self.Lock:
            Cached = getattr(self, '_OpenLevel', None)
            if not Cached or Cached[0] != Key:
                self._OpenLevel = (Key, RiotLevel(Info['Path'], self.Game.IsTTB))
            return self._OpenLevel[1]

    def InstanceDetails(self, Key, InstanceId):
        """PT: Flags e propriedades de uma instância. EN: Flags and properties of one instance."""
        Level = self.OpenLevel(Key)
        if not Level:
            return None
        Instance = next((Item for Item in Level.Instances if Item['Id'] == InstanceId), None)
        if not Instance:
            return None
        Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        ClassName = self.Classes.Name(Template.ClassId) if Template else '?'
        Types = self.Classes.PropertyTypes(Template.ClassId) if Template else None
        ModelRef = Template.ModelRef if Template else 0
        if Instance['OwnModel'] and Instance['OwnModel']['ModelRef']:
            ModelRef = Instance['OwnModel']['ModelRef']
        Details = DescribeInstance(Instance, Template, ClassName, Types, self.Game.IsTTB, self.Game.PositionScale, ModelRef)
        Details.update(self.LinkInfo(Level, Instance))
        Details['ModelInfo'] = self.ModelInfo(ModelRef, Template.ModelRef if Template else 0, bool(Instance['OwnModel'] and Instance['OwnModel']['ModelRef']))
        Details['Sounds'] = self.InstanceSounds(Details['Properties'])
        return Details

    def InstanceSounds(self, Properties):
        """PT: Sons (.sdu) citados nas propriedades — para o botão tocar. EN: Playable sounds referenced by the properties."""
        Sounds = []
        for Row in Properties:
            for Ref in Row.get('Refs') or []:
                Info = self.Media.SoundInfo(Ref >> 16, Ref & 0xFFFF) if (Ref >> 16) in self.Game.Packages else None
                if Info and Info.get('Rate') and Info.get('Bytes'):
                    Sounds.append({'Slot': Row['Index'], 'Ref': Info['Ref'], 'Duration': Info['Duration'], 'Loop': Info['Loop'],
                                   'Volume': Info.get('Volume'), 'Text': Info.get('Text')})
        return Sounds

    def ModelInfo(self, ModelRef, TemplateRef, Own):
        """PT: Modelo do objeto e materiais dele (painel Details). EN: The object's model and its materials."""
        Name = lambda Ref: '%d_%04x' % (Ref >> 16, Ref & 0xFFFF) if Ref else None
        Model = self.Models.Get(ModelRef >> 16, ModelRef & 0xFFFF) if ModelRef else None
        Materials = []
        for Slot, Ref in enumerate(Model.Materials if Model else []):
            Texture = self.Materials.Texture(Ref >> 16, Ref & 0xFFFF) if Ref else None
            Materials.append({'Slot': Slot, 'Ref': Name(Ref), 'Texture': '%d_%04x' % Texture if Texture else None,
                              'Blend': self.Materials.Blend(Ref >> 16, Ref & 0xFFFF) if Ref else None})
        return {'Model': Name(ModelRef), 'Template': Name(TemplateRef), 'Own': Own, 'Materials': Materials,
                'Users': None}

    def _ApplyModel(self, Instance, Ref, Original):
        """
        PT: Troca o modelo de uma instância (bloco "modelo próprio", flag 0x8000): referência + esfera/caixa que o modelo
            declara (RiotModels.ModelBounds). A luz pré-calculada (.ldu, uma cor por vértice do modelo) só fica se for
            do modelo novo; senão a instância fica sem .ldu (estado que já existe no jogo). Voltar ao modelo original
            devolve flag, bloco e .ldu do backup, então o .lvl volta idêntico.
        EN: Changes an instance's model (own-model block, flag 0x8000) with the model's declared bounds; baked light is
            dropped unless it belongs to the new model; going back to the original model restores it byte for byte.
        """
        Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        Effective = lambda Item: (Item['OwnModel']['ModelRef'] if Item.get('OwnModel') and Item['OwnModel']['ModelRef'] else (Template.ModelRef if Template else 0))
        if Original is not None and Ref == Effective(Original):
            Instance['Flags'] = (Instance['Flags'] & ~0x8000) | (Original['Flags'] & 0x8000)
            Instance['OwnModel'] = copy.deepcopy(Original['OwnModel'])
            Instance['Tail'] = Original['Tail']
            return
        if Ref == Effective(Instance):
            return
        Container = self.Game.PackageContainer(Ref >> 16, '.mdu')
        Bounds = ModelBounds(Container, Ref & 0xFFFF) if Container else None
        if not Bounds:
            raise ValueError('model %d_%04x not found or without bounds / modelo sem limites' % (Ref >> 16, Ref & 0xFFFF))
        Instance['Flags'] |= 0x8000
        Instance['OwnModel'] = {'ModelRef': Ref, 'Sphere': Bounds[:4], 'Matrix': Bounds[4:]}
        Baked = RiotBakedLight(self.Game).Colors(Instance['Tail']) if Instance['Tail'] else None
        if not Baked or Baked[0] != Ref:
            Instance['Tail'] = 0

    def SetModelMaterial(self, Package, Index, Slot, MaterialRef):
        """
        PT: Troca o material Slot de um modelo (.mdu, pedaço 0x0200; vale para todo objeto que usa esse modelo).
            Refeito a partir do original: voltar o material devolve o arquivo idêntico.
        EN: Swaps one material of a model (0x0200; affects every object using the model). Rebuilt from the original.
        """
        Path = self.Game.PackagePath(Package, '.mdu')
        if not Path:
            return {'Error': 'unknown package / pacote desconhecido'}
        with self.Lock:
            Container = RiotContainer(Path)
            Chunk = Container.Resource(Index).get(0x0200)
            if not Chunk:
                return {'Error': 'unknown model / modelo desconhecido'}
            Target = self.Templates.Get(MaterialRef >> 16, MaterialRef & 0xFFFF)
            if not Target or Target.ClassId not in MaterialClassIds:
                return {'Error': 'not a material / não é um material'}
            try:
                New = SetModelMaterial(Container.Data, Chunk.Offset, Chunk.Size, int(Slot), MaterialRef)
            except ValueError as Error:
                return {'Error': str(Error)}
            if New == Container.ChunkData(Chunk):
                return {'Saved': 0}
            Backup = SaveContainerFile(Path, RebuildFromOriginal(Path, self.Game.Root, Container, {Chunk: New}), self.Game.Root)
            self.Game.ForgetContainer(Path)
            self.Models._Cache.pop((Package, Index), None)
            self.Assets._ModelCache.pop((Package, Index), None)
            self.Cache.clear()
            self.CacheOrder.clear()
        return {'Saved': 1, 'Backup': os.path.relpath(Backup, self.Game.Root)}

    def LevelScript(self, Key):
        """
        PT: A "programação" da fase como grafo: cada objeto que manda ou recebe ligações vira um nó, com as propriedades
            de saída (mensagem que ele manda para TODOS os links) e de entrada (mensagem que ele escuta) e as entradas
            fixas da classe; as ligações (lista Links da instância) são as arestas.
        EN: The level's logic as a graph: every object that sends or receives links is a node (output/input message
            properties and the class's fixed inputs); the instance Links lists are the edges.
        """
        Level = self.OpenLevel(Key)
        if not Level:
            return None
        IsTTB, Scale = self.Game.IsTTB, self.Game.PositionScale
        Targets = {Uid for Instance in Level.Instances for Uid in Instance['Links']}
        Nodes = [self.ScriptNode(Instance) for Instance in Level.Instances if Instance['Links'] or Instance['Id'] in Targets]
        return {'Key': Key, 'Nodes': Nodes, 'MessageNames': {str(Id): Name for Id, Name in MessageNames.get('TTB' if IsTTB else 'TS1', {}).items()}}

    def ScriptNode(self, Instance):
        """PT: Um nó do grafo da aba Scripting. EN: One Scripting graph node."""
        IsTTB, Scale = self.Game.IsTTB, self.Game.PositionScale
        Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        Slots = MessageSlots(Template.ClassId, IsTTB) if Template else MessageSlots(None, IsTTB)
        Values = InstanceProperties(Template, Instance) if Template else {}
        ClassId = Template.ClassId if Template else None
        Port = lambda Index: {'Property': Index, 'Message': Values.get(Index, 0), 'Name': MessageName(Values.get(Index, 0), IsTTB),
                              'Label': SlotLabel(ClassId, Index, IsTTB)}
        return {
            'Id': Instance['Id'], 'Class': self.Classes.Name(Template.ClassId) if Template else '?',
            'Template': '%d_%04x' % (Instance['TemplatePackage'], Instance['TemplateIndex']),
            'Position': [round(Value / Scale, 3) for Value in Instance['Position']],
            'Outputs': [Port(Index) for Index in Slots['outputs']],
            'Inputs': [Port(Index) for Index in Slots['inputs']],
            'Fixed': [{'Message': Id, 'Name': MessageName(Id, IsTTB)} for Id in Slots['fixed'] if Id < 0x1000],
            'Links': list(Instance['Links']),
            'Sounds': self.NodeSounds(Instance, Template),
        }

    def NodeSounds(self, Instance, Template):
        """PT: Sons tocáveis de um Sound Effect (lista p0) para o ▶ do nó. EN: Playable sounds of a Sound Effect (p0 list)."""
        if not Template or self.Classes.Name(Template.ClassId) != 'Sound Effect':
            return []
        from .RiotProperties import _ArrayItems
        Overridden = dict(zip(Instance['PropertyIndexes'], range(len(Instance['PropertyIndexes']))))
        if 0 in Overridden:
            Words, Header = Instance['Values'], Instance['Values'][Overridden[0]]
        else:
            Words, Header = Template.Slots, Template.Slot(0)
        Result = []
        for Ref in _ArrayItems(Words, Header) if isinstance(Header, int) else []:
            if isinstance(Ref, int) and (Ref >> 16) in self.Game.Packages:
                Container = self.Game.PackageContainer(Ref >> 16, '.sdu')
                if Container and self.Media._SoundHeader(Container, Ref & 0xFFFF):
                    Result.append('%d_%04x' % (Ref >> 16, Ref & 0xFFFF))
        return Result

    def LevelScriptNode(self, Key, InstanceId):
        """PT: Nó de um objeto sem ligações (a aba Scripting o mostra sozinho). EN: Node of an unlinked object."""
        Level = self.OpenLevel(Key)
        Instance = next((Item for Item in Level.Instances if Item['Id'] == InstanceId), None) if Level else None
        return self.ScriptNode(Instance) if Instance else None

    def LinkInfo(self, Level, Instance):
        """
        PT: Ligações de saída e de entrada da instância. Uma saída manda a mensagem guardada na propriedade para TODOS os
            links; o alvo só reage se uma propriedade de entrada dele tiver a mesma mensagem (ou se ela for fixa).
        EN: Outgoing and incoming links. An output sends its property's message to every link; a target reacts when one
            of its input properties holds that message (or it is a fixed input).
        """
        IsTTB, Scale = self.Game.IsTTB, self.Game.PositionScale
        ById = {Item['Id']: Item for Item in Level.Instances}

        def Describe(Item):
            Template = self.Templates.Get(Item['TemplatePackage'], Item['TemplateIndex'])
            return Template, (self.Classes.Name(Template.ClassId) if Template else '?')

        def Sent(Item, Template):
            Values = InstanceProperties(Template, Item) if Template else {}
            return {Index: Values.get(Index, 0) for Index in MessageSlots(Template.ClassId, IsTTB)['outputs']} if Template else {}

        def Heard(Item, Template, Messages):
            if not Template:
                return []
            Slots = MessageSlots(Template.ClassId, IsTTB)
            Values = InstanceProperties(Template, Item)
            Inputs = {Values.get(Index, 0): Index for Index in Slots['inputs'] if Values.get(Index, 0)}
            Result = []
            for Message in Messages:
                if Message in Inputs:
                    Result.append({'Message': Message, 'Name': MessageName(Message, IsTTB), 'Property': Inputs[Message]})
                elif Message in Slots['fixed']:
                    Result.append({'Message': Message, 'Name': MessageName(Message, IsTTB), 'Property': None})
            return Result

        Template, _Name = Describe(Instance)
        Outputs = {Index: Value for Index, Value in Sent(Instance, Template).items() if Value}
        Out = []
        for Uid in Instance['Links']:
            Target = ById.get(Uid)
            if not Target:
                Out.append({'Id': Uid, 'Missing': True})
                continue
            TargetTemplate, TargetClass = Describe(Target)
            Out.append({'Id': Uid, 'Class': TargetClass, 'Position': [round(Value / Scale, 3) for Value in Target['Position']],
                        'Heard': Heard(Target, TargetTemplate, set(Outputs.values()))})
        In = []
        for Source in Level.Instances:
            if Instance['Id'] in Source['Links']:
                SourceTemplate, SourceClass = Describe(Source)
                Messages = {Value for Value in Sent(Source, SourceTemplate).values() if Value}
                In.append({'Id': Source['Id'], 'Class': SourceClass, 'Position': [round(Value / Scale, 3) for Value in Source['Position']],
                           'Heard': Heard(Instance, Template, Messages)})
        return {'Outputs': [{'Property': Index, 'Message': Value, 'Name': MessageName(Value, IsTTB)} for Index, Value in sorted(Outputs.items())],
                'LinkOut': Out, 'LinkIn': In}

    # ------------------------------------------------------------------ gravação / saving
    def Forget(self, Key):
        """PT: Esquece o que foi montado de uma fase (depois de gravar). EN: Drops cached data of a level."""
        with self.Lock:
            self.Cache.pop(Key, None)
            if Key in self.CacheOrder:
                self.CacheOrder.remove(Key)
            if getattr(self, '_OpenLevel', None) and self._OpenLevel[0] == Key:
                self._OpenLevel = None
            Info = self.LevelInfo(Key)
            if Info:
                self.Game.ForgetContainer(Info['Path'])

    def _ApplyChange(self, Instance, Change):
        """PT: Aplica posição/rotação/escala/flags/propriedades numa instância. EN: Applies one change to an instance."""
        Scale = self.Game.PositionScale
        if 'Position' in Change:
            Instance['Position'] = tuple(float(Value) * Scale for Value in Change['Position'])
        if 'Rotation' in Change:
            Instance['Rotation'] = tuple(max(-32768, min(32767, int(round(Value)))) for Value in Change['Rotation'])
        if 'Flags' in Change:
            Flags = int(Change['Flags']) & 0xFFFFFFFF
            Fixed = 0x10 | 0x100 | 0x8000
            Instance['Flags'] = (Flags & ~Fixed) | (Instance['Flags'] & Fixed)
        if 'Properties' in Change:
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            Types = self.Classes.PropertyTypes(Template.ClassId) if Template else None
            for Index, Value in Change['Properties'].items():
                SetInstanceProperty(Instance, int(Index), int(Value), Types)
        if 'Links' in Change:
            # PT: a lista de ligações é gravada inteira (i16 de contagem + u32 por id, RiotLevel.WriteInstances)
            # EN: the whole link list is written back (i16 count + one u32 per id)
            Links = [int(Value) & 0xFFFFFFFF for Value in Change['Links']]
            if len(Links) > 32767:
                raise ValueError('too many links / ligações demais')
            Instance['Links'] = Links
        if 'Scale' in Change:
            Values = tuple(float(Value) for Value in Change['Scale'])
            if Instance['Flags'] & 0x100 or any(abs(Value - 1.0) > 1e-6 for Value in Values):
                Instance['Flags'] |= 0x100
                Instance['Scale'] = Values

    def _FolderIds(self, Info):
        """PT: Ids usados pelas fases da mesma pasta (o id novo fica acima de todos). EN: Ids used by the folder's levels."""
        Folder = os.path.dirname(Info['Path'])
        Ids = set()
        for Level in self.Game.Levels():
            if os.path.dirname(Level['Path']) == Folder:
                try:
                    Instances, _Complete = ReadInstances(RiotContainer(Level['Path']))
                except (OSError, ValueError):
                    continue
                Ids.update(Instance['Id'] for Instance in Instances)
        return Ids

    def _StompObjects(self, Info):
        """PT: Ids de objetos usados como trilha de STOMP nos pacotes da pasta da fase. EN: Ids used by STOMP tracks."""
        Folder = os.path.dirname(Info['Path'])
        Ids = set()
        for PackageId, Path in self.Game.Packages.items():
            if os.path.dirname(Path) != Folder:
                continue
            Container = self.Game.PackageContainer(PackageId, '.qdu')
            for Chunk in (Container.ChunksOfType(0x0311) if Container else []):
                try:
                    Sequence, _Used = ParseSequence(Container.ChunkData(Chunk), self.Game.IsTTB)
                except Exception:
                    continue
                Ids.update(Track['Object'] for Track in Sequence['Tracks'] if Track['Object'])
        return Ids

    def _References(self, Instances, Removed, Container, Info):
        """
        PT: Quem ainda aponta para os objetos que vão ser apagados (links, propriedades de objeto, portais, STOMP).
        EN: What still points at the objects being deleted (links, object properties, portals, STOMP tracks).
        """
        Problems = []
        for Instance in Instances:
            if Instance['Id'] in Removed:
                continue
            for Uid in Instance['Links']:
                if Uid in Removed:
                    Problems.append('#%d link -> #%d' % (Instance['Id'], Uid))
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            Types = self.Classes.PropertyTypes(Template.ClassId) if Template else None
            if not Types:
                continue
            Values = Instance['Values']
            for Number, Index in enumerate(Instance['PropertyIndexes']):
                if Index >= len(Types) or Number >= len(Values) or Types[Index] & 0xFF != 0x13:
                    continue
                Items = [Values[Number]]
                if Types[Index] & 0x1000:
                    Offset, Count = Values[Number] & 0xFFFF, Values[Number] >> 16
                    Items = Values[Offset:Offset + Count]
                for Uid in Items:
                    if Uid in Removed:
                        Problems.append('#%d p%d -> #%d' % (Instance['Id'], Index, Uid))
        Chunk = Container.FirstOfType(0x0027)
        if Chunk:
            try:
                for Cell in ReadPortals(Container.ChunkData(Chunk), self.Game.IsTTB):
                    for Portal in Cell.get('Portals', []):
                        if Portal.get('Instance') in Removed:
                            Problems.append('portal #%d' % Portal['Instance'])
            except Exception:
                pass
        for Uid in self._StompObjects(Info) & set(Removed):
            Problems.append('STOMP -> #%d' % Uid)
        return Problems

    def SaveLevel(self, Key, Changes, Added=None, Removed=None):
        """
        PT: Aplica mudanças nas instâncias de uma fase e grava o .lvl (com backup do original na primeira vez).
            Changes = [{Id, Position? (unidades do editor), Rotation? (3 inteiros), Scale?, Flags?, Properties?}].
            Added = [{Temp, Source, Position, Rotation, Scale, Flags?, Properties?}]: cópias de Source com id novo
            (folha na árvore de células e linha no histórico, ver RiotLevelEdit). Removed = [ids]: só apaga o que
            ninguém mais referencia.
        EN: Applies instance changes, copies (Added) and deletions (Removed), then writes the .lvl with a backup.
        """
        Info = self.LevelInfo(Key)
        if not Info:
            return {'Error': 'unknown level / fase desconhecida'}
        Added, Removed = Added or [], set(int(Value) for Value in (Removed or []))
        with self.Lock:
            Container = RiotContainer(Info['Path'])
            Chunk = Container.FirstOfType(0x0020)
            Instances, Complete = ReadInstances(Container)
            if not Chunk or not Complete:
                return {'Error': 'instances not fully understood; not saving / instâncias não lidas por completo; nada gravado'}
            ById = {Instance['Id']: Instance for Instance in Instances}
            Originals = {Add.get('Source'): copy.deepcopy(ById.get(Add.get('Source'))) for Add in Added}
            Replace = {}
            Applied = 0
            try:
                OriginalById = None
                for Change in Changes:
                    Instance = ById.get(Change.get('Id'))
                    if not Instance:
                        return {'Error': 'unknown instance %s / instância desconhecida' % Change.get('Id')}
                    self._ApplyChange(Instance, Change)
                    if Change.get('Model'):
                        if OriginalById is None:
                            Backup = BackupPath(Info['Path'], self.Game.Root)
                            Source = RiotContainer(Backup) if os.path.exists(Backup) else Container
                            OriginalById = {Item['Id']: Item for Item in ReadInstances(Source)[0]}
                        Package, _Sep, Index = str(Change['Model']).partition('_')
                        self._ApplyModel(Instance, (int(Package) << 16) | int(Index, 16), OriginalById.get(Instance['Id']))
                    Applied += 1
                Tree = History = None
                if Added or Removed:
                    CellChunk, HistoryChunk = Container.FirstOfType(0x0026), Container.FirstOfType(0x0028)
                    Tree = RiotCellTree(Container.ChunkData(CellChunk), self.Game.IsTTB) if CellChunk else None
                    History = RiotHistory(Container.ChunkData(HistoryChunk)) if HistoryChunk else None
                # PT: apagar / EN: delete
                if Removed:
                    Missing = [Uid for Uid in Removed if Uid not in ById]
                    if Missing:
                        return {'Error': 'unknown instance %s / instância desconhecida' % Missing[0]}
                    Problems = self._References(Instances, Removed, Container, Info)
                    if Problems:
                        return {'Error': 'still referenced / ainda referenciado: ' + ', '.join(Problems[:8]), 'References': Problems}
                    for Number in sorted((Number for Number, Instance in enumerate(Instances) if Instance['Id'] in Removed), reverse=True):
                        if Tree:
                            Tree.Remove(Instances[Number]['Id'])
                        if History:
                            History.Remove(Number)
                        del Instances[Number]
                # PT: copiar / EN: copy
                NewIds = {}
                if Added:
                    Next = max(self._FolderIds(Info) | set(ById)) + 1
                    for Add in Added:
                        Source = Originals.get(Add.get('Source'))
                        if not Source:
                            return {'Error': 'unknown instance %s / instância desconhecida' % Add.get('Source')}
                        Instance = copy.deepcopy(Source)
                        Instance['Id'] = Next
                        self._ApplyChange(Instance, Add)
                        Instances.append(Instance)
                        if Tree:
                            Delta = [New - Old for New, Old in zip(Instance['Position'], Source['Position'])]
                            Tree.AddCopy(Source['Id'], Next, Delta, Instance['Position'])
                        if History:
                            History.Append()
                        NewIds[str(Add.get('Temp'))] = Next
                        Next += 1
                if Tree:
                    if not Tree.Check():
                        return {'Error': 'cell tree check failed; not saving / a árvore de células não fechou; nada gravado'}
                    Replace[Container.FirstOfType(0x0026)] = Tree.Write()
                if History:
                    Replace[Container.FirstOfType(0x0028)] = History.Write()
            except (ValueError, KeyError, TypeError) as Error:
                return {'Error': str(Error)}
            Replace[Chunk] = WriteInstances(Instances)
            Data = RebuildFromOriginal(Info['Path'], self.Game.Root, Container, Replace)
            Check, _Ok = ReadInstances(RiotContainer(Data=Data))
            if len(Check) != len(Instances):
                return {'Error': 'verification failed; not saving / a verificação falhou; nada gravado'}
            Backup = SaveContainerFile(Info['Path'], Data, self.Game.Root)
        self.Forget(Key)
        return {'Saved': Applied + len(Added) + len(Removed), 'Added': NewIds, 'Removed': len(Removed), 'File': Info['File'],
                'Backup': os.path.relpath(Backup, self.Game.Root)}

    def ImportTexture(self, Package, Index, Options, Payload):
        """
        PT: Troca uma textura do .tdu (o editor manda o DXT pronto). Maior ou menor que a original, tanto faz.
        EN: Replaces one texture in a .tdu (the editor sends ready DXT data). May be larger or smaller.
        """
        Path = self.Game.PackagePath(Package, '.tdu')
        if not Path:
            return {'Error': 'unknown package / pacote desconhecido'}
        with self.Lock:
            Container = RiotContainer(Path)
            Chunk = Container.Resource(Index).get(0x0040)
            if not Chunk:
                return {'Error': 'unknown texture / textura desconhecida'}
            Format = FormatDXT1 if Options.get('format') == 'dxt1' else FormatDXT5
            try:
                Width, Height = int(Options['width']), int(Options['height'])
                Mips = int(Options.get('mips', 0))
                if Mips != TextureMipCount(Container, Chunk):
                    return {'Error': 'mip count mismatch / número de mipmaps não confere'}
                AlphaBits = int(Options.get('alphabits', 0))
                if Format == FormatDXT5:
                    AlphaBits = 4     # PT: 8 faria o jogo ler como L8 / EN: 8 would make the game read L8
                New = BuildTextureChunk(Container.ChunkData(Chunk), Width, Height, Format, AlphaBits, Payload, Mips)
            except (KeyError, ValueError) as Error:
                return {'Error': str(Error)}
            Data = RebuildFromOriginal(Path, self.Game.Root, Container, {Chunk: New})
            Backup = SaveContainerFile(Path, Data, self.Game.Root)
            self._AfterAssetWrite(Path)
        return {'Saved': True, 'Bytes': len(New), 'OldBytes': Chunk.Size, 'Backup': os.path.relpath(Backup, self.Game.Root)}

    def SaveStrings(self, Package, Changes):
        """
        PT: Troca textos de um .xdu (só os pedaços mudados; o resto do arquivo fica idêntico). Backup na primeira vez.
        EN: Replaces strings of a .xdu (only the changed chunks; the rest stays identical). Backup on first save.
        """
        Path = self.Game.PackagePath(Package, '.xdu')
        if not Path:
            return {'Error': 'unknown package / pacote desconhecido'}
        with self.Lock:
            Container = RiotContainer(Path)
            Replace = {}
            try:
                for Key, Text in Changes.items():
                    Chunk = Container.Resource(int(Key)).get(0x0400)
                    if not Chunk:
                        return {'Error': 'unknown string %s / texto desconhecido' % Key}
                    New = self.Media.EncodeString(str(Text), Container.ChunkData(Chunk))
                    if New != Container.ChunkData(Chunk):
                        Replace[Chunk] = New
            except ValueError as Error:
                return {'Error': str(Error)}
            if not Replace:
                return {'Saved': 0}
            Backup = SaveContainerFile(Path, RebuildFromOriginal(Path, self.Game.Root, Container, Replace), self.Game.Root)
            self.Game.ForgetContainer(Path)
            self.Media._Strings.pop(Package, None)
        return {'Saved': len(Replace), 'Backup': os.path.relpath(Backup, self.Game.Root)}

    def PreviewSequence(self, Package, Index, Raw):
        """PT: Decodifica uma sequência editada (sem gravar) para o tocador. EN: Decodes an edited sequence (no write)."""
        with self.Lock:
            try:
                Sequence = self.Media.SequenceFromRaw(Package, Index, Raw)
            except (ValueError, KeyError, TypeError, struct.error) as Error:
                return {'Error': str(Error)}
            return self.Media.DescribeSequence(Package, Index, Sequence)

    def SaveSequence(self, Package, Index, Raw):
        """
        PT: Grava uma sequência STOMP editada no .qdu (só esse pedaço muda; refeito a partir do original, então desfazer
            tudo devolve o arquivo idêntico). Backup do original na primeira vez.
        EN: Writes an edited STOMP sequence into its .qdu (only that chunk changes; rebuilt from the original backup).
        """
        Path = self.Game.PackagePath(Package, '.qdu')
        if not Path:
            return {'Error': 'unknown package / pacote desconhecido'}
        with self.Lock:
            try:
                Sequence = self.Media.SequenceFromRaw(Package, Index, Raw)
            except (ValueError, KeyError, TypeError, struct.error) as Error:
                return {'Error': str(Error)}
            Container = RiotContainer(Path)
            Chunk = Container.Resource(Index).get(0x0311)
            New = WriteSequence(Sequence, self.Game.IsTTB)
            if New == Container.ChunkData(Chunk):
                return {'Saved': 0}
            Backup = SaveContainerFile(Path, RebuildFromOriginal(Path, self.Game.Root, Container, {Chunk: New}), self.Game.Root)
            self.Game.ForgetContainer(Path)
        return {'Saved': 1, 'Bytes': len(New), 'Backup': os.path.relpath(Backup, self.Game.Root)}

    def RestoreSequence(self, Package, Index):
        """PT: Volta a sequência ao conteúdo do backup original. EN: Puts the sequence back as in the original backup."""
        Path = self.Game.PackagePath(Package, '.qdu')
        if not Path:
            return {'Error': 'unknown package / pacote desconhecido'}
        with self.Lock:
            Original = BackupPath(Path, self.Game.Root)
            if not os.path.exists(Original):
                return {'Saved': 0}
            Source = RiotContainer(Original).Resource(Index).get(0x0311)
            Container = RiotContainer(Path)
            Chunk = Container.Resource(Index).get(0x0311)
            if not Source or not Chunk:
                return {'Error': 'unknown sequence / sequência desconhecida'}
            OriginalData = RiotContainer(Original).ChunkData(Source)
            if OriginalData == Container.ChunkData(Chunk):
                return {'Saved': 0}
            SaveContainerFile(Path, RebuildFromOriginal(Path, self.Game.Root, Container, {Chunk: OriginalData}), self.Game.Root)
            self.Game.ForgetContainer(Path)
        return {'Saved': 1}

    def SaveTemplate(self, Package, Index, Changes):
        """
        PT: Troca slots simples de um template no .odu (ex.: neblina da Sky Properties). Vale para TODAS as fases que
            usam esse template. Backup do original na primeira vez, como sempre.
        EN: Replaces scalar slots of a template in its .odu (e.g. Sky Properties fog); affects every level using it.
        """
        Path = self.Game.PackagePath(Package, '.odu')
        if not Path:
            return {'Error': 'unknown package / pacote desconhecido'}
        with self.Lock:
            Container = RiotContainer(Path)
            Chunk = Container.Resource(Index).get(0x0102)
            if not Chunk:
                return {'Error': 'unknown template / template desconhecido'}
            Template = self.Templates.Get(Package, Index)
            Types = self.Classes.PropertyTypes(Template.ClassId) if Template else None
            try:
                Parsed = {int(Key): int(Value) for Key, Value in Changes.items()}
                for Key in Parsed:
                    if Types and Key < len(Types) and Types[Key] & 0x1000:
                        return {'Error': 'list properties are not editable yet / listas ainda não são editáveis'}
                New = PatchTemplate(Container.ChunkData(Chunk), Parsed)
            except (ValueError, zlib.error) as Error:
                return {'Error': str(Error)}
            Backup = SaveContainerFile(Path, RebuildFromOriginal(Path, self.Game.Root, Container, {Chunk: New}), self.Game.Root)
            self.Game.ForgetContainer(Path)
            self.Templates._Cache.clear()
            self.Cache.clear()
            self.CacheOrder.clear()
            self._OpenLevel = None
        Users = self.Environment.UsageIndex().get((Package << 16) | Index, [])
        return {'Saved': len(Parsed), 'Backup': os.path.relpath(Backup, self.Game.Root), 'UsedBy': Users}

    def RestoreTexture(self, Package, Index):
        """PT: Devolve só esta textura ao original (do backup do .tdu). EN: Puts just this texture back."""
        Path = self.Game.PackagePath(Package, '.tdu')
        Backup = BackupPath(Path, self.Game.Root) if Path else None
        if not Backup or not os.path.exists(Backup):
            return {'Error': 'no backup / sem backup'}
        with self.Lock:
            Original = RiotContainer(Backup).Resource(Index).get(0x0040)
            OriginalData = RiotContainer(Backup).ChunkData(Original) if Original else None
            Container = RiotContainer(Path)
            Chunk = Container.Resource(Index).get(0x0040)
            if not Chunk or OriginalData is None:
                return {'Error': 'unknown texture / textura desconhecida'}
            SaveContainerFile(Path, RebuildContainer(Container, Replace={Chunk: OriginalData}), self.Game.Root)
            self._AfterAssetWrite(Path)
        return {'Restored': True}

    def TextureStatus(self, Package, Index):
        Path = self.Game.PackagePath(Package, '.tdu')
        Backup = BackupPath(Path, self.Game.Root) if Path else None
        if not Backup or not os.path.exists(Backup):
            return {'Changed': False}
        Original = RiotContainer(Backup)
        Chunk = Original.Resource(Index).get(0x0040)
        Current = self.Game.PackageContainer(Package, '.tdu')
        Now = Current.Resource(Index).get(0x0040) if Current else None
        return {'Changed': bool(Chunk and Now and Original.ChunkData(Chunk) != Current.ChunkData(Now))}

    def _AfterAssetWrite(self, Path):
        """PT: Depois de gravar um pacote: esquece caches que dependem dele. EN: Drops caches after a package write."""
        self.Game.ForgetContainer(Path)
        self.Textures._Cache.clear()
        self.Cache.clear()
        self.CacheOrder.clear()
        self.Assets._Packages = None

    def RestoreLevel(self, Key):
        Info = self.LevelInfo(Key)
        if not Info:
            return {'Error': 'unknown level / fase desconhecida'}
        with self.Lock:
            Done = RestoreOriginal(Info['Path'], self.Game.Root)
        self.Forget(Key)
        return {'Restored': Done}

    def FileStatus(self, Key):
        Info = self.LevelInfo(Key)
        if not Info:
            return {'Error': 'unknown level / fase desconhecida'}
        return {'File': Info['File'], 'HasBackup': os.path.exists(BackupPath(Info['Path'], self.Game.Root))}

    def LevelInfo(self, Key):
        for Level in self.LevelList:
            if Level['Key'] == Key:
                return Level
        return None

    def LevelBundle(self, Key):
        """PT: (cena, geometria, texturas) de uma fase, montada uma vez só. EN: Level bundle, built once."""
        with self.Lock:
            if Key in self.Cache:
                return self.Cache[Key]
            Info = self.LevelInfo(Key)
            if not Info:
                return None
            Scene, Geometry, TextureRefs = self.Builder.BuildLevelScene(Info)
            Textures = PackTextures([Texture for Texture in (self.Textures.Get(*Ref) for Ref in TextureRefs) if Texture])
            Bundle = {'Scene': Scene, 'Geometry': Geometry, 'Textures': Textures}
            self.Cache[Key] = Bundle
            self.CacheOrder.append(Key)
            while len(self.CacheOrder) > 2:
                self.Cache.pop(self.CacheOrder.pop(0), None)
            return Bundle


def MakeHandler(Session):
    class RiotHandler(http.server.BaseHTTPRequestHandler):
        server_version = 'RiotServer/' + Version

        def log_message(self, Format, *Args):
            pass

        def SendBytes(self, Body, ContentType, Status=200):
            self.send_response(Status)
            self.send_header('Content-Type', ContentType)
            self.send_header('Content-Length', str(len(Body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(Body)

        def SendJson(self, Value, Status=200):
            self.SendBytes(json.dumps(Value, ensure_ascii=False, separators=(',', ':')).encode('utf-8'), 'application/json; charset=utf-8', Status)

        def do_GET(self):
            try:
                Path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
                if Path.startswith('/api/'):
                    return self.Api(Path[5:])
                return self.Static(Path)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as Error:
                traceback.print_exc()
                try:
                    self.SendJson({'Error': str(Error)}, 500)
                except OSError:
                    pass

        def do_POST(self):
            try:
                Path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
                Length = int(self.headers.get('Content-Length') or 0)
                if Length > 64 * 1024 * 1024:
                    return self.SendJson({'Error': 'too large'}, 413)
                Body = self.rfile.read(Length) if Length else b''
                if self.headers.get('Origin') and urllib.parse.urlparse(self.headers['Origin']).hostname not in ('localhost', '127.0.0.1'):
                    return self.SendJson({'Error': 'forbidden origin'}, 403)
                return self.Post(Path[5:] if Path.startswith('/api/') else Path, Body)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as Error:
                traceback.print_exc()
                try:
                    self.SendJson({'Error': str(Error)}, 500)
                except OSError:
                    pass

        def Post(self, Path, Body):
            """PT: Gravações (só aceitas de localhost). EN: Writes (localhost only)."""
            Name, _Slash, Argument = Path.partition('/')
            if Name == 'SaveStrings':
                try:
                    Package = int(Argument)
                except ValueError:
                    return self.SendJson({'Error': 'bad package / pacote inválido'}, 400)
                Result = Session.SaveStrings(Package, json.loads(Body or b'{}').get('Strings', {}))
                return self.SendJson(Result, 400 if 'Error' in Result else 200)
            if Name == 'SaveTemplate':
                Package, _Slash, Index = Argument.partition('/')
                try:
                    Package, Index = int(Package), int(Index, 0)
                except ValueError:
                    return self.SendJson({'Error': 'bad reference / referência inválida'}, 400)
                Result = Session.SaveTemplate(Package, Index, json.loads(Body or b'{}').get('Properties', {}))
                return self.SendJson(Result, 400 if 'Error' in Result else 200)
            if Name in ('ImportTexture', 'RestoreTexture'):
                Query = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
                Package, _Slash, Index = Argument.partition('/')
                try:
                    Package, Index = int(Package), int(Index, 0)
                except ValueError:
                    return self.SendJson({'Error': 'bad reference / referência inválida'}, 400)
                if Name == 'ImportTexture':
                    Result = Session.ImportTexture(Package, Index, Query, Body)
                else:
                    Result = Session.RestoreTexture(Package, Index)
            elif Name in ('PreviewSequence', 'SaveSequence'):
                Package, _Slash, Index = Argument.partition('/')
                try:
                    Package, Index = int(Package), int(Index, 0)
                except ValueError:
                    return self.SendJson({'Error': 'bad reference / referência inválida'}, 400)
                Raw = json.loads(Body or b'{}')
                Result = (Session.PreviewSequence if Name == 'PreviewSequence' else Session.SaveSequence)(Package, Index, Raw)
            elif Name == 'SetModelMaterial':
                Package, _Slash, Index = Argument.partition('/')
                Request = json.loads(Body or b'{}')
                try:
                    Package, Index = int(Package), int(Index, 0)
                    MaterialPackage, _Sep, MaterialIndex = str(Request['Material']).partition('_')
                    MaterialRef = (int(MaterialPackage) << 16) | int(MaterialIndex, 16)
                except (ValueError, KeyError):
                    return self.SendJson({'Error': 'bad reference / referência inválida'}, 400)
                Result = Session.SetModelMaterial(Package, Index, Request.get('Slot', 0), MaterialRef)
            elif Name == 'RestoreSequence':
                Package, _Slash, Index = Argument.partition('/')
                try:
                    Package, Index = int(Package), int(Index, 0)
                except ValueError:
                    return self.SendJson({'Error': 'bad reference / referência inválida'}, 400)
                Result = Session.RestoreSequence(Package, Index)
            elif Name == 'SaveLevel':
                Request = json.loads(Body or b'{}')
                Result = Session.SaveLevel(Argument, Request.get('Changes', []), Request.get('Added', []), Request.get('Removed', []))
            elif Name == 'RestoreLevel':
                Result = Session.RestoreLevel(Argument)
            else:
                return self.SendJson({'Error': 'unknown action'}, 404)
            return self.SendJson(Result, 400 if 'Error' in Result else 200)

        def Api(self, Path):
            Parts = Path.split('/', 1)
            Name, Argument = Parts[0], (Parts[1] if len(Parts) > 1 else '')
            Game = Session.Game
            if Name == 'Game':
                return self.SendJson({'Game': Game.Game, 'Title': Game.Title, 'Root': Game.Root, 'Version': Version,
                                      'MessageNames': MessageNamesFor(Game.IsTTB),
                                      'Levels': [{Field: Level[Field] for Field in ('Key', 'File', 'Name', 'Folder')} for Level in Session.LevelList]})
            if Name in ('Level', 'LevelGeometry', 'LevelTextures'):
                Bundle = Session.LevelBundle(Argument)
                if not Bundle:
                    return self.SendJson({'Error': 'unknown level / fase desconhecida'}, 404)
                if Name == 'Level':
                    return self.SendJson(Bundle['Scene'])
                if Name == 'LevelGeometry':
                    return self.SendBytes(Bundle['Geometry'], 'application/octet-stream')
                return self.SendBytes(Bundle['Textures'], 'application/octet-stream')
            if Name == 'Instance':
                LevelKey, _Slash, IdText = Argument.rpartition('/')
                try:
                    Details = Session.InstanceDetails(LevelKey, int(IdText))
                except ValueError:
                    Details = None
                if not Details:
                    return self.SendJson({'Error': 'unknown instance / instância desconhecida'}, 404)
                return self.SendJson(Details)
            if Name in ('Materials', 'Material'):
                Parts = Argument.split('/')
                try:
                    Package = int(Parts[0])
                    Index = int(Parts[1], 0) if len(Parts) > 1 else None
                except ValueError:
                    return self.SendJson({'Error': 'bad reference / referência inválida'}, 400)
                with Session.Lock:
                    Result = Session.MaterialCatalog.MaterialList(Package) if Name == 'Materials' else Session.MaterialCatalog.Material(Package, Index)
                if Result is None:
                    return self.SendJson({'Error': 'not a material / não é material'}, 404)
                return self.SendJson(Result)
            if Name == 'StringPackages':
                with Session.Lock:
                    return self.SendJson(Session.Media.StringPackages())
            if Name == 'Strings':
                try:
                    Package = int(Argument)
                except ValueError:
                    return self.SendJson({'Error': 'bad package / pacote inválido'}, 400)
                with Session.Lock:
                    Result = Session.Media.StringList(Package)
                return self.SendJson(Result if Result is not None else {'Error': 'no .xdu / sem .xdu'}, 200 if Result is not None else 404)
            if Name == 'LevelScriptNode':
                LevelKey, _Slash, IdText = Argument.rpartition('/')
                try:
                    Result = Session.LevelScriptNode(LevelKey, int(IdText))
                except ValueError:
                    Result = None
                return self.SendJson(Result if Result else {'Error': 'unknown instance / instância desconhecida'}, 200 if Result else 404)
            if Name == 'LevelScript':
                Result = Session.LevelScript(Argument)     # PT: OpenLevel já trava / EN: OpenLevel takes the lock itself
                if Result is None:
                    return self.SendJson({'Error': 'unknown level / fase desconhecida'}, 404)
                return self.SendJson(Result)
            if Name == 'LevelSequences':
                with Session.Lock:
                    Result = Session.Media.LevelSequences(Argument)
                if Result is None:
                    return self.SendJson({'Error': 'unknown level / fase desconhecida'}, 404)
                return self.SendJson(Result)
            if Name in ('Sounds', 'SoundInfo', 'Sound', 'Sequences', 'Sequence', 'SequenceRaw', 'Videos', 'VideoWmv', 'VideoMp4'):
                return self.MediaApi(Name, Argument)
            if Name in ('Packages', 'Textures', 'Texture', 'Models', 'Model', 'ModelGeometry', 'ModelTextures', 'Animations', 'Animation', 'ModelAnimations'):
                return self.AssetApi(Name, Argument)
            if Name == 'TextureStatus':
                Package, _Slash, Index = Argument.partition('/')
                return self.SendJson(Session.TextureStatus(int(Package), int(Index, 0)))
            if Name == 'FileStatus':
                return self.SendJson(Session.FileStatus(Argument))
            if Name == 'LevelEnvironment':
                Level = Session.OpenLevel(Argument)
                if not Level:
                    return self.SendJson({'Error': 'unknown level / fase desconhecida'}, 404)
                with Session.Lock:
                    return self.SendJson(Session.Environment.LevelEnvironment(Level))
            if Name == 'LevelCells':
                Info = Session.LevelInfo(Argument)
                if not Info:
                    return self.SendJson({'Error': 'unknown level / fase desconhecida'}, 404)
                return self.SendJson(Session.Builder.BuildLevelCells(Info))
            return self.SendJson({'Error': 'unknown endpoint'}, 404)

        def MediaApi(self, Name, Argument):
            Media = Session.Media
            Parts = Argument.split('/')
            try:
                Package = int(Parts[0])
                Index = int(Parts[1], 0) if len(Parts) > 1 and Parts[1] else None
            except ValueError:
                return self.SendJson({'Error': 'bad reference / referência inválida'}, 400)
            if Name in ('Sounds', 'Sequences', 'Videos'):
                with Session.Lock:
                    Result = {'Sounds': Media.SoundList, 'Sequences': Media.SequenceList, 'Videos': Media.VideoList}[Name](Package)
                if Name == 'Videos':
                    return self.SendJson({'Ffmpeg': bool(Media.Ffmpeg), 'Videos': Result})
                return self.SendJson(Result)
            if Index is None:
                return self.SendJson({'Error': 'missing index / falta o índice'}, 400)
            if Name == 'VideoMp4':
                with Session.Lock:
                    Path = Media.VideoMp4(Package, Index)
                if not Path:
                    return self.SendJson({'Error': 'ffmpeg not found or conversion failed / ffmpeg não encontrado ou a conversão falhou'}, 404)
                return self.SendFile(Path, 'video/mp4')
            with Session.Lock:
                if Name == 'SoundInfo':
                    Result = Media.SoundInfo(Package, Index)
                elif Name == 'Sequence':
                    Result = Media.Sequence(Package, Index)
                elif Name == 'SequenceRaw':
                    Result = Media.SequenceRaw(Package, Index)
                elif Name == 'Sound':
                    Body = Media.SoundWav(Package, Index)
                    return self.SendBytes(Body, 'audio/wav') if Body else self.SendJson({'Error': 'unknown sound'}, 404)
                else:
                    Body = Media.VideoWmv(Package, Index)
                    return self.SendBytes(Body, 'video/x-ms-wmv') if Body else self.SendJson({'Error': 'unknown video'}, 404)
            return self.SendJson(Result) if Result else self.SendJson({'Error': 'not found / não encontrado'}, 404)

        def SendFile(self, Path, ContentType):
            """PT: Arquivo com suporte a Range (o <video> do navegador pede pedaços). EN: File with Range support."""
            Size = os.path.getsize(Path)
            Start, End = 0, Size - 1
            Range = self.headers.get('Range')
            if Range and Range.startswith('bytes='):
                First, _Dash, Last = Range[6:].split(',')[0].partition('-')
                if First:
                    Start = int(First)
                    End = int(Last) if Last else Size - 1
                elif Last:
                    Start = max(0, Size - int(Last))
                End = min(End, Size - 1)
            with open(Path, 'rb') as Handle:
                Handle.seek(Start)
                Body = Handle.read(End - Start + 1)
            self.send_response(206 if Range else 200)
            self.send_header('Content-Type', ContentType)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(len(Body)))
            if Range:
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (Start, End, Size))
            self.end_headers()
            self.wfile.write(Body)

        def AssetApi(self, Name, Argument):
            Assets = Session.Assets
            if Name == 'Packages':
                with Session.Lock:
                    return self.SendJson(Assets.Packages())
            Parts = Argument.split('/')
            try:
                Package = int(Parts[0])
                Index = int(Parts[1], 0) if len(Parts) > 1 and Parts[1] else None
            except ValueError:
                return self.SendJson({'Error': 'bad reference / referência inválida'}, 400)
            with Session.Lock:
                if Name == 'Textures':
                    return self.SendJson(Assets.TextureList(Package))
                if Name == 'Models':
                    return self.SendJson(Assets.ModelList(Package))
                if Name == 'Animations':
                    return self.SendJson(Assets.AnimationList(Package))
                if Index is None:
                    return self.SendJson({'Error': 'missing index / falta o índice'}, 400)
                if Name == 'Texture':
                    Body = Assets.TextureBundle(Package, Index)
                    return self.SendBytes(Body, 'application/octet-stream') if Body else self.SendJson({'Error': 'unknown texture'}, 404)
                if Name == 'ModelAnimations':
                    return self.SendJson(Assets.ModelAnimations((Package << 16) | Index))
                if Name == 'Animation':
                    Result = Assets.Animation(Package, Index)
                    return self.SendJson(Result) if Result else self.SendJson({'Error': 'unknown animation'}, 404)
                Bundle = Assets.ModelBundle(Package, Index)
                if not Bundle:
                    return self.SendJson({'Error': 'unknown model / modelo desconhecido'}, 404)
                if Name == 'Model':
                    return self.SendJson(Bundle[0])
                return self.SendBytes(Bundle[1] if Name == 'ModelGeometry' else Bundle[2], 'application/octet-stream')

        def Static(self, Path):
            if Path in ('', '/'):
                Path = '/index.html'
            Full = os.path.normpath(os.path.join(Session.EditorFolder, Path.lstrip('/')))
            if not Full.startswith(os.path.normpath(Session.EditorFolder)) or not os.path.isfile(Full):
                return self.SendBytes(b'Not found', 'text/plain', 404)
            with open(Full, 'rb') as Handle:
                Body = Handle.read()
            self.SendBytes(Body, (mimetypes.guess_type(Full)[0] or 'application/octet-stream'))

    return RiotHandler


class RiotHttpServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # PT: no Windows, SO_REUSEADDR deixaria dois servidores na mesma porta / EN: on Windows it would allow two servers on one port
    allow_reuse_address = os.name != 'nt'


def StartServer(GameRoot, EditorFolder, Port=8650):
    """
    PT: Abre o jogo e inicia o servidor; tenta as 20 portas seguintes se a primeira estiver ocupada.
    EN: Opens the game and starts the server; tries the next 20 ports if the first one is busy.
    """
    Session = RiotSession(GameRoot, EditorFolder)
    Handler = MakeHandler(Session)
    LastError = None
    for Candidate in range(Port, Port + 20):
        try:
            Server = RiotHttpServer(('127.0.0.1', Candidate), Handler)
            return Server, Session, Candidate
        except OSError as Error:
            LastError = Error
    raise LastError
