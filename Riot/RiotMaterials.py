"""
RiotMaterials — materiais (templates .odu de classes do motor) / materials
==========================================================================

PT-BR
-----
Cada face de um modelo aponta para um material (lista no pedaço 0x0200 do modelo). O material é um
template do .odu de uma classe do motor; dele sai a textura e o modo de mistura:

    0xAD99E79B  material comum              slot 1 = textura
    0x7E3AD512  Advanced Material (camada)  slot 1 = textura, slot 2 = modo de mistura, slot 11 = geração de UV
                                            (0 = UVs do modelo; 1-3 = reflexo/ambiente)
    0x03656E9F  Layered Material            slot 1 = versão de baixo detalhe, slot 2 = array de camadas; o alpha
                                            da textura é máscara de brilho, não transparência
    0xD58D8E2C  Animating Material          slot 1 = array de quadros (texturas), 2 = quadros por segundo (float), 4 = modo
    0xB13556E7  Landscape Material          slot 3 = textura; o alpha é máscara de mistura do terreno

Modo de mistura (slot 2 do Advanced Material e do Simple Material), tabelas tiradas dos executáveis. O alpha da
textura NUNCA decide sozinho (0x48FAB0): modo 0 é desenhado inteiro mesmo com alpha na textura (muitas vezes o alpha é
máscara de reflexo); modo 1 numa textura de 1 bit (DXT1 com recorte) vira o modo 8 = recorte (alpha test 200, sem
mistura); os outros modos usam alpha test 2. (Conferido com o projeto "the-suffering-engine", renderer.md §5.2.)
    TS1 (0x49A990): 0 opaco, 1 alpha, 2 soma, 3 opaco, 4 subtração, 5 multiplica pelo alpha, 6 modula 2×,
                    7 um + alpha, 8 alpha
    TTB (0x49F880): 0 opaco, 1-2 alpha, 3-4 soma, 5 subtração, 6 multiplica pelo alpha, 7 modula 2×,
                    8 um + alpha, 9 multiplica, 10 modula 2×, 11 soma, 12 opaco
Uma referência pode também apontar direto para uma textura (sem material no meio).

Animação de material (Animation): o Animating Material troca de textura a fps quadros por segundo (0 = 15); o
Advanced Material com UVs do modelo (slot 11 = 0) tem escala fixa no slot 6, deslocamento U/V nos slots 7/8 e uma
curva de rolagem no slot 10 (referência a um waveform do .wdu, 2 canais u/v somados às coordenadas, em loop).

EN
--
Faces point to materials (engine-class templates). Texture slot and blend mode per class as listed above;
blend tables come from Suffering.exe 0x49A990 and SufferingTTB.exe 0x49F880.
"""
from .RiotPackages import SplitRef

ClassMaterial = 0xAD99E79B
ClassAdvancedMaterial = 0x7E3AD512
ClassLayeredMaterial = 0x03656E9F
ClassAnimatingMaterial = 0xD58D8E2C
ClassLandscapeMaterial = 0xB13556E7

BlendTS1 = {0: 'opaque', 1: 'alpha', 2: 'add', 3: 'opaque', 4: 'sub', 5: 'mulA', 6: 'mod2x', 7: 'oneA', 8: 'cutout'}
BlendTTB = {0: 'opaque', 1: 'alpha', 2: 'alpha', 3: 'add', 4: 'add', 5: 'sub', 6: 'mulA', 7: 'mod2x', 8: 'oneA',
            9: 'mul', 10: 'mod2x', 11: 'add', 12: 'opaque'}


class RiotMaterialResolver:
    """
    PT: Resolve material -> textura / modo de mistura / "alpha não é transparência".
    EN: Resolves material -> texture / blend mode / "alpha is not transparency".
    """

    def __init__(self, Game, Templates, Textures):
        self.Game = Game
        self.Templates = Templates
        self.Textures = Textures
        self.BlendTable = BlendTTB if Game.IsTTB else BlendTS1

    def ClassOf(self, Package, Index):
        Template = self.Templates.Get(Package, Index)
        return Template.ClassId if Template else None

    def LayerTexGen(self, Package, Index):
        """PT: 1 se a camada gera coordenadas (reflexo), 0 se usa as UVs do modelo. EN: 1 if the layer generates UVs."""
        Template = self.Templates.Get(Package, Index)
        if not Template or Template.ClassId != ClassAdvancedMaterial:
            return 0
        return 1 if Template.Slot(11) else 0

    def Texture(self, Package, Index, Depth=0):
        """PT: (pacote, índice) da textura do material, ou None. EN: Texture (package, index) or None."""
        if Depth > 4:
            return None
        Template = self.Templates.Get(Package, Index)
        if Template is None:
            return (Package, Index) if self.Textures.Exists(Package, Index) else None
        ClassId = Template.ClassId
        if ClassId == ClassLayeredMaterial:
            # PT: versão de baixo detalhe primeiro, depois camadas que usam as UVs do modelo
            # EN: low-detail version first, then layers that use the model UVs
            Candidates = Template.Slots[1:2] + sorted(Template.SlotArray(2), key=lambda Ref: self.LayerTexGen(*SplitRef(Ref)))
        elif ClassId == ClassAnimatingMaterial:
            Candidates = Template.SlotArray(1)
        else:
            Slot = 3 if ClassId == ClassLandscapeMaterial else 1
            Candidates = Template.Slots[Slot:Slot + 1]
        for Ref in Candidates:
            TexturePackage, TextureIndex = SplitRef(Ref)
            if not TexturePackage or TexturePackage not in self.Game.Packages or (TexturePackage, TextureIndex) == (Package, Index):
                continue
            if self.Textures.Exists(TexturePackage, TextureIndex):
                return (TexturePackage, TextureIndex)
            Found = self.Texture(TexturePackage, TextureIndex, Depth + 1)
            if Found:
                return Found
        return None

    def Blend(self, Package, Index, Depth=0):
        """PT: Modo de mistura ('opaque', 'alpha', 'add'…) ou None. EN: Blend mode or None."""
        if Depth > 3:
            return None
        Template = self.Templates.Get(Package, Index)
        if not Template or len(Template.Slots) < 3:
            return None
        if Template.ClassId in (ClassAdvancedMaterial, ClassMaterial):
            # PT: o Simple Material também guarda o modo no slot 2 (0x48F300 copia sem olhar a textura)
            # EN: Simple Material keeps its mode in slot 2 too (copied as is by 0x48F300)
            return self.BlendTable.get(Template.Slot(2))
        if Template.ClassId == ClassAnimatingMaterial:
            # PT: o Animating Material guarda o modo no slot 4 (1 = quadros, 2 = fps)
            # EN: Animating Material keeps its mode in slot 4 (1 = frames, 2 = fps)
            return self.BlendTable.get(Template.Slot(4))
        if Template.ClassId == ClassLayeredMaterial:
            # PT: o passe de base é a primeira camada com textura / EN: the base pass is the first textured layer
            for Ref in Template.SlotArray(2):
                if self.Texture(*SplitRef(Ref)):
                    return self.Blend(*SplitRef(Ref), Depth=Depth + 1)
        return None

    def AlphaIsMask(self, Package, Index):
        """
        PT: True quando o alpha da textura não é transparência (Layered Material e Landscape Material).
        EN: True when the texture alpha is not transparency.
        """
        return self.ClassOf(Package, Index) in (ClassLayeredMaterial, ClassLandscapeMaterial)

    def Tint(self, Package, Index, Depth=0):
        """
        PT: Cor de tinta (0xRRGGBB) quando o passe é "sem luz, tingido": Advanced p3/p4, Animating p5/p6. O motor manda
            TFACTOR = tinta / 2 e o estágio 1 dobra: o resultado é textura × tinta, sem iluminação. None = iluminado.
        EN: Tint colour when the pass is unlit and tinted (Advanced p3/p4, Animating p5/p6): texture × tint, no lighting.
        """
        if Depth > 3:
            return None
        Template = self.Templates.Get(Package, Index)
        if not Template:
            return None
        if Template.ClassId == ClassAdvancedMaterial:
            return Template.Slot(4) & 0xFFFFFF if Template.Slot(3) else None
        if Template.ClassId == ClassAnimatingMaterial:
            return Template.Slot(6) & 0xFFFFFF if Template.Slot(5) else None
        if Template.ClassId == ClassLayeredMaterial:
            for Ref in Template.SlotArray(2):
                if self.Texture(*SplitRef(Ref)):
                    return self.Tint(*SplitRef(Ref), Depth=Depth + 1)
        return None

    # ------------------------------------------------------------------ animação / animation
    def Animation(self, Package, Index, Waveforms=None, Depth=0):
        """
        PT: Animação do material que dá a textura: {'fr': [texturas], 'fps': n} (troca de quadros) ou
            {'k': escala, 'o': [u, v], 'sc': 'pkg_idx'} (UV fixa + rolagem). None quando não anima.
        EN: Animation of the material that supplies the texture (frame swap, or UV scale/offset/scroll), or None.
        """
        if Depth > 4:
            return None
        Template = self.Templates.Get(Package, Index)
        if Template is None:
            return None
        ClassId = Template.ClassId
        if ClassId == ClassLayeredMaterial:
            Candidates = Template.Slots[1:2] + sorted(Template.SlotArray(2), key=lambda Ref: self.LayerTexGen(*SplitRef(Ref)))
            for Ref in Candidates:
                Child = SplitRef(Ref)
                if Child[0] and Child != (Package, Index) and self.Texture(*Child):
                    return self.Animation(*Child, Waveforms=Waveforms, Depth=Depth + 1)
            return None
        if ClassId == ClassAnimatingMaterial:
            from .RiotPackages import RefName
            Frames = []
            for Ref in Template.SlotArray(1):
                Texture = SplitRef(Ref)
                if self.Textures.Exists(*Texture):
                    Frames.append(RefName(*Texture))
                else:
                    Found = self.Texture(*Texture, Depth=Depth + 1)
                    if Found:
                        Frames.append(RefName(*Found))
            Fps = Template.SlotFloat(2)
            if len(Frames) > 1:
                return {'fr': Frames, 'fps': round(Fps, 3) if 0 < Fps < 1000 else 15}
            return None
        if ClassId == ClassAdvancedMaterial and not Template.Slot(11):
            Result = {}
            Scale = Template.SlotFloat(6, 1.0)
            if Scale == Scale and 0 < abs(Scale) < 1e4 and Scale != 1:
                Result['k'] = round(Scale, 5)
            Offset = [Template.SlotFloat(7), Template.SlotFloat(8)]
            if all(Value == Value and abs(Value) < 1e4 for Value in Offset) and any(Offset):
                Result['o'] = [round(Value, 5) for Value in Offset]
            Scroll = SplitRef(Template.Slot(10))
            if Scroll[0] and Waveforms is not None:
                Wave = Waveforms.Get(*Scroll)
                if Wave and Wave[1] >= 2:
                    Result['sc'] = '%d_%04x' % Scroll
            return Result or None
        return None
