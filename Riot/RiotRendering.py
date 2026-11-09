"""
RiotRendering — prepara a fase para o visor 3D / prepares a level for the 3D viewport
=====================================================================================

PT-BR
-----
Junta tudo o que o editor precisa para desenhar uma fase, lendo direto dos arquivos do jogo:

    instância (.lvl 0x0020) -> template (.odu) -> modelo (.mdu) -> material (.odu) -> textura (.tdu)
    + terreno (.lvl 0x0001) + luz pré-calculada (_level.ldu) + Point Lights + salas/portais (0x0026/0x0027)

Saída de BuildLevelScene:
    Scene (dicionário, vira JSON):
        Models     {código: [grupo]}; grupo = {n, po, no, uo, vo, tex, mask, b}
                   n = cantos; po/no/uo/vo = posições no bloco binário (posições f32×3, normais i8×4,
                   UV f32×2, vértice original f32) ou -1; tex = código da textura; mask = alpha não é
                   transparência; b = modo de mistura
        Instances  [código do modelo, posição, rotação (graus), escala, classe, offset da luz pré-calculada]
        Lights     [[x, y, z, r, g, b, intensidade]]
        Textures   lista de códigos de textura usados
        Start      posição do jogador (classe Player)
        Stats      contagens
    Geometry (bytes): o bloco binário apontado pelos offsets (inclui as cores pré-calculadas RGBA).
Só entram instâncias com o bit 1 das flags (visíveis no jogo, FUN_0045A5C0).

EN
--
Builds everything the editor needs to draw a level straight from the game files (chain above). Returns a
JSON-able Scene plus one binary Geometry block (positions f32×3, normals i8×4, UV f32×2, original vertex f32,
baked RGBA colours). Only instances with flag bit 1 (visible in game) are included.
"""
import array
import math
import struct
import sys

from .RiotWaveforms import RiotWaveformStore
from .RiotLevel import InstanceProperties, RiotLevel
from .RiotEffects import RiotEffectBuilder
from .RiotLighting import LightEffects, PointLights, RiotBakedLight, WorldLights
from .RiotPackages import RefName

LittleEndian = sys.byteorder == 'little'
LevelPropertiesId = 0xBFD00933
EffectClasses = {'Particle Fountain', 'Particle System - Simple', 'Particle System - Complex', 'Particle System - Group', 'Object Generator', 'Billboard', 'Billboard Light Cone', 'Fire'}


def ShadowCode(Instance, Template):
    """
    PT: Sombra dinâmica como em lvl_ReadInstance (0x45A5C0): bit 1 = projeta sombra; 2 = a instância sobrescreve
        (flag 0x1000, valor no bit 0x400); 4 = valor do template (flags do template, bit 0).
    EN: Dynamic shadow as decided by lvl_ReadInstance: 1 = casts, 2 = instance override (0x1000/0x400), 4 = template value.
    """
    FromTemplate = bool(Template and Template.Flags & 1)
    if Instance['Flags'] & 0x1000:
        return 2 | (1 if Instance['Flags'] & 0x400 else 0) | (4 if FromTemplate else 0)
    return (1 | 4) if FromTemplate else 0


def _Pack(TypeCode, Values):
    Data = array.array(TypeCode, Values)
    if not LittleEndian:
        Data.byteswap()
    return Data.tobytes()


class RiotSceneBuilder:
    """PT: Monta cenas de fase usando os stores compartilhados. EN: Builds level scenes using shared stores."""

    def __init__(self, Game, Classes, Templates, Models, Textures, Materials):
        self.Game = Game
        self.Classes = Classes
        self.Templates = Templates
        self.Models = Models
        self.Textures = Textures
        self.Materials = Materials
        self.Waveforms = RiotWaveformStore(Game)
        self.Baked = RiotBakedLight(Game)
        self.Effects = RiotEffectBuilder(Game, Classes, Templates, Textures, Materials)
        self.UseSplat = True   # PT: terreno com mistura de texturas como no jogo / EN: game-style blended terrain
        self.SystemPackage = next((Id for Id, Name in Game.PackageNames.items() if Name.lower() == 'system'), 2)

    # ------------------------------------------------------------------ modelo -> grupos
    def _ModelGroups(self, Model, Buffer, TextureRefs):
        Groups = {}
        Positions, Normals, FaceUVs = Model.Positions, Model.Normals, Model.FaceUVs
        for FaceNumber, (Material, Corners) in enumerate(Model.Faces):
            if len(Corners) != 3:
                continue
            Group = Groups.get(Material)
            if Group is None:
                Group = Groups[Material] = {'p': [], 'n': [], 'uv': [], 'vi': []}
            UV = FaceUVs[FaceNumber] if FaceUVs else None
            for CornerNumber, Vertex in enumerate(Corners):
                if Vertex >= len(Positions):
                    break
                Group['vi'].append(Vertex)
                Group['p'].extend(Positions[Vertex])
                Normal = Normals[Vertex]
                Group['n'].extend((int(round(Normal[0] * 127)), int(round(Normal[1] * 127)), int(round(Normal[2] * 127)), 0))
                if UV:
                    Group['uv'].extend((UV[2 * CornerNumber], UV[2 * CornerNumber + 1]))
        Result = []
        for Material, Group in Groups.items():
            Info = {'tex': None, 'mask': False, 'b': None}
            if Material < len(Model.Materials):
                Ref = Model.Materials[Material]
                Package, Index = Ref >> 16, Ref & 0xFFFF
                Texture = self.Materials.Texture(Package, Index)
                if Texture and self.Textures.Get(*Texture):
                    Info['tex'] = RefName(*Texture)
                    TextureRefs.add(Texture)
                Info['b'] = self.Materials.Blend(Package, Index)
                Info['mask'] = self.Materials.AlphaIsMask(Package, Index)
                Tint = self.Materials.Tint(Package, Index)
                if Tint is not None:
                    Info['tint'] = '#%06x' % Tint
                self._Animate(Info, Package, Index, TextureRefs)
            Result.append(self._Emit(Group, Buffer, Info))
        return Result

    SplatAlpha = (0.0, 0.8, 0.9, 0.95, 1.0, 1.0, 1.0, 1.0)   # PT: tabela de FUN_004A4A80 / EN: table from FUN_004A4A80

    def _SplatGroups(self, Layer, TextureRefs):
        """
        PT: Terreno como o jogo desenha: textura base (atlas pré-renderizado da fase) e, por cima, uma passada por
            material com alfa por vértice (bytes do splat) e textura projetada de cima.
        EN: Terrain the way the game draws it: base atlas texture plus one alpha-blended pass per material.
        """
        Splat = Layer['Splat']
        Width, Heights = Layer['Width'], Layer['Heights']
        Up = -1 if Layer['Type'] == 1 else 1
        X0, X1, Y0, Y1 = Splat['Rect']
        Size = float(Splat['Size'])

        def Point(Row, Column):
            return (Layer['OriginX'] + Column, Heights[Row * (Width + 1) + Column] / 2048.0, Layer['OriginZ'] + Row)

        def Corners(Row, Column, Flags):
            Names = {'a': (Row, Column), 'b': (Row, Column + 1), 'c': (Row + 1, Column), 'd': (Row + 1, Column + 1)}
            Order = (('a', 'c', 'b'), ('b', 'c', 'd')) if not Flags & 1 else (('a', 'c', 'd'), ('a', 'd', 'b'))
            return [[Names[Name] for Name in Triangle] for Triangle in Order]

        def Normal(Triangle):
            P0, P1, P2 = (Point(*Vertex) for Vertex in Triangle)
            E1 = (P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2])
            E2 = (P2[0] - P0[0], P2[1] - P0[1], P2[2] - P0[2])
            N = (E1[1] * E2[2] - E1[2] * E2[1], E1[2] * E2[0] - E1[0] * E2[2], E1[0] * E2[1] - E1[1] * E2[0])
            Length = math.sqrt(N[0] * N[0] + N[1] * N[1] + N[2] * N[2]) or 1.0
            N = (N[0] / Length, N[1] / Length, N[2] / Length)
            if N[1] * Up < 0:
                N = (-N[0], -N[1], -N[2])
            return (int(round(N[0] * 127)), int(round(N[1] * 127)), int(round(N[2] * 127)), 0)

        Faces = Layer['Faces']
        Visible = [Number for Number, Face in enumerate(Faces) if Face[1] > 0 and not Face[0] & 0x30]
        Result = []
        # PT: passada base / EN: base pass
        BaseRef = Splat['BaseTexture']
        Base = {'p': [], 'n': [], 'uv': []}
        for Number in Visible:
            Row, Column = divmod(Number, Width)
            for Triangle in Corners(Row, Column, Faces[Number][0]):
                Packed = Normal(Triangle)
                for VertexRow, VertexColumn in Triangle:
                    Base['p'].extend(Point(VertexRow, VertexColumn))
                    Base['n'].extend(Packed)
                    Base['uv'].extend(((X0 + 0.5 + VertexColumn * (X1 - X0) / Width) / Size,
                                       (Y0 + 0.5 + VertexRow * (Y1 - Y0) / max(1, Layer['Height'])) / Size))
        Info = {'tex': None, 'mask': True, 'b': None, 'order': 0}
        if self.Textures.Get(BaseRef >> 16, BaseRef & 0xFFFF):
            Info['tex'] = RefName(BaseRef >> 16, BaseRef & 0xFFFF)
            TextureRefs.add((BaseRef >> 16, BaseRef & 0xFFFF))
        Result.append((Base, Info))
        # PT: uma passada por material de cada pedaço / EN: one pass per material of each chunk
        Order = 1
        VisibleSet = set(Visible)
        for Chunk in Splat['Chunks']:
            GridX, GridY = Chunk['GridX'], Chunk['GridY']
            for Number, MaterialRef in enumerate(Chunk['Materials']):
                Package, Index = MaterialRef >> 16, MaterialRef & 0xFFFF
                Template = self.Templates.Get(Package, Index)
                Tile = max(1, Template.Slot(4)) if Template else 2
                Fade = Template.SlotFloat(7) if Template else 0.0
                Texture = self.Materials.Texture(Package, Index)

                def Byte(Row, Column):
                    Offset = (GridY * Number + Row - Chunk['Z0']) * GridX + Column - Chunk['X0']
                    return Chunk['Grid'][Offset] if 0 <= Offset < len(Chunk['Grid']) else 0
                Group = {'p': [], 'n': [], 'uv': [], 'a': []}
                for Row in range(Chunk['Z0'], Chunk['Z1']):
                    for Column in range(Chunk['X0'], Chunk['X1']):
                        Face = Row * Width + Column
                        if Face not in VisibleSet:
                            continue
                        if not (Byte(Row, Column) & 0x10 or Faces[Face][1] == MaterialRef):
                            continue
                        for Triangle in Corners(Row, Column, Faces[Face][0]):
                            Packed = Normal(Triangle)
                            for VertexRow, VertexColumn in Triangle:
                                P = Point(VertexRow, VertexColumn)
                                Group['p'].extend(P)
                                Group['n'].extend(Packed)
                                Group['uv'].extend((P[0] / Tile, P[2] / Tile))
                                Group['a'].append(int(round(self.SplatAlpha[Byte(VertexRow, VertexColumn) & 7] * 255)))
                if not Group['p'] or not any(Group['a']):
                    continue
                Info = {'tex': None, 'mask': True, 'b': 'splat', 'order': Order, 'fade': round(Fade, 3)}
                Order += 1
                if Texture and self.Textures.Get(*Texture):
                    Info['tex'] = RefName(*Texture)
                    TextureRefs.add(Texture)
                Result.append((Group, Info))
        return Result

    def _Animate(self, Info, Package, Index, TextureRefs):
        """
        PT: Anota a animação do material no grupo ('an') e garante as texturas dos quadros e a curva de rolagem.
        EN: Records the material animation on the group and pulls in its frame textures and scroll waveform.
        """
        if not Info.get('tex'):
            return
        Animation = self.Materials.Animation(Package, Index, self.Waveforms)
        if not Animation:
            return
        if 'fr' in Animation:
            Refs = [(int(Code.split('_')[0]), int(Code.split('_')[1], 16)) for Code in Animation['fr']]
            Refs = [Ref for Ref in Refs if self.Textures.Get(*Ref)]
            if len(Refs) < 2:
                return
            Animation['fr'] = [RefName(*Ref) for Ref in Refs]
            TextureRefs.update(Refs)
        if 'sc' in Animation:
            Package_, Index_ = Animation['sc'].split('_')
            Wave = self.Waveforms.Get(int(Package_), int(Index_, 16))
            self._Waves[Animation['sc']] = [round(Wave[0], 5), Wave[1], [round(Value, 5) for Value in Wave[2]], round(Wave[3], 5)]
        Info['an'] = Animation

    def _MarkerGroups(self, Buffer):
        """PT: octaedro de 0,1 m (marcador de efeito; o editor põe um ícone por cima). EN: 0.1 m octahedron (effect marker; the editor adds an icon)."""
        R = 0.1
        Points = [(R, 0, 0), (-R, 0, 0), (0, R, 0), (0, -R, 0), (0, 0, R), (0, 0, -R)]
        Faces = [(0, 2, 4), (4, 2, 1), (1, 2, 5), (5, 2, 0), (4, 3, 0), (1, 3, 4), (5, 3, 1), (0, 3, 5)]
        Group = {'p': [], 'n': [], 'uv': [], 'vi': []}
        for Face in Faces:
            for Vertex in Face:
                Group['vi'].append(Vertex)
                Group['p'].extend(Points[Vertex])
                Group['n'].extend(int(round(Value / R * 127)) for Value in Points[Vertex])
                Group['n'].append(0)
        return [self._Emit(Group, Buffer, {'tex': None, 'mask': False, 'b': None, 'fx': 1})]

    @staticmethod
    def _Emit(Group, Buffer, Info):
        Count = len(Group['p']) // 3
        Record = {'n': Count, 'po': len(Buffer)}
        Buffer += _Pack('f', Group['p'])
        Record['no'] = len(Buffer)
        Buffer += _Pack('b', [max(-127, min(127, Value)) for Value in Group['n']])
        Record['uo'] = -1
        if len(Group['uv']) == 2 * Count:
            Record['uo'] = len(Buffer)
            Buffer += _Pack('f', Group['uv'])
        Record['vo'] = -1
        if len(Group.get('vi', ())) == Count:
            Record['vo'] = len(Buffer)
            Buffer += _Pack('f', Group['vi'])
        Record['ao'] = -1
        if len(Group.get('a', ())) == Count:
            Record['ao'] = len(Buffer)
            Buffer += bytes(Group['a'])
            while len(Buffer) % 4:
                Buffer += b'\0'

        Record.update(Info)
        return Record

    # ------------------------------------------------------------------ terreno
    def _TerrainGroups(self, Level, Buffer, TextureRefs):
        Groups = {}
        SplatLayers = []
        for Layer in Level.TerrainLayers():
            if Layer.get('Splat') and self.UseSplat:
                SplatLayers.append(Layer)
                continue
            Width, Heights = Layer['Width'], Layer['Heights']
            Up = -1 if Layer['Type'] == 1 else 1

            def Point(Row, Column):
                return (Layer['OriginX'] + Column, Heights[Row * (Width + 1) + Column] / 2048.0, Layer['OriginZ'] + Row)
            for FaceNumber, Face in enumerate(Layer['Faces']):
                Flags, Ref, UC, UD, UB, UA, VC, VD, VB, VA = Face
                if Ref <= 0 or Flags & 0x30:
                    continue
                Row, Column = divmod(FaceNumber, Width)
                Corners = {'a': Point(Row, Column), 'b': Point(Row, Column + 1), 'c': Point(Row + 1, Column), 'd': Point(Row + 1, Column + 1)}
                UVs = {'a': (UA / 65535, VA / 65535), 'b': (UB / 65535, VB / 65535), 'c': (UC / 65535, VC / 65535), 'd': (UD / 65535, VD / 65535)}
                Triangles = (('a', 'c', 'b'), ('b', 'c', 'd')) if not Flags & 1 else (('a', 'c', 'd'), ('a', 'd', 'b'))
                Group = Groups.get(Ref)
                if Group is None:
                    Group = Groups[Ref] = {'p': [], 'n': [], 'uv': []}
                for Triangle in Triangles:
                    P0, P1, P2 = (Corners[Name] for Name in Triangle)
                    E1 = (P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2])
                    E2 = (P2[0] - P0[0], P2[1] - P0[1], P2[2] - P0[2])
                    N = (E1[1] * E2[2] - E1[2] * E2[1], E1[2] * E2[0] - E1[0] * E2[2], E1[0] * E2[1] - E1[1] * E2[0])
                    Length = math.sqrt(N[0] * N[0] + N[1] * N[1] + N[2] * N[2]) or 1.0
                    N = (N[0] / Length, N[1] / Length, N[2] / Length)
                    if N[1] * Up < 0:
                        N = (-N[0], -N[1], -N[2])
                    Packed = (int(round(N[0] * 127)), int(round(N[1] * 127)), int(round(N[2] * 127)), 0)
                    for Name in Triangle:
                        Group['p'].extend(Corners[Name])
                        Group['uv'].extend(UVs[Name])
                        Group['n'].extend(Packed)
        Result = []
        Next = 0
        for Ref, Group in Groups.items():
            Count = len(Group['p']) // 3
            Group['vi'] = list(range(Next, Next + Count))
            Next += Count
            Package, Index = Ref >> 16, Ref & 0xFFFF
            Info = {'tex': None, 'mask': True, 'b': None}
            Texture = self.Materials.Texture(Package, Index)
            if Texture and self.Textures.Get(*Texture):
                Info['tex'] = RefName(*Texture)
                TextureRefs.add(Texture)
                self._Animate(Info, Package, Index, TextureRefs)
            Result.append(self._Emit(Group, Buffer, Info))
        # PT: junta as passadas iguais de todas as camadas (mesma textura, ordem e distância) / EN: merge equal passes
        Merged = {}
        for Layer in SplatLayers:
            for Group, Info in self._SplatGroups(Layer, TextureRefs):
                Key = (Info['tex'], Info['b'], Info['order'], Info.get('fade'))
                if Key not in Merged:
                    Merged[Key] = ({Name: [] for Name in Group}, Info)
                for Name, Values in Group.items():
                    Merged[Key][0][Name].extend(Values)
        for Key in sorted(Merged, key=lambda Item: (Item[2], str(Item[0]))):
            Group, Info = Merged[Key]
            Count = len(Group['p']) // 3
            Group['vi'] = list(range(Next, Next + Count))
            Next += Count
            Result.append(self._Emit(Group, Buffer, Info))
        return Result

    # ------------------------------------------------------------------ fase inteira
    def BuildLevelScene(self, LevelInfo):
        Game = self.Game
        Level = RiotLevel(LevelInfo['Path'], Game.IsTTB)
        Scale = Game.PositionScale
        Buffer = bytearray()
        Lit = bytearray()
        ModelGroups = {}
        self._Waves = {}
        TextureRefs = set()
        Instances = []
        # PT: todas entram; as escondidas no início (sem 0x1) vão marcadas — uma cena STOMP pode mostrá-las
        # EN: every instance goes in; hidden-at-start ones (no 0x1) are flagged, a STOMP scene may show them
        Visible = Level.Instances
        for Instance in Visible:
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            ModelRef = Template.ModelRef if Template else 0
            # PT: bloco 0x8000 = modelo próprio da instância (a arquitetura da TTB é montada assim)
            # EN: 0x8000 block = the instance's own model (how TTB architecture is placed)
            Own = Instance['OwnModel']
            if Own and Own['ModelRef'] and self.Models.Exists(Own['ModelRef'] >> 16, Own['ModelRef'] & 0xFFFF):
                ModelRef = Own['ModelRef']
            ClassName = self.Classes.Name(Template.ClassId) if Template else '?'
            if not ModelRef and ClassName in EffectClasses:
                # PT: efeito sem modelo: ganha um marcador pequeno para dar para selecionar e editar
                # EN: model-less effect: gets a small marker so it can be selected and edited
                Key = 'fxmarker'
                if Key not in ModelGroups:
                    ModelGroups[Key] = (self._MarkerGroups(Buffer), 6)
            elif not ModelRef:
                continue
            else:
                Package, Index = ModelRef >> 16, ModelRef & 0xFFFF
                Key = RefName(Package, Index)
            if Key not in ModelGroups:
                Model = self.Models.Get(Package, Index)
                ModelGroups[Key] = (self._ModelGroups(Model, Buffer, TextureRefs), len(Model.Positions)) if Model else None
            if not ModelGroups[Key] or not ModelGroups[Key][0]:
                continue
            LitOffset = -1
            Baked = self.Baked.Colors(Instance['Tail'])
            if Baked and Baked[0] == ModelRef and Baked[1] == ModelGroups[Key][1]:
                LitOffset = len(Lit) // 4
                Colors = bytearray(Baked[2])
                Colors[0::4], Colors[2::4] = Baked[2][2::4], Baked[2][0::4]      # BGRA -> RGBA
                Lit += Colors
            Position = [round(Value / Scale, 6) for Value in Instance['Position']]
            Instances.append([Key, Position, list(Instance['Rotation']), [round(Value, 5) for Value in Instance['Scale']], ClassName, LitOffset, Instance['Id'],
                              -1, ShadowCode(Instance, Template), 1 if Instance['Flags'] & 8 else 0, 0 if Instance['Flags'] & 1 else 1])
        TerrainGroups = self._TerrainGroups(Level, Buffer, TextureRefs)
        Models = {Key: Value[0] for Key, Value in ModelGroups.items() if Value and Value[0]}
        if TerrainGroups:
            Models['terrain'] = TerrainGroups
            Instances.append(['terrain', [0, 0, 0], [0, 90, 0], [1, 1, 1], 'Terrain (layers)', -1, 0, -1, 0, 0, 0])
        while len(Buffer) % 4:
            Buffer += b'\0'
        LitBlock = {'o': len(Buffer), 'n': len(Lit) // 4}
        Buffer += Lit
        Lights = PointLights(Level.Instances, self.Templates, Game.IsTTB, Scale)
        # PT: emissores de partículas (RiotEffects) / EN: particle emitters
        try:
            Effects = self.Effects.Build(Level.Instances, {Row[6]: Number for Number, Row in enumerate(Instances)}, TextureRefs)
        except Exception:   # PT: efeito nunca derruba a fase / EN: effects never break the level
            import traceback
            traceback.print_exc()
            Effects = []
        try:
            Fires = self.Effects.Fires(Level.Instances, {Row[6]: Number for Number, Row in enumerate(Instances)})
        except Exception:
            import traceback
            traceback.print_exc()
            Fires = []
        World = WorldLights(Level.Instances, self.Templates, Scale)
        try:
            LightFx, LightWaves = LightEffects(Level.Instances, self.Templates, self.Waveforms, Game.IsTTB)
            self._Waves.update(LightWaves)
        except Exception:   # PT: nunca derruba a fase / EN: never breaks the level
            import traceback
            traceback.print_exc()
            LightFx = []
        # PT: camadas do céu (Sky / Sun): p0 = visível, p6 = 1 marca a cúpula (o centro); o editor as desenha em volta da câmera
        # EN: sky layers (Sky / Sun): p0 shown, p6 = 1 marks the dome (the centre); drawn around the camera
        Sky = []
        for Instance in Level.Instances:
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            if Template and self.Classes.Name(Template.ClassId) == 'Sky / Sun':
                Values = InstanceProperties(Template, Instance)
                Sky.append({'Id': Instance['Id'], 'Dome': Values.get(6, 0) == 1, 'Shown': Values.get(0, 1) != 0})
        ShadowFade = None
        for Instance in Level.Instances:
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            if Template and Template.ClassId == LevelPropertiesId and not Game.IsTTB:
                # PT: p14 / p15 = início e fim do fade das sombras (TS1; no TTB os índices ainda não foram achados)
                # EN: p14 / p15 = shadow fade start and end (TS1; TTB indexes not found yet)
                Values = InstanceProperties(Template, Instance)
                if 0 < Values.get(14, 0) < Values.get(15, 0) < 10000:
                    ShadowFade = [Values[14], Values[15]]
                break
        Start = None
        for Instance in Level.Instances:
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            if Template and self.Classes.Name(Template.ClassId) == 'Player':
                Start = [Value / Scale for Value in Instance['Position']]
                break
        Scene = {
            'Game': Game.Game, 'Key': LevelInfo['Key'], 'File': LevelInfo['File'], 'Name': LevelInfo['Name'],
            'Models': Models, 'Instances': Instances, 'Lit': LitBlock, 'Lights': Lights, 'Start': Start,
            'SystemPackage': self.SystemPackage, 'ShadowFade': ShadowFade, 'Waves': self._Waves, 'WorldLights': World, 'Sky': Sky, 'Effects': Effects, 'Fires': Fires, 'LightEffects': LightFx,
            'Textures': sorted(RefName(*Ref) for Ref in TextureRefs),
            'Stats': {'Records': len(Level.Instances), 'Complete': Level.InstancesComplete, 'Placed': len(Instances) - (1 if TerrainGroups else 0),
                      'Models': len(Models) - (1 if TerrainGroups else 0), 'TerrainTriangles': sum(Group['n'] for Group in TerrainGroups) // 3,
                      'Lights': len(Lights), 'Effects': len(Effects)},
        }
        return Scene, bytes(Buffer), sorted(TextureRefs)

    # ------------------------------------------------------------------ salas e portais
    def BuildLevelCells(self, LevelInfo):
        """
        PT: Salas (nós com nome), células com portais e PVS, em coordenadas do mundo.
        EN: Rooms (named nodes), cells with portals and PVS, in world coordinates.
        """
        Game = self.Game
        Level = RiotLevel(LevelInfo['Path'], Game.IsTTB)
        CellTree = Level.Cells()
        if not CellTree:
            return {'Nodes': {}, 'Cells': []}
        _Header, Nodes, _Objects = CellTree
        Cells = Level.Portals()
        ById = {Instance['Id']: Instance for Instance in Level.Instances}
        Scale = Game.PositionScale

        def World(Values):
            return [round(Value / Scale, 2) for Value in Values]
        Keep = {Number for Number, Node in enumerate(Nodes) if Node['Kind'] == 1} | {Cell['Node'] for Cell in Cells}
        Result = {'Nodes': {}, 'Cells': []}
        for Number in sorted(Keep):
            if Number >= len(Nodes):
                continue
            Node = Nodes[Number]
            Result['Nodes'][Number] = {'n': Node['Name'], 'k': Node['Kind'], 'p': Node['Parent'], 'mx': World(Node['Max']), 'mn': World(Node['Min'])}
        for Cell in Cells:
            Points = []
            for Portal in Cell['Portals']:
                Instance = ById.get(Portal['Instance'])
                Points.append(World(Instance['Position']) + [Portal['Target']] if Instance else [None, None, None, Portal['Target']])
            Result['Cells'].append({'node': Cell['Node'], 'pt': Points, 'vis': Cell['Visible']})
        return Result
