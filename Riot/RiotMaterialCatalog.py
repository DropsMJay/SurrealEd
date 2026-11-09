"""
RiotMaterialCatalog — dados da aba Material / data for the Material tab
=======================================================================

PT-BR
-----
Lista os materiais (templates do .odu das classes de material do motor) de um pacote e descreve um material para o
editor de nós: slots com nome e tipo quando conhecidos (os mesmos fatos de RiotMaterials.py), texturas, quadros,
camadas e a curva de rolagem (.wdu). Os slots sem nome aparecem como valor bruto, marcados "(?)".
Os itens de uma propriedade-array ficam no fim dos slots ((contagem << 16) | deslocamento); eles não são listados
como parâmetros, e sim como quadros/camadas.

EN
--
Lists a package's materials (engine material-class templates in the .odu) and describes one for the node editor:
named/typed slots where known (same facts as RiotMaterials.py), textures, frames, layers and the scroll waveform.
Unnamed slots are listed raw and marked "(?)". Array items live at the end of the slots and are shown as
frames/layers instead of parameters.
"""
import struct

from .RiotMaterials import (ClassAdvancedMaterial, ClassAnimatingMaterial, ClassLandscapeMaterial, ClassLayeredMaterial,
                            ClassMaterial)
from .RiotPackages import RefName, SplitRef
from .RiotWaveforms import RiotWaveformStore

MaterialClasses = {ClassMaterial: 'Simple Material', ClassAdvancedMaterial: 'Advanced Material', ClassLayeredMaterial: 'Layered Material',
                   ClassAnimatingMaterial: 'Animating Material', ClassLandscapeMaterial: 'Landscape Material'}

# PT: (slot, tipo, nome PT, nome EN). Tipos: ref, tex, mat, wave, blend, bool, color, float, int, enum, uvgen, array.
#     Os tipos de cada slot vêm da tabela de classes embutida no Suffering.exe (0x5BB3xx: hash, nome, nº de props,
#     grupos de códigos de tipo); ela confere com todos os slots já conhecidos. O slot 0 de toda classe de material é
#     0x4003 e, nos dados, aponta sempre para um objeto da classe "Game Material Properties" (0x3E862B1B).
# EN: (slot, kind, PT name, EN name). Slot types come from the class table built into Suffering.exe; slot 0 of every
#     material class points to a "Game Material Properties" object (0x3E862B1B).
_Surface = (0, 'ref', 'Propriedades de jogo do material', 'Game Material Properties')
# PT: Landscape Material (0xB13556E7), lido pelo código do terreno do Suffering.exe:
#     p1/p2 em FUN_004AAF80 (matriz de quais materiais se misturam), p4 em FUN_004A4A80 (escala da textura =
#     1 / (p4 × 2048)), p6 em FUN_004AAE80 (ordena a lista de materiais de cada pedaço, menor primeiro),
#     p7/p8 em FUN_004994F0 (distância máxima das passadas, × 2048). p5 não é lido pelo exe (0 em todos os 84).
# EN: Landscape Material slots, read by the Suffering.exe terrain code (see Docs/RiotEngineNotes.md 9z2).
_ListMode = [(0, 'Não mistura com os da lista', 'Does not blend with listed'), (1, 'Só mistura com os da lista', 'Blends only with listed')]
Schemas = {
    ClassMaterial: [_Surface, (1, 'tex', 'Textura', 'Texture'), (2, 'blend', 'Modo de mistura', 'Blend mode')],
    ClassAdvancedMaterial: [_Surface, (1, 'tex', 'Textura', 'Texture'), (2, 'blend', 'Modo de mistura', 'Blend mode'),
                            (3, 'bool', 'Sem luz, tingido', 'Unlit, tinted'), (4, 'color', 'Cor da tinta', 'Tint colour'),
                            (6, 'float', 'Escala da UV', 'UV scale'), (7, 'float', 'Deslocamento U', 'U offset'),
                            (8, 'float', 'Deslocamento V', 'V offset'), (10, 'wave', 'Curva de rolagem (.wdu)', 'Scroll curve (.wdu)'),
                            (11, 'uvgen', 'Geração de UV', 'UV generation')],
    ClassLayeredMaterial: [_Surface, (1, 'mat', 'Versão de baixo detalhe', 'Low-detail version'), (2, 'array', 'Camadas', 'Layers')],
    ClassAnimatingMaterial: [_Surface, (1, 'array', 'Quadros', 'Frames'), (2, 'float', 'Quadros por segundo', 'Frames per second'),
                             (4, 'blend', 'Modo de mistura', 'Blend mode'), (5, 'bool', 'Sem luz, tingido', 'Unlit, tinted'),
                             (6, 'color', 'Cor da tinta', 'Tint colour')],
    ClassLandscapeMaterial: [_Surface, (1, 'enum', 'Modo da lista de mistura', 'Blend list mode'),
                             (2, 'array', 'Lista de mistura', 'Blend list'),
                             (3, 'tex', 'Textura (alpha = máscara do terreno)', 'Texture (alpha = terrain mask)'),
                             (4, 'int', 'Tamanho do ladrilho (unidades)', 'Tile size (units)'),
                             (5, 'int', 'p5 (?) não lido pelo jogo', 'p5 (?) not read by the game'),
                             (6, 'float', 'Ordem de desenho (menor = antes)', 'Draw order (lower = first)'),
                             (7, 'float', 'Distância da mistura (unidades)', 'Blend distance (units)'),
                             (8, 'float', 'Distância da 2ª passada (unidades, ?)', 'Second pass distance (units, ?)')],
}
Options = {(ClassLandscapeMaterial, 1): _ListMode}


def _Float(Value):
    Result = struct.unpack('<f', struct.pack('<I', Value & 0xFFFFFFFF))[0]
    return round(Result, 6) if Result == Result and abs(Result) < 1e9 else None


class RiotMaterialCatalog:
    def __init__(self, Game, Templates, Textures, Materials):
        self.Game = Game
        self.Templates = Templates
        self.Textures = Textures
        self.Materials = Materials
        self.Waveforms = RiotWaveformStore(Game)

    def MaterialList(self, PackageId):
        Container = self.Game.PackageContainer(PackageId, '.odu')
        if not Container:
            return []
        Result = []
        for Index in Container.ResourceIndexes(0x0102):
            Template = self.Templates.Get(PackageId, Index)
            if not Template or Template.ClassId not in MaterialClasses:
                continue
            Texture = self.Materials.Texture(PackageId, Index)
            Result.append({'Index': Index, 'Ref': RefName(PackageId, Index), 'Class': MaterialClasses[Template.ClassId],
                           'Texture': RefName(*Texture) if Texture else None, 'Blend': self.Materials.Blend(PackageId, Index)})
        return Result

    def _Describe(self, Ref):
        """PT: Resumo de uma referência (textura ou material). EN: Summary of a reference."""
        Package, Index = SplitRef(Ref)
        if not Package:
            return None
        Template = self.Templates.Get(Package, Index)
        if Template and Template.ClassId in MaterialClasses:
            Texture = self.Materials.Texture(Package, Index)
            return {'Ref': RefName(Package, Index), 'Kind': 'material', 'Class': MaterialClasses[Template.ClassId],
                    'Texture': RefName(*Texture) if Texture else None}
        if self.Textures.Exists(Package, Index):
            return {'Ref': RefName(Package, Index), 'Kind': 'texture', 'Texture': RefName(Package, Index)}
        return {'Ref': RefName(Package, Index), 'Kind': 'other'}

    def Material(self, PackageId, Index):
        Template = self.Templates.Get(PackageId, Index)
        if not Template or Template.ClassId not in MaterialClasses:
            return None
        Schema = {Slot: (Kind, Pt, En) for Slot, Kind, Pt, En in Schemas[Template.ClassId]}
        # PT: onde começam os itens das arrays (não são parâmetros) / EN: where array items start (not parameters)
        Storage = len(Template.Slots)
        for Slot, (Kind, _Pt, _En) in Schema.items():
            Header = Template.Slot(Slot)
            if Kind == 'array' and Header >> 16 and (Header & 0xFFFF) > Slot:
                Storage = min(Storage, Header & 0xFFFF)
        Slots = []
        Arrays = {}
        for Slot in range(Storage):
            Raw = Template.Slot(Slot)
            Kind, Pt, En = Schema.get(Slot, ('raw', 'p%d (?)' % Slot, 'p%d (?)' % Slot))
            Row = {'Slot': Slot, 'Kind': Kind, 'Pt': Pt, 'En': En, 'Raw': Raw}
            if Kind in ('ref', 'tex', 'mat', 'wave'):
                Row['Target'] = self._Describe(Raw)
            elif Kind == 'float':
                Row['Float'] = _Float(Raw)
            elif Kind == 'raw':
                Row['Float'] = _Float(Raw)
            elif Kind == 'enum':
                Row['Options'] = [{'Value': Value, 'Pt': OptionPt, 'En': OptionEn} for Value, OptionPt, OptionEn in Options.get((Template.ClassId, Slot), [])]
            elif Kind == 'array':
                Items = Template.SlotArray(Slot)
                Offset = Raw & 0xFFFF
                Arrays[Slot] = [{'Slot': Offset + Position, 'Raw': Item, 'Target': self._Describe(Item)} for Position, Item in enumerate(Items)]
            Slots.append(Row)
        Wave = None
        Scroll = Template.Slot(10) if Template.ClassId == ClassAdvancedMaterial else 0
        if Scroll:
            Parsed = self.Waveforms.Get(*SplitRef(Scroll))
            if Parsed:
                Rate, Channels, Samples, Duration = Parsed
                Wave = {'Ref': RefName(*SplitRef(Scroll)), 'Rate': Rate, 'Channels': Channels, 'Duration': Duration,
                        'Samples': [round(Value, 5) for Value in Samples[:4000 * Channels]]}
        Texture = self.Materials.Texture(PackageId, Index)
        Tint = self.Materials.Tint(PackageId, Index)
        return {
            'Ref': RefName(PackageId, Index), 'Class': MaterialClasses[Template.ClassId], 'ClassId': '0x%08X' % Template.ClassId,
            'Slots': Slots, 'Arrays': {str(Key): Value for Key, Value in Arrays.items()},
            'Texture': RefName(*Texture) if Texture else None, 'Blend': self.Materials.Blend(PackageId, Index),
            'Tint': '#%06x' % Tint if Tint is not None else None, 'AlphaIsMask': self.Materials.AlphaIsMask(PackageId, Index),
            'Animation': self.Materials.Animation(PackageId, Index, self.Waveforms), 'Wave': Wave,
            'BlendTable': self.Materials.BlendTable,
        }
