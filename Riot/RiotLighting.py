"""
RiotLighting — luz pré-calculada (.ldu) e Point Lights / baked lighting and point lights
=======================================================================================

PT-BR
-----
Luz pré-calculada: cada fase tem um "<fase>_level.ldu". O campo Tail de cada instância do .lvl é a
referência de um pedaço 0x0052 desse arquivo (leitor 0x487610):

    u16 ModelIndex, u16 ModelPackage   modelo para o qual as cores foram calculadas
    u32 SetCount                       quase sempre 1
    por conjunto: u32 n, n × u32 cor BGRA (uma por vértice do modelo, na ordem do pedaço 0x0203)
Se alguma cor tiver alpha < 0xFE o recurso ganha a flag 4 (translúcido).
No jogo: final = textura × min(2 × pré-calculada + Σ point lights + ambiente, 1.5686) × 0.5
(xvsLightPrecomputed / xvsLightPoint / xvsLightFooter, estágio 0 = MODULATE em 0x49AA7A).

Point Light (classe 0x7DFFD694, do motor): propriedade 0 = cor 0xAARRGGBB, 6 = ligada, 8 = intensidade
(na TTB há uma propriedade a mais: 7 = ligada, 9 = intensidade). Atenuação usada no visualizador
(aproximação do xvsLightPoint.vsh): cor × min(I / d², 2) × max(N·L, 0).

EN
--
Baked lighting: instance Tail -> chunk 0x0052 in "<level>_level.ldu" = model ref, set count, per set n BGRA
colours (one per model vertex). Point Light (0x7DFFD694): prop 0 colour, 6 enabled, 8 intensity (TTB: 7, 9).
"""
import struct

from .RiotLevel import InstanceProperties

ClassPointLight = 0x7DFFD694


class RiotBakedLight:
    """PT: Leitor das cores pré-calculadas de uma fase. EN: Baked colour reader for one level."""

    def __init__(self, Game):
        self.Game = Game

    def Colors(self, Ref):
        """
        PT: (ModelRef, quantidade, bytes BGRA) do pedaço 0x0052 de referência Ref, ou None.
        EN: (ModelRef, count, BGRA bytes) for chunk 0x0052 with reference Ref, or None.
        """
        if not Ref:
            return None
        Container = self.Game.PackageContainer(Ref >> 16, '.ldu')
        if not Container:
            return None
        Chunk = Container.Resource(Ref & 0xFFFF).get(0x0052)
        if not Chunk or Chunk.Size < 12:
            return None
        ModelIndex, ModelPackage, _Sets, Count = struct.unpack_from('<HHII', Container.Data, Chunk.Offset)
        if Chunk.Size < 12 + 4 * Count:
            return None
        Start = Chunk.Offset + 12
        return (ModelPackage << 16) | ModelIndex, Count, Container.Data[Start:Start + 4 * Count]


def PointLights(Instances, Templates, IsTTB, PositionScale):
    """
    PT: Lista de Point Lights: (x, y, z, r, g, b, intensidade, id da instância, ligada 0/1), cores de 0 a 1.
        As desligadas também vêm (o editor deixa ligar/desligar).
    EN: Point lights: (x, y, z, r, g, b, intensity, instance id, enabled 0/1), colours 0..1 (disabled ones included).
    """
    EnabledProperty, IntensityProperty = (7, 9) if IsTTB else (6, 8)
    Lights = []
    for Instance in Instances:
        Template = Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        if not Template or Template.ClassId != ClassPointLight:
            continue
        Values = InstanceProperties(Template, Instance)
        Color = Values.get(0, 0)
        Enabled = Values.get(EnabledProperty, 1)
        Intensity = struct.unpack('<f', struct.pack('<I', Values.get(IntensityProperty, 0)))[0]
        if not (0.0 <= Intensity < 1e5):
            continue
        Red, Green, Blue = ((Color >> 16) & 255) / 255.0, ((Color >> 8) & 255) / 255.0, (Color & 255) / 255.0
        X, Y, Z = (Value / PositionScale for Value in Instance['Position'])
        Lights.append((round(X, 4), round(Y, 4), round(Z, 4), round(Red, 4), round(Green, 4), round(Blue, 4), round(Intensity, 4),
                       Instance['Id'], 1 if Enabled else 0, 1 if Instance['Flags'] & 8 else 0))
    return Lights


ClassAmbientLight = 0x7578F3F7
ClassDirectionalLight = 0x6B110672


def WorldLights(Instances, Templates, PositionScale):
    """
    PT: Ambient Light e Directional Light da fase (cor na propriedade 0). Na equação do motor, o que NÃO tem cor
        pré-calculada é iluminado por L = ambiente + Σ direcional × max(N·L, 0) (+ point lights); o pré-calculado
        usa 2 × cor do .ldu. A luz direcional anda no -Z do objeto (a mesma base das instâncias), então L = +Z.
        Instâncias com a flag 0x8 (não criadas no início) ficam de fora. Com várias (regiões), o editor usa a mais perto.
    EN: Ambient/Directional Lights (colour = property 0). Unbaked geometry gets ambient + Σ directional·max(N·L, 0);
        the light travels along the object's -Z, so the vector towards it is +Z. Flag-0x8 instances are skipped.
    """
    import math
    Result = {'Ambient': [], 'Directional': []}
    for Instance in Instances:
        Template = Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        if not Template or Template.ClassId not in (ClassAmbientLight, ClassDirectionalLight) or Instance['Flags'] & 8 or not Instance['Flags'] & 1:
            continue
        Color = InstanceProperties(Template, Instance).get(0, 0)
        Rgb = [round(((Color >> Shift) & 255) / 255.0, 4) for Shift in (16, 8, 0)]
        Where = [round(Value / PositionScale, 3) for Value in Instance['Position']]
        if Template.ClassId == ClassAmbientLight:
            Result['Ambient'].append(Rgb + [Instance['Id']] + Where)
            continue
        X, Y, Z = (math.radians(Value) for Value in Instance['Rotation'])
        Yaw = Y - math.pi / 2
        # PT: R = Ry(yaw) · Rx(x) · Rz(z) aplicado a (0, 0, 1) / EN: R·(0, 0, 1)
        Dx, Dy, Dz = math.sin(Yaw) * math.cos(X), -math.sin(X), math.cos(Yaw) * math.cos(X)
        Result['Directional'].append([round(Dx, 5), round(Dy, 5), round(Dz, 5)] + Rgb + [Instance['Id']] + Where)
    return Result


ClassLightingEffect = 0x6968CE68


def LightEffects(Instances, Templates, Waveforms, IsTTB):
    """
    PT: Lighting Effect (0x6968CE68, classe do motor) — anima a cor e o raio das Point Lights ligadas a ele.
        Lido no Suffering.exe (nota 9z8):
          • tabela de classes: p0, p1 int; p2–p5 mensagens; p6, p7 cor; p8 curva (.wdu); p9, p10 float + p11 curva;
            p12, p13 float + p14 curva; p15, p16 float + p17 curva;
          • 0x4C4C40 (início): p0 ≠ 0 = ativo desde o começo; guarda as Point/Spot Lights dos links;
          • mapa de mensagens 0x5BA480: p2 liga (0x4C49D0), p3 desliga (0x4C49F0), p4 destrói (0x4C4A20);
          • a cada quadro (0x4C5820): tempo += dt; para cada curva carregada, t = fmod(tempo, duração),
            s = (curva(t) + 1) × 0,5; com p1 = 0 a curva para depois de uma volta;
            cor (0x4C4F20) = p6 + (p7 − p6) × s por canal (/255);
            raio (0x4C5450) = p9 + (p10 − p9) × s, no mesmo campo e escala do p8 da Point Light (0x4C60B0);
            p12–p17 só valem para Spot Lights.
        Também a Point Light com p3 ≠ −1 cria, ao nascer, um objeto do modelo p3 ligado a ela (0x4C6CA0) — é assim que
        as lâmpadas que piscam funcionam (os modelos são Lighting Effects do World Common).
        Devolve [{Id, Template, Lights: [ids], On, Loop, Color: [[r,g,b],[r,g,b]] | None, ColorWave, Radius: [a, b] | None,
        RadiusWave}], com as curvas por referência em Waves (para Scene.Waves). Só TS1 (a TTB não foi conferida).
    EN: Lighting Effect: animates colour and radius of its linked point lights (see the notes for addresses).
    """
    if IsTTB:
        return [], {}
    Float = lambda Value: struct.unpack('<f', struct.pack('<I', Value & 0xFFFFFFFF))[0]
    Rgb = lambda Value: [round(((Value >> Shift) & 255) / 255.0, 4) for Shift in (16, 8, 0)]
    Waves = {}

    def Wave(Ref):
        if not Ref or Ref == 0xFFFFFFFF:
            return None
        Name = '%d_%04x' % (Ref >> 16, Ref & 0xFFFF)
        if Name not in Waves:
            Data = Waveforms.Get(Ref >> 16, Ref & 0xFFFF)
            if not Data:
                return None
            Waves[Name] = [round(Data[0], 5), Data[1], [round(Value, 5) for Value in Data[2]], round(Data[3], 5)]
        return Name

    def Effect(Values, Id, Template, Lights):
        ColorWave, RadiusWave = Wave(Values.get(8, 0)), Wave(Values.get(11, 0))
        if not ColorWave and not RadiusWave:
            return None
        return {'Id': Id, 'Template': Template, 'Lights': Lights, 'On': 1 if Values.get(0, 0) else 0, 'Loop': 1 if Values.get(1, 0) else 0,
                'Color': [Rgb(Values.get(6, 0)), Rgb(Values.get(7, 0))] if ColorWave else None, 'ColorWave': ColorWave,
                'Radius': [round(Float(Values.get(9, 0)), 4), round(Float(Values.get(10, 0)), 4)] if RadiusWave else None, 'RadiusWave': RadiusWave}

    ClassOf = {}
    for Instance in Instances:
        Template = Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        ClassOf[Instance['Id']] = Template.ClassId if Template else None
    Result = []
    for Instance in Instances:
        Template = Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        if not Template or Instance['Flags'] & 8:
            continue
        Values = InstanceProperties(Template, Instance)
        if Template.ClassId == ClassLightingEffect:
            Lights = [Target for Target in Instance['Links'] if ClassOf.get(Target) == ClassPointLight]
            Entry = Effect(Values, Instance['Id'], None, Lights) if Lights else None
        elif Template.ClassId == ClassPointLight and Values.get(3, 0) not in (0, 0xFFFFFFFF):
            Ref = Values[3]
            Spawned = Templates.Get(Ref >> 16, Ref & 0xFFFF)
            Entry = None
            if Spawned and Spawned.ClassId == ClassLightingEffect:
                Entry = Effect({Slot: Spawned.Slot(Slot) for Slot in range(len(Spawned.Slots))}, None,
                               '%d_%04x' % (Ref >> 16, Ref & 0xFFFF), [Instance['Id']])
        else:
            continue
        if Entry:
            Result.append(Entry)
    return Result, Waves
