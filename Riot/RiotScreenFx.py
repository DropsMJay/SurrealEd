"""
RiotScreenFx — o que uma mensagem põe na tela (TTB) / what a message puts on screen (TTB)
=========================================================================================

PT-BR
-----
Prévia dos efeitos de tela que a TTB liga por mensagem (STOMP, scripts). Tudo lido no SufferingTTB.rfl
(nota 9z9); campos não lidos ficam de fora.

GUI Launcher (0x2AB838A7)
  • Mapa de mensagens 0x1A3F958: p5 → FUN_01997E60 (abre), p6 → FUN_019980D0.
  • FUN_01997E60, p0 = 0: FUN_019EE4E0(p4, self, p2) abre o widget do modelo p2 (ex.: um Simple Text HUD).

Widgets (Simple Text HUD 0x77D5366F, HUD Texture 0x1265CB3F; base FUN_019CD630 / FUN_019D1BB0)
  • Layout (FUN_019CB530): x = W·p1 %, y = H·p3 %, largura = W·p4 %, altura = H·p5 % (W, H = tela em pixels,
    FUN_019C9610). p6 = 1: escala W/640, H/448 (usada quando o tamanho é 0).
  • Filhos (FUN_019CD4A0): a lista p18 cria widgets HUD Texture (FUN_019D56F0); a lista p19, widgets de texto.
  • Tempo (FUN_019D1BB0 / FUN_019D1DE0 / FUN_019D1F10): p20 ≠ 0 liga o cronômetro; fica p21 s na tela; com p24 > 0
    entra deslizando de (p25 %, p26 %) em p24 s e sai do mesmo jeito; com p24 = 0 aparece e some de uma vez.
  • HUD Texture: textura p29; região em pixels p30, p31 (início) e p32, p33 (tamanho; 0 = textura inteira)
    (FUN_019D5780 / FUN_019D58A0); cor branca, alfa 1 (0x19CB79F).

Screen Fader (0x21C015A3)
  • Mapa 0x1A401A0: p15 → começa (FUN_019A4700), p14 → destrói, p13 → liga a flag de desenho, p16 → pré-carrega.
  • FUN_019A4C30: entra em p0 s (alfa = p8 × (1 − t/p0)), fica p1 s (alfa = p8), sai em p2 s (alfa = p8 × t/p2);
    no fim p4 = 1 destrói, senão volta ao início. Som p9 no início/meio/saída conforme p10 = 0/1/2.
  • Sem objeto em p12: quad de tela cheia com a textura p6 (0 = sem textura) e a cor p7 (FUN_019A4AA0).
    A mistura do quad não foi lida (o editor usa alfa comum).

EN
--
Screen effects that Ties That Bind triggers by message, described only with fields read in SufferingTTB.rfl.
"""
import struct

ClassGuiLauncher, ClassSimpleTextHud, ClassHudTexture, ClassScreenFader = 0x2AB838A7, 0x77D5366F, 0x1265CB3F, 0x21C015A3
Inputs = {ClassGuiLauncher: {5: 'Open', 6: 'Close'}, ClassScreenFader: {15: 'Start', 14: 'Destroy'}}


def _Float(Value):
    return round(struct.unpack('<f', struct.pack('<I', Value & 0xFFFFFFFF))[0], 4)


def _Ref(Value):
    return '%d_%04x' % (Value >> 16, Value & 0xFFFF) if Value and Value != 0xFFFFFFFF else None


class RiotScreenFx:
    def __init__(self, Templates, Classes, IsTTB):
        self.Templates, self.Classes, self.IsTTB = Templates, Classes, IsTTB

    def _Slots(self, Ref):
        Template = self.Templates.Get(Ref >> 16, Ref & 0xFFFF) if Ref and Ref != 0xFFFFFFFF else None
        return Template

    @staticmethod
    def _List(Template, Slot):
        from .RiotProperties import _ArrayItems
        Header = Template.Slot(Slot)
        return [Item for Item in _ArrayItems(Template.Slots, Header) if isinstance(Item, int)] if isinstance(Header, int) else []

    def _Timing(self, Template):
        Get = Template.Slot
        return {'Hold': _Float(Get(21)) if Get(20) else None, 'Slide': _Float(Get(24)),
                'From': [_Float(Get(25)), _Float(Get(26))]}

    def Widget(self, Ref):
        """PT: Um widget (Simple Text HUD) e as HUD Texture filhas. EN: A widget and its HUD Texture children."""
        Template = self._Slots(Ref)
        if not Template or Template.ClassId != ClassSimpleTextHud:
            return None
        Get = Template.Slot
        Result = {'Kind': 'hud', 'Template': _Ref(Ref), 'Timing': self._Timing(Template), 'Items': []}
        for ChildRef in self._List(Template, 18):
            Child = self._Slots(ChildRef)
            if not Child or Child.ClassId != ClassHudTexture:
                continue
            C = Child.Slot
            Result['Items'].append({
                'Template': _Ref(ChildRef), 'Texture': _Ref(C(29)),
                'Rect': [_Float(C(1)), _Float(C(3)), _Float(C(4)), _Float(C(5))],   # PT: % da tela / EN: % of the screen
                'Region': [_Float(C(30)), _Float(C(31)), _Float(C(32)), _Float(C(33))],
                'Scaled': C(6) == 1, 'Timing': self._Timing(Child)})
        Result['Untranslated'] = len(self._List(Template, 19))   # PT: widgets de texto (ainda não desenhados) / EN: text widgets
        return Result

    def Fader(self, Values):
        Get = lambda Slot: Values.get(Slot, 0)
        return {'Kind': 'fade', 'Texture': _Ref(Get(6)), 'Color': '#%06x' % (Get(7) & 0xFFFFFF), 'Alpha': _Float(Get(8)),
                'In': _Float(Get(0)), 'Hold': _Float(Get(1)), 'Out': _Float(Get(2)), 'Attached': bool(_Ref(Get(12)))}

    def Resolve(self, Template, Values, Message):
        """PT: [descrição] do que a mensagem faz neste objeto. EN: what the message does on this object."""
        if not self.IsTTB or not Template or Template.ClassId not in Inputs:
            return []
        Result = []
        for Slot, Action in Inputs[Template.ClassId].items():
            if Values.get(Slot) != Message or not Message:
                continue
            if Template.ClassId == ClassGuiLauncher and Action == 'Open' and Values.get(0, 0) == 0:
                Widget = self.Widget(Values.get(2, 0))
                if Widget:
                    Result.append(Widget)
            elif Template.ClassId == ClassScreenFader and Action == 'Start':
                Fader = self.Fader(Values)
                if not Fader['Attached']:
                    Result.append(Fader)
        return Result
