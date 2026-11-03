"""
RiotEffects — emissores de partículas da fase / the level's particle emitters
=============================================================================

PT-BR
-----
Transforma as instâncias de efeito da fase numa lista de emissores com parâmetros normalizados (metros, segundos,
cores em gama 0..1), que o editor simula no navegador (Editor/RiotParticles.js). O código é nosso; os significados
das propriedades vêm de fatos de engenharia reversa (TS1: documentados no projeto the-suffering-engine e conferidos
nos valores; TTB: deduzidos do Suffering.rfl da TTB — FUN_019aca80 / FUN_019a5440 / FUN_019ad0b0 — e das
estatísticas dos valores, por isso marcados como "deduzido").

    TS1 Particle Fountain
        p0 = 1 nasce dentro da caixa do modelo; p1 velocidade no eixo principal (m/s × 0,5..1); p3 raio do disco;
        p5 velocidade radial; p8 ângulo do disco (graus); p10 duração da emissão (0 = sem fim); p14 ligado no
        início; p22/p23/p24 eixos (0 x, 1 y, 2 z da matriz: principal, u, v); p26 partículas por segundo;
        p29/p30 distâncias de LOD; p33/p34 cor inicial/final; p36 texturas; p37..p38 tamanho ao nascer
        (unidades do motor / 2048, metade da largura); p39 crescimento por segundo; p40 vida; p41 fade-out;
        p42 fade-in; p43 fator da gravidade da fase; p46/p47 mistura (1 ou p47 ≠ 0 soma, 2 subtração,
        3 cor × luz, senão alpha); p48 = 1 vida aleatória 0..p40 e rastro alinhado à velocidade; p49 giro (graus/s).
    TS1 Object Generator (só os que soltam Particle Fountain)
        p0 templates; p7 ± p8 segundos entre disparos; p21 tempo ligado; p24 ligado desde a criação.
    TTB Billboard Light Cone (classe do motor 0x6375DE85, SufferingTTB.exe: setup 0x4B0C90, geometria 0x4B60E0,
    cores 0x4B56A0, desenho 0x4B5990 — conferido no código)
        p0 eixo (p0 % 3: 0 x, 1 y, 2 z da matriz; p0 <= 2 aponta para o lado negativo); p1 comprimento;
        p2 → p3 raio no começo → no fim (mínimo 0,025); p5 textura; p6 modo de mistura (tabela dos materiais da TTB);
        p7 cor; p8 opacidade; p9 expoente do sumiço (alfa = (1 − t^p9) × p8; p9 = 0 = sem sumiço).
        O cone é uma fila de billboards no eixo, espaçados 2/3 do raio local; cada um tem meia largura = raio.
        Perto da câmera (profundidade − 0,15625 < 0,75 × raio) o alfa cai na proporção. p4 e p10 não são usados aqui.
    TS1/TTB Billboard
        p0 texturas; p2..p3 tamanho; p9 distância de sumiço (deduzido).
    TTB Particle System - Simple (deduzido)
        p0 duração da emissão; p2 ligado no início; p9 partículas por segundo; p10 abertura do cone (graus);
        p18/p19 distâncias de LOD; p31 + p32 vida; p33 → p34 tamanho inicial → final; p35 ± p36 velocidade;
        p38 texturas; p39 cor; p40 mistura (1 soma, 2 subtração, 3 cor × luz, 0 alpha); p46 gravidade;
        p48/p49 rotação inicial; p50/p51 giro; p56/p57 fade-in/fade-out (fração da vida);
        p58 liga o flipbook, p60 grade (0..4 → 1, 4, 16, 64, 256 quadros), p61 quadros, p59 fps, p62 primeiro quadro;
        p67 = 1 liga a escala aleatória p68..p69.

EN
--
Turns the level's effect instances into emitters with normalised parameters (metres, seconds, gamma colours) that
the editor simulates in the browser. Our own code; property meanings are reverse-engineering facts (TS1: as
documented by the-suffering-engine project and checked against the values; TTB: inferred from the TTB .rfl setup /
start / update functions and the value statistics, hence marked "inferred"). See the table above.
"""
import struct

from .RiotLevel import InstanceProperties
from .RiotPackages import RefName

ClassLevelProperties = 0xBFD00933


def _Float(Value, Default=0.0):
    Result = struct.unpack('<f', struct.pack('<I', Value & 0xFFFFFFFF))[0]
    return Result if Result == Result and abs(Result) < 1e7 else Default


def _Rgb(Value):
    return [round(((Value >> Shift) & 255) / 255.0, 4) for Shift in (16, 8, 0)]


def _Array(Template, Instance, Index):
    """PT: Itens de uma propriedade-array (sobrescrita pela instância ou do template). EN: Array property items."""
    Words = Template.Slots
    Header = Template.Slot(Index)
    if Instance is not None and Index in Instance['PropertyIndexes']:
        Position = Instance['PropertyIndexes'].index(Index)
        if Position < len(Instance['Values']):
            Words, Header = Instance['Values'], Instance['Values'][Position]
    Offset, Count = Header & 0xFFFF, Header >> 16
    if 0 < Count and Offset + Count <= len(Words):
        return Words[Offset:Offset + Count]
    return []


def _Round(Value):
    if isinstance(Value, float):
        return round(Value, 4)
    if isinstance(Value, list):
        return [_Round(Item) for Item in Value]
    if isinstance(Value, dict):
        return {Key: _Round(Item) for Key, Item in Value.items()}
    return Value


class RiotEffectBuilder:
    """PT: Monta Scene['Effects'] de uma fase. EN: Builds a level's Scene['Effects']."""

    def __init__(self, Game, Classes, Templates, Textures, Materials):
        self.Game = Game
        self.Classes = Classes
        self.Templates = Templates
        self.Textures = Textures
        self.Materials = Materials

    def _TextureList(self, Refs, TextureRefs):
        Result = []
        for Ref in Refs:
            Package, Index = Ref >> 16, Ref & 0xFFFF
            if not Package:
                continue
            Found = (Package, Index) if self.Textures.Exists(Package, Index) else self.Materials.Texture(Package, Index)
            if Found:
                TextureRefs.add(Found)
                Result.append(RefName(*Found))
        return Result

    def _Gravity(self, Instances):
        """PT: gravidade da fase em m/s² (TS1: Level Properties p19 × p18 / 2048). EN: level gravity in m/s²."""
        if self.Game.IsTTB:
            return 9.8
        for Instance in Instances:
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            if Template and Template.ClassId == ClassLevelProperties:
                Values = InstanceProperties(Template, Instance)
                Gravity = _Float(Values.get(19, 0), 9.8) * _Float(Values.get(18, 0), 2175.0) / 2048.0
                if 0 < Gravity < 100:
                    return Gravity
        return 9.8 * 2175.0 / 2048.0

    # ------------------------------------------------------------------ TS1 Particle Fountain
    def _Fountain(self, Template, Instance, Gravity, TextureRefs, Scale=1.0):
        V = InstanceProperties(Template, Instance) if Instance is not None else dict(enumerate(Template.Slots))
        F = lambda Index, Default=0.0: _Float(V.get(Index, 0), Default) if Index in V else Default
        I = lambda Index, Default=0: V.get(Index, Default)
        Textures = self._TextureList(_Array(Template, Instance, 36), TextureRefs)
        if not Textures:
            return None
        Blend = 1 if (I(46) == 1 or I(47) != 0) else 2 if I(46) == 2 else 0
        Life = max(0.0, F(40, 1.0))
        Streak = I(48) == 1
        Size0, Size1 = F(37, 600.0), F(38, 0.0)
        Size1 = max(Size0, Size1)
        Near = F(29, 50.0)
        return {
            'Kind': 'Fountain', 'Tex': Textures, 'Blend': Blend, 'Lit': I(46) == 3,
            'Rate': max(0, I(26)) if I(26) < 100000 else 0, 'Duration': max(0.0, F(10)), 'On': I(14) != 0,
            'Box': I(0) != 0, 'Axes': [min(2, max(0, I(22, 1))), min(2, max(0, I(23, 0))), min(2, max(0, I(24, 2)))],
            'Speed': [F(1) * 0.5, F(1)], 'Radius': max(0.0, F(3)), 'Radial': F(5), 'Disc': F(8, 360.0), 'Cone': 0,
            'Life': [0.0 if Streak else Life, Life], 'FadeIn': max(0.0, F(42)), 'FadeOut': max(0.0, F(41)), 'FadeFraction': False,
            'Size': [Size0 / 2048.0 * Scale, Size1 / 2048.0 * Scale], 'Grow': F(39) / 2048.0 * Scale, 'EndSize': None,
            'Color0': _Rgb(I(33)), 'Color1': _Rgb(I(34)), 'Gravity': round(Gravity * F(43), 4),
            'Rot0': [0, 360] if F(49) else [0, 0], 'Spin': [abs(F(49)), abs(F(49))], 'SpinSign': True,
            'Streak': Streak, 'Lod': [Near, max(Near + 0.01, F(30, 50.0))], 'Flip': None, 'Inferred': False,
        }

    # ------------------------------------------------------------------ TTB Particle System - Simple (deduzido / inferred)
    def _Simple(self, Template, Instance, TextureRefs):
        V = InstanceProperties(Template, Instance)
        F = lambda Index, Default=0.0: _Float(V.get(Index, 0), Default) if Index in V else Default
        I = lambda Index, Default=0: V.get(Index, Default)
        Textures = self._TextureList(_Array(Template, Instance, 38), TextureRefs)
        if not Textures:
            return None
        Mode = I(40)
        Blend = 1 if Mode == 1 else 2 if Mode == 2 else 0
        Life = max(0.05, F(31, 1.0))
        Spread = max(0.0, F(32))
        Speed, SpeedSpread = F(35), abs(F(36))
        Near = F(18, 50.0)
        Far = max(Near + 0.01, F(19, Near))
        Flip = None
        if I(58):
            Grid = {0: 1, 1: 4, 2: 16, 3: 64, 4: 256}.get(I(60), 1)
            Frames = max(1, min(Grid, I(61) or Grid))
            Start = max(0, min(Grid - 1, I(62) - 1))
            if Frames > 1 or Start:
                Flip = {'Grid': Grid, 'Frames': Frames, 'Start': Start, 'Fps': I(59) or 30}
        RandomScale = [F(68, 1.0), F(69, 1.0)] if I(67) == 1 else [1.0, 1.0]
        Size0, Size1 = F(33, 0.2), F(34, 0.2)
        return {
            'Kind': 'Simple', 'Tex': Textures, 'Blend': Blend, 'Lit': Mode == 3,
            'Rate': max(0, I(9)) if I(9) < 100000 else 0, 'Duration': max(0.0, F(0)), 'On': I(2) == 1,
            'Box': False, 'Axes': [2, 0, 1],
            'Speed': [max(0.0, Speed - SpeedSpread), Speed + SpeedSpread], 'Radius': 0.0, 'Radial': 0.0, 'Disc': 360.0,
            'Cone': min(180.0, max(0.0, F(10))),
            'Life': [Life, Life + Spread], 'FadeIn': max(0.0, F(56)), 'FadeOut': max(0.0, F(57)), 'FadeFraction': True,
            'Size': [Size0 * RandomScale[0], Size0 * RandomScale[1]], 'Grow': 0.0, 'EndSize': Size1 / Size0 if Size0 > 0 else 1.0,
            'Color0': _Rgb(I(39)), 'Color1': _Rgb(I(39)), 'Gravity': round(9.8 * F(46), 4),
            'Rot0': [F(48), F(49)], 'Spin': [F(50), F(51)], 'SpinSign': False,
            'Streak': False, 'Lod': [Near, Far], 'Flip': Flip, 'Inferred': True,
        }

    # ------------------------------------------------------------------ TTB Billboard Light Cone
    def _LightCone(self, Template, Instance, TextureRefs):
        V = InstanceProperties(Template, Instance)
        F = lambda Index, Default=0.0: _Float(V.get(Index, 0), Default) if Index in V else Default
        Texture = self._TextureList([V.get(5, 0)], TextureRefs)
        if not Texture:
            return None
        Axis = V.get(0, 1)
        Length = F(1)
        R0, R1 = max(0.025, F(2)), max(0.025, F(3))
        if not 0 < Length < 1e4:
            return None
        # PT: posições dos billboards como em 0x4B60E0 / EN: billboard positions as in 0x4B60E0
        Rest, Count = Length - R0 * 2.0 / 3.0, 1
        while Rest > 0 and Count < 4096:
            Count += 1
            Rest -= ((R1 - R0) * ((Length - Rest) / Length) + R0) * 2.0 / 3.0
        Steps, T, Rest = [], 0.0, Length
        for _Step in range(Count):
            Steps.append(T)
            Rest -= ((R1 - R0) * T + R0) * 2.0 / 3.0
            T = (Length - Rest) / Length
        Last = Steps[-1] if Steps[-1] > 0 else 1.0
        Steps = [Value / Last for Value in Steps]
        Power, Opacity = V.get(9, 0), F(8)
        # PT: alfa por billboard como em 0x4B56A0 / EN: per-billboard alpha as in 0x4B56A0
        Alphas = []
        for Value in Steps:
            Falloff = Value ** Power if Power > 0 else 0.0
            Alphas.append(int((1.0 - min(1.0, max(0.0, Falloff))) * Opacity * 255.0) / 255.0)
        Mode = V.get(6, 0)
        Blend = 1 if Mode in (3, 4, 11) else 2 if Mode == 5 else 0
        return {'Kind': 'Cone', 'Tex': Texture, 'Blend': Blend, 'Axis': Axis % 3, 'Sign': -1 if Axis <= 2 else 1,
                'Length': Length, 'Radius': [R0, R1], 'Color0': _Rgb(V.get(7, 0)), 'Steps': Steps, 'Alphas': Alphas,
                'Inferred': False}

    # ------------------------------------------------------------------ Billboard
    def _Billboard(self, Template, Instance, TextureRefs):
        V = InstanceProperties(Template, Instance)
        Textures = self._TextureList(_Array(Template, Instance, 0), TextureRefs)
        if not Textures:
            return None
        F = lambda Index, Default=0.0: _Float(V.get(Index, 0), Default) if Index in V else Default
        return {'Kind': 'Billboard', 'Tex': Textures[:1], 'Blend': 1, 'Size': [max(0.05, F(2, 0.5)), max(0.1, F(3, 2.0))],
                'Far': max(5.0, F(9, 40.0)), 'Inferred': True}

    def Build(self, Instances, NumberOf, TextureRefs):
        """
        PT: NumberOf: id da instância -> índice dela em Scene['Instances'] (o editor tira a matriz de lá).
        EN: NumberOf maps instance id -> its index in Scene['Instances'] (the editor takes the matrix from there).
        """
        Gravity = self._Gravity(Instances)
        Effects = []
        IsTTB = self.Game.IsTTB
        for Instance in Instances:
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            if not Template:
                continue
            Name = self.Classes.Name(Template.ClassId)
            Number = NumberOf.get(Instance['Id'])
            Effect = None
            try:
                if Name == 'Particle Fountain':
                    Effect = self._Fountain(Template, Instance, Gravity, TextureRefs)
                elif Name == 'Particle System - Simple':
                    Effect = self._Simple(Template, Instance, TextureRefs)
                elif Name == 'Billboard Light Cone':
                    Effect = self._LightCone(Template, Instance, TextureRefs)
                elif Name == 'Billboard':
                    Effect = self._Billboard(Template, Instance, TextureRefs)
                elif Name == 'Object Generator' and not IsTTB:
                    Effect = self._Generator(Template, Instance, Gravity, TextureRefs)
            except (IndexError, struct.error, ValueError):
                Effect = None
            if not Effect:
                continue
            Effect['Id'] = Instance['Id']
            Effect['N'] = Number if Number is not None else -1
            Effect['Pos'] = [round(Value / self.Game.PositionScale, 4) for Value in Instance['Position']]
            Effect['Rot'] = list(Instance['Rotation'])
            Effect['Scale'] = [round(Value, 5) for Value in Instance['Scale']]
            Effect['Dormant'] = 1 if Instance['Flags'] & 8 else 0
            Effects.append(_Round(Effect))
        return Effects

    # ------------------------------------------------------------------ TS1 Object Generator
    def _Generator(self, Template, Instance, Gravity, TextureRefs):
        V = InstanceProperties(Template, Instance)
        F = lambda Index, Default=0.0: _Float(V.get(Index, 0), Default) if Index in V else Default
        Children = []
        for Ref in _Array(Template, Instance, 0):
            Child = self.Templates.Get(Ref >> 16, Ref & 0xFFFF)
            if Child and self.Classes.Name(Child.ClassId) == 'Particle Fountain':
                Effect = self._Fountain(Child, None, Gravity, TextureRefs)
                if Effect:
                    Children.append(Effect)
        if not Children:
            return None
        Every = max(0.05, F(7, 1.0))
        return {'Kind': 'Generator', 'Children': Children, 'Every': [max(0.05, Every - abs(F(8))), Every + abs(F(8))],
                'RunFor': max(0.0, F(21)), 'On': V.get(24, 0) != 0, 'Inferred': False}
