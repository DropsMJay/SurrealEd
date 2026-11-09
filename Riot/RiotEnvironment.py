"""
RiotEnvironment — ambiente da fase (neblina, céu) / level environment (fog, sky)
================================================================================

PT-BR
-----
O .lvl não guarda a neblina. Ele tem um objeto "Level Properties" cuja propriedade de referência aponta para um
"Sky Properties" — quase sempre no World Common (World Common.odu) ou o padrão do System (#0x0008). Objetos
"Fog / Sky Switcher" trocam para outros Sky Properties quando o jogador entra numa área, e "Volumetric Fog" são
nuvens locais de névoa (templates do pacote FX).

Os Sky Properties são compartilhados entre fases: mudar um no World Common muda todas as fases que o usam.
Este módulo junta tudo isso para o painel "Ambiente da fase" e calcula, uma vez, quais fases usam cada Sky Properties.

Campos do Sky Properties (TS1, ver notas seção 8.2): p2 fim da neblina, p3 início (fração de p2), p4 cor da
neblina, p5 cor do céu/ambiente (não testado), p9 referência do céu. Na TTB a ordem parece a mesma (p2 é do tipo
0x15, um float).

EN
--
The .lvl does not store fog. Its "Level Properties" object references a "Sky Properties" object (usually in World
Common). "Fog / Sky Switcher" objects swap to other Sky Properties per area; "Volumetric Fog" objects are local fog
volumes from the FX package. Sky Properties are shared between levels, so this module also indexes which levels use
each one.
"""
import struct

from .RiotLevel import ReadInstances, InstanceProperties
from .RiotProperties import FormatRef

LevelPropertiesName = 'Level Properties'
SkyName = 'Sky Properties'
SwitcherName = 'Fog / Sky Switcher'
VolumeName = 'Volumetric Fog'

# (índice, chave de texto, confirmado?) / (index, string key, confirmed?)
SkyFields = [
    (0, 'EnvSkyP0', False),
    (1, 'EnvSkyP1', False),
    (2, 'EnvFogEnd', True),
    (3, 'EnvFogStart', True),
    (4, 'EnvFogColour', True),
    (5, 'EnvSkyColour', False),
    (6, 'EnvSkyP6', True),
    (7, 'EnvSkyP7', True),
    (8, 'EnvSkyP8', False),
    (9, 'EnvSkyRef', False),
]

FloatTypes = (0x0002, 0x0015, 0x0016)


def _Float(Value):
    return struct.unpack('<f', struct.pack('<I', Value & 0xFFFFFFFF))[0]


def _IsRefType(Type):
    return bool(Type & 0x6000) or Type == 0x0003


def FormatEnvValue(Type, Value):
    """PT: Valor para exibição (float, cor, ref, inteiro). EN: Display value."""
    if Type in FloatTypes:
        return {'Kind': 'float', 'Value': round(_Float(Value), 4)}
    if Type == 0x000F:
        return {'Kind': 'colour', 'Value': '#%06X' % (Value & 0xFFFFFF)}
    if _IsRefType(Type):
        return {'Kind': 'ref', 'Value': FormatRef(Value)}
    return {'Kind': 'int', 'Value': Value - 0x100000000 if Value >= 0x80000000 else Value}


class RiotEnvironment:
    """
    PT: Ambiente das fases de um jogo. Usa as tabelas de classes e templates da sessão.
    EN: Level environment for one game, using the session's class table and template store.
    """

    def __init__(self, Game, Classes, Templates):
        self.Game = Game
        self.Classes = Classes
        self.Templates = Templates
        Ids = {Class.Name: ClassId for ClassId, Class in Classes.Classes.items()}
        self.LevelPropertiesId = Ids.get(LevelPropertiesName)
        self.SkyId = Ids.get(SkyName)
        self.SwitcherId = Ids.get(SwitcherName)
        self.VolumeId = Ids.get(VolumeName)
        self._UsageIndex = None

    # ------------------------------------------------------------------ apoio / helpers
    def PackageName(self, Ref):
        return self.Game.PackageNames.get(Ref >> 16, '?')

    def _ClassOfRef(self, Ref):
        Template = self.Templates.GetRef(Ref) if Ref else None
        return Template.ClassId if Template else None

    def _SkyRefs(self, ClassId, Values):
        """PT: Referências a Sky Properties nas propriedades de um objeto. EN: Sky Properties refs in an object."""
        Types = self.Classes.PropertyTypes(ClassId) or []
        Found = []
        for Index, Type in enumerate(Types):
            if not _IsRefType(Type) or Type & 0x1000:
                continue
            Ref = Values.get(Index, 0)
            if Ref and self._ClassOfRef(Ref) == self.SkyId:
                Found.append((Index, Ref))
        return Found

    def _Scan(self, Instances):
        """PT: (Level Properties, switchers, volumes) de uma lista de instâncias. EN: Scan one level's instances."""
        LevelProperties, Switchers, Volumes = [], [], []
        for Instance in Instances:
            Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
            if not Template:
                continue
            if Template.ClassId == self.LevelPropertiesId:
                LevelProperties.append((Instance, Template))
            elif Template.ClassId == self.SwitcherId:
                Switchers.append((Instance, Template))
            elif Template.ClassId == self.VolumeId:
                Volumes.append((Instance, Template))
        return LevelProperties, Switchers, Volumes

    def UsageIndex(self):
        """
        PT: {ref do Sky Properties: [nomes das fases]}, calculado uma vez (Level Properties + switchers).
        EN: {Sky Properties ref: [level names]}, computed once.
        """
        if self._UsageIndex is not None:
            return self._UsageIndex
        Index = {}
        for Level in self.Game.Levels():
            try:
                Instances, _Complete = ReadInstances(self.Game.Container(Level['Path']))
            except (OSError, ValueError, struct.error):
                continue
            LevelProperties, Switchers, _Volumes = self._Scan(Instances)
            for Instance, Template in LevelProperties + Switchers:
                for _Index, Ref in self._SkyRefs(Template.ClassId, InstanceProperties(Template, Instance)):
                    Names = Index.setdefault(Ref, [])
                    if Level['File'] not in Names:
                        Names.append(Level['File'])
        self._UsageIndex = Index
        return Index

    def DescribeSky(self, Ref):
        Template = self.Templates.GetRef(Ref)
        if not Template or Template.ClassId != self.SkyId:
            return None
        Types = self.Classes.PropertyTypes(self.SkyId) or []
        Fields = []
        for Index, Key, Confirmed in SkyFields:
            if Index >= len(Types):
                continue
            Type = Types[Index]
            if Type & 0x1000:
                Items = Template.SlotArray(Index)
                Value = {'Kind': 'refs', 'Value': [FormatRef(Item) for Item in Items]}
            else:
                Value = FormatEnvValue(Type, Template.Slot(Index))
            Fields.append(dict(Value, Index=Index, Key=Key, Confirmed=Confirmed, Raw=Template.Slot(Index), Type=Type))
        return {'Ref': FormatRef(Ref), 'Package': self.PackageName(Ref), 'Fields': Fields,
                'UsedBy': self.UsageIndex().get(Ref, [])}

    def _Position(self, Instance):
        Scale = self.Game.PositionScale
        return [round(Value / Scale, 4) for Value in Instance['Position']]

    # ------------------------------------------------------------------ fase / level
    def LevelEnvironment(self, Level):
        """
        PT: Ambiente de uma fase aberta (RiotLevel): Level Properties, Sky Properties, switchers e volumes.
        EN: Environment of an opened level.
        """
        LevelProperties, Switchers, Volumes = self._Scan(Level.Instances)
        Skies = {}

        def Sky(Ref):
            if Ref not in Skies:
                Skies[Ref] = self.DescribeSky(Ref)
            return FormatRef(Ref)

        Result = {'LevelProperties': [], 'Switchers': [], 'Volumes': [], 'Skies': {}}
        for Instance, Template in LevelProperties:
            Values = InstanceProperties(Template, Instance)
            Refs = self._SkyRefs(Template.ClassId, Values)
            Result['LevelProperties'].append({
                'Id': Instance['Id'], 'Template': '%d_%04x' % (Instance['TemplatePackage'], Instance['TemplateIndex']),
                'TemplatePackage': self.Game.PackageNames.get(Instance['TemplatePackage'], '?'),
                'Overrides': sorted(set(Instance['PropertyIndexes'])),
                'Sky': [{'Property': Index, 'Ref': Sky(Ref), 'Overridden': Index in Instance['PropertyIndexes']} for Index, Ref in Refs]})
        Types = self.Classes.PropertyTypes(self.SwitcherId) or []
        for Instance, Template in Switchers:
            Values = InstanceProperties(Template, Instance)
            Refs = self._SkyRefs(Template.ClassId, Values)
            Time = Values.get(2) if len(Types) > 2 and Types[2] in FloatTypes else None
            Result['Switchers'].append({
                'Id': Instance['Id'], 'Template': '%d_%04x' % (Instance['TemplatePackage'], Instance['TemplateIndex']),
                'Position': self._Position(Instance), 'Sky': [{'Property': Index, 'Ref': Sky(Ref)} for Index, Ref in Refs],
                'Time': round(_Float(Time), 3) if Time is not None else None})
        VolumeTypes = self.Classes.PropertyTypes(self.VolumeId) or []
        for Instance, Template in Volumes:
            Values = InstanceProperties(Template, Instance)
            Colour = next((('#%06X' % (Values.get(Index, 0) & 0xFFFFFF)) for Index, Type in enumerate(VolumeTypes) if Type == 0x000F), None)
            Result['Volumes'].append({
                'Id': Instance['Id'], 'Template': '%d_%04x' % (Instance['TemplatePackage'], Instance['TemplateIndex']),
                'TemplatePackage': self.Game.PackageNames.get(Instance['TemplatePackage'], '?'),
                'Position': self._Position(Instance), 'Colour': Colour,
                'Overrides': sorted(set(Instance['PropertyIndexes']))})
        Result['Skies'] = {FormatRef(Ref): Info for Ref, Info in Skies.items() if Info}
        return Result
