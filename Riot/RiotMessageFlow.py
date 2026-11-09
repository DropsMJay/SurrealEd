"""
RiotMessageFlow — para onde vai uma mensagem (prévia no editor) / where a message goes (editor preview)
=====================================================================================================

PT-BR
-----
Dado um objeto da fase e uma mensagem (ex.: uma chave "Mensagem" do STOMP), descobre quais EFEITOS ela liga ou
desliga, para o editor mostrar a cena como no jogo. Só segue o que já foi lido no código (RiotSlotNames.py, notas 9z4
e 9z5), TS1:
  • um objeto reage se uma das entradas dele guarda essa mensagem (mapa de mensagens);
  • Particle Fountain: p50 liga, p51 desliga, p52 termina; Object Generator: p32 liga, p33 desliga, p34 alterna;
    Fire: p19 acende, p20 apaga; Lighting Effect (classe do motor): p2 liga, p3 desliga, p4 destrói;
  • Message Relay p4: repassa a mensagem do p8 aos links (a prévia manda para todos; contagem/sorteio são ignorados);
  • Visibility Toggler p1/p2/p3: mostra/esconde/alterna os links — num efeito vira liga/desliga/alterna.
Timers, Detectors e o resto dependem de tempo ou do jogador e não entram na prévia.

EN
--
Resolves which effects a message turns on/off, following only behaviour read from the code (TS1).
"""
from .RiotProperties import MessageSlots

ClassParticleFountain, ClassObjectGenerator, ClassFire = 0x7EA6E450, 0xBE08B1A0, 0x1D84210F
ClassMessageRelay, ClassVisibilityToggler = 0xD44B5953, 0x83A8B1D9
ClassLightingEffect = 0x6968CE68   # PT: classe do motor; mapa 0x5BA480 (nota 9z8) / EN: engine class
EffectInputs = {
    ClassParticleFountain: {50: 'On', 51: 'Off', 52: 'Off'},
    ClassObjectGenerator: {32: 'On', 33: 'Off', 34: 'Toggle'},
    ClassFire: {19: 'On', 20: 'Off'},
    ClassLightingEffect: {2: 'On', 3: 'Off', 4: 'Off'},
}
TogglerActions = {1: 'On', 2: 'Off', 3: 'Toggle'}


class RiotMessageFlow:
    def __init__(self, Templates, IsTTB):
        self.Templates = Templates
        self.IsTTB = IsTTB

    def _Class(self, Instance):
        Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        return Template.ClassId if Template else None

    def _Value(self, Instance, Slot):
        for Index, Value in zip(Instance['PropertyIndexes'], Instance['Values']):
            if Index == Slot:
                return Value if isinstance(Value, int) else None
        Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
        return Template.Slot(Slot) if Template and Slot < len(Template.Slots) else None

    def Resolve(self, ById, InstanceId, Message, Depth=0, Seen=None):
        """PT: [(id do efeito, 'On'|'Off'|'Toggle')] / EN: [(effect id, action)]"""
        if self.IsTTB or not Message or Depth > 6:
            return []
        Seen = set() if Seen is None else Seen
        if (InstanceId, Message) in Seen:
            return []
        Seen.add((InstanceId, Message))
        Instance = ById.get(InstanceId)
        ClassId = self._Class(Instance) if Instance else None
        if ClassId is None:
            return []
        Result = []
        for Slot in MessageSlots(ClassId, False)['inputs']:
            if self._Value(Instance, Slot) != Message:
                continue
            if ClassId in EffectInputs and Slot in EffectInputs[ClassId]:
                Result.append((InstanceId, EffectInputs[ClassId][Slot]))
            elif ClassId == ClassMessageRelay and Slot == 4:
                Relayed = self._Value(Instance, 8)
                for Target in Instance['Links']:
                    Result += self.Resolve(ById, Target, Relayed, Depth + 1, Seen)
            elif ClassId == ClassVisibilityToggler and Slot in TogglerActions:
                for Target in Instance['Links']:
                    Linked = ById.get(Target)
                    if Linked and self._Class(Linked) in EffectInputs:
                        Result.append((Target, TogglerActions[Slot]))
        return Result
