"""
RiotSlotNames — nomes das entradas e saídas de mensagem (TS1) / names of message inputs and outputs (TS1)
=====================================================================================================

PT-BR
-----
Cada entrada de mensagem de uma classe roda uma função do Suffering.rfl (mapa de mensagens: registro -1, P, função);
cada saída é disparada em algum ponto do código (despachante, vt[1](objeto, P, remetente)). Esses pares estão em
RiotMessageHandlers.json (gerado por Ghidra/Atlas/RiotMessageHandlers.py). As funções foram decompiladas no Ghidra e
lidas uma a uma; os nomes abaixo vêm desse código (notas, seção 9z5).
  • "(?)" = dedução (por exemplo, apoiada só na mensagem padrão do template), não conferida no código.
  • Slots herdados das classes-base (GameObject, objetos usáveis, itens, NPCs, "action objects") são nomeados pela
    FUNÇÃO (BaseInputs), então valem para todas as classes que herdam aquela entrada.
  • O resto é por classe (ClassSlots): a mesma função genérica às vezes faz coisas opostas em classes diferentes
    (ex.: 0x6DC2EAA0 zera +0x10: liga o Detector e desliga o Behavior Changer).
Só TS1: o código da TTB não foi conferido.

EN
--
Names of message slots read from the decompiled Suffering.rfl handlers. "(?)" = inference. Inherited base-class slots
are named by handler address; the rest per class. TS1 only.
"""
import json
import os

_Here = os.path.dirname(os.path.abspath(__file__))
try:
    with open(os.path.join(_Here, 'RiotMessageHandlers.json'), encoding='utf-8') as _Handle:
        Handlers = {Game: {int(Id, 16): Row for Id, Row in Rows.items()} for Game, Rows in json.load(_Handle).items()}
except (OSError, ValueError):
    Handlers = {}

In, Out = 'Entrada: ', 'Saída: '
InEn, OutEn = 'Input: ', 'Output: '


def _I(Pt, En):
    return (In + Pt, InEn + En)


def _O(Pt, En):
    return (Out + Pt, OutEn + En)


# PT: entradas herdadas, pela função que rodam / EN: inherited inputs, by handler address
BaseInputs = {
    # GameObject (vtable +0x84/+0x88/+0x7C/+0x80; nomes conferidos com "the-suffering-engine" e a mensagem padrão)
    0x6DBA1C50: _I('explodir (BlowUp)', 'blow up'),
    0x6DBA1C60: _I('destruir (Destroy)', 'destroy'),
    0x6DBA1C30: _I('invulnerável: ligar', 'invulnerability on'),
    0x6DBA1C40: _I('invulnerável: desligar', 'invulnerability off'),
    0x6DBCB870: _I('se destruir', 'destroy itself'),                       # vtable +0x30
    # PT: objetos usáveis: vtable +0xD8(1/0) / EN: usable objects
    0x6DBBA520: _I('permitir uso', 'allow use'),
    0x6DBBA530: _I('impedir uso', 'block use'),
    # PT: itens: flag 0x40 (+0x46) e vtable +0x9C(jogador) / EN: items
    0x6DBBD110: _I('desativar (flag 0x40; padrão Disable) (?)', 'disable (flag 0x40; default Disable) (?)'),
    0x6DBBD100: _I('ativar (limpa a flag 0x40) (?)', 'enable (clears flag 0x40) (?)'),
    0x6DBBD660: _I('pegar pelo jogador (vtable +0x9C com o jogador) (?)', 'picked up by the player (vtable +0x9C with the player) (?)'),
    # PT: "action objects" (Speech Player, Damage/Adrenaline/Reputation…): alvo pelo p0 / EN: target chosen by p0
    0x6DB8E510: _I('executar (alvo: p0 = 0 quem mandou, 1 jogador, 2 os links)', 'run (target: p0 = 0 sender, 1 player, 2 the links)'),
    # PT: NPCs / EN: NPCs
    0x6DBE1E10: _I('ativar (limpa a flag 0x10000)', 'enable (clears flag 0x10000)'),
    0x6DBE2790: _I('desativar (liga a flag 0x10000)', 'disable (sets flag 0x10000)'),
    0x6DBE30D0: _I('virar pedaços (usa p116) (?)', 'gib (uses p116) (?)'),
    0x6DBE4EA0: _I('cria o objeto do p163 (padrão StartSound) (?)', 'spawn the p163 object (default StartSound) (?)'),
}

# PT: saídas herdadas, pela função que dispara / EN: inherited outputs, by the firing function
BaseOutputs = {
    (0x6DBA31B0, 15): _O('sofreu dano (dano > 0)', 'damaged (damage > 0)'),
    (0x6DB9B410, 21): _O('destruído (vida ≤ 0)', 'destroyed (health ≤ 0)'),
    (0x6DBBA360, 27): _O('usado pelo jogador', 'used by the player'),        # vtable +0xEC, chamado pelo Player
    (0x6DBBD440, 53): _O('voltou a aparecer (?)', 'reappeared (?)'),
    (0x6DBBDDB0, 54): _O('pego (som p48, some)', 'picked up (sound p48, hidden)'),
    (0x6DBE2620, 28): _O('morreu', 'died'),
    (0x6DBE5D00, 28): _O('morreu', 'died'),
    (0x6DBE2F70, 28): _O('morreu', 'died'),
}

# PT: por classe / EN: per class
# PT: classes do motor (Suffering.exe): mapas de mensagens registrados no construtor (vt+0x34), mesmo formato -1, P,
#     função; os mapas são montados por inicializadores estáticos em 0x5878xx (nota 9z8).
# EN: engine (exe) classes: message maps registered by their constructors, same -1, P, handler format (note 9z8).
EngineInputs = {
    0x6968CE68: [2, 3, 4],   # Lighting Effect, mapa 0x5BA480
    0x7DFFD694: [4, 5],      # Point Light, 0x5BA500
    0x7578F3F7: [4, 5],      # Ambient Light, 0x5BA558
    0x6B110672: [4, 5],      # Directional Light, 0x5BA5B0
    0x54E01F83: [4, 5],      # Spot Light, 0x5BA648
    0x5B0BAD74: [5, 6],      # Portal, 0x5BA3E8
}

ClassSlots = {
    0x6968CE68: {  # Lighting Effect (0x4C49D0 / 0x4C49F0 / 0x4C4A20)
        2: _I('ligar (anima as luzes ligadas)', 'on (animates the linked lights)'), 3: _I('desligar', 'off'), 4: _I('destruir', 'destroy'),
        0: ('Ativo no início', 'Active at start'), 1: ('Repetir a curva (0 = uma volta)', 'Loop the curve (0 = one pass)'),
        6: ('Cor A', 'Colour A'), 7: ('Cor B', 'Colour B'), 8: ('Curva da cor (.wdu): A → B', 'Colour curve (.wdu): A → B'),
        9: ('Raio A', 'Radius A'), 10: ('Raio B', 'Radius B'), 11: ('Curva do raio (.wdu): A → B', 'Radius curve (.wdu): A → B'),
        12: ('Spot: valor A (?)', 'Spot: value A (?)'), 13: ('Spot: valor B (?)', 'Spot: value B (?)'), 14: ('Spot: curva', 'Spot: curve'),
        15: ('Spot: valor A 2 (?)', 'Spot: value A 2 (?)'), 16: ('Spot: valor B 2 (?)', 'Spot: value B 2 (?)'), 17: ('Spot: curva 2', 'Spot: curve 2'),
    },
    0x7DFFD694: {  # Point Light (0x4C6150 / 0x4C6190)
        4: _I('acender', 'light on'), 5: _I('apagar', 'light off'),
        3: ('Animador (modelo de Lighting Effect criado com a luz)', 'Animator (Lighting Effect template spawned with the light)'),
    },
    0x7578F3F7: {4: _I('ligar', 'on'), 5: _I('desligar', 'off')},   # Ambient Light (0x4C5D80 / 0x4C67B0)
    0x6B110672: {4: _I('ligar', 'on'), 5: _I('desligar', 'off')},   # Directional Light (0x4C5E30 / 0x4C69E0)
    0x54E01F83: {4: _I('ligar (?)', 'on (?)'), 5: _I('desligar (?)', 'off (?)')},   # Spot Light: vt+0x44 / vt+0x48
    0x5B0BAD74: {5: _I('abrir (?) — tira a flag 1 das duas salas', 'open (?) — clears flag 1 of both rooms'),
                 6: _I('fechar (?) — põe a flag 1 nas duas salas', 'close (?) — sets flag 1 on both rooms')},   # Portal
    0xCA9F664A: {  # Timer
        2: ('Tempo (s)', 'Time (s)'), 3: ('Variação aleatória do tempo (± s) (?)', 'Random time variation (± s) (?)'),
        4: ('Repetir', 'Repeat'), 5: ('Se destruir ao disparar', 'Destroy itself when it fires'),
        6: _I('começar (se ativado)', 'start (if enabled)'), 7: _I('parar (sorteia o tempo de novo)', 'stop (time drawn again)'),
        8: _I('ativar', 'enable'), 9: _I('desativar (e parar)', 'disable (and stop)'), 11: _O('tempo esgotado', 'time is up'),
    },
    0x3F0D4EB2: {  # Detector
        2: ('Uma vez: um objeto por vez; some quando ele sai', 'Once: one object at a time; removed when it leaves'),
        4: _I('ativar', 'enable'), 5: _I('desativar (esquece quem está dentro)', 'disable (forgets who is inside)'),
        6: _I('se destruir (esquece quem está dentro)', 'destroy itself (forgets who is inside)'),
        7: _O('algo entrou', 'something entered'), 8: _O('quem já está dentro tocou de novo', 'something inside touched again'),
        9: _O('algo saiu', 'something left'),
    },
    0x10C956B7: {  # Count Down To Zero
        0: ('Valor inicial', 'Start value'), 1: ('Se destruir ao chegar a zero', 'Destroy itself at zero'),
        2: ('Avisar no próximo quadro (?)', 'Fire on the next update (?)'),
        3: _I('somar 1', 'add 1'), 4: _I('subtrair 1', 'subtract 1'), 5: _I('voltar ao valor inicial', 'reset to the start value'),
        6: _O('chegou a zero', 'reached zero'),
    },
    0x83A8B1D9: {  # Visibility Toggler
        1: _I('mostrar os links', 'show the links'), 2: _I('esconder os links', 'hide the links'), 3: _I('alternar os links', 'toggle the links'),
    },
    0xB8B2FD1F: {  # Behavior Changer
        3: ('Tirar links de NPCs mortos', 'Drop links to dead NPCs'),
        11: _I('aplicar (manda a troca de comportamento aos links)', 'apply (sends the behaviour change to the links)'),
        12: _I('desativar', 'disable'), 13: _I('ativar (se ainda tem usos)', 'enable (if uses are left)'),
        15: _I('pré-carregar (?)', 'prefetch (?)'), 16: _I('pré-carregar tudo (?)', 'prefetch all (?)'),
    },
    0x9AA22111: {44: _I('acender', 'light on'), 45: _I('apagar', 'light off')},  # Light Housing
    0xD8E872CE: {  # Security Monitor
        44: _I('ligar', 'on'), 45: _I('desligar', 'off'), 70: _I('desativar (flag 0x4000) (?)', 'disable (flag 0x4000) (?)'),
        71: _I('ativar (?)', 'enable (?)'), 72: _O('jogador começou a olhar (?)', 'player started watching (?)'),
        73: _O('jogador parou de olhar (?)', 'player stopped watching (?)'),
    },
    0x3F4C759C: {  # Switch
        61: _I('ligar (padrão On) (?)', 'turn on (default On) (?)'), 62: _I('desligar (padrão Off) (?)', 'turn off (default Off) (?)'),
        64: _O('ligou', 'turned on'), 65: _O('desligou', 'turned off'),
    },
    0xDD88E091: {8: _I('ativar', 'enable'), 9: _I('desativar', 'disable')},  # Ambient Creature Waypoint
    0x86A01249: {  # Animating Static
        42: _I('ativar', 'enable'), 43: _I('desativar', 'disable'), 44: _I('tocar animação (sorteia da lista p40)', 'play animation (random from p40)'),
        45: _I('criar os objetos anexados (?)', 'spawn the attached objects (?)'), 46: _I('destruir os objetos anexados', 'destroy the attached objects'),
        47: _I('(?) zera +0x4A', '(?) clears +0x4A'), 48: _I('(?) liga +0x4A', '(?) sets +0x4A'),
    },
    0x1D84210F: {19: _I('acender', 'ignite'), 20: _I('apagar (rampa com p10) (?)', 'put out (ramp with p10) (?)')},  # Fire
    0xBE08B1A0: {  # Object Generator
        32: _I('ligar', 'on'), 33: _I('desligar', 'off'), 34: _I('alternar', 'toggle'), 35: _I('pré-carregar os objetos (p0)', 'prefetch the objects (p0)'),
    },
    0x7EA6E450: {50: _I('ligar', 'on'), 51: _I('desligar', 'off'), 52: _I('terminar (p17 = 0: some na hora)', 'finish (p17 = 0: removed at once)')},  # Particle Fountain
    0x453EE273: {7: _I('pré-carregar as falas (p5)', 'prefetch the lines (p5)')},  # Speech Player
    0x973720C0: {  # Object Cloner
        11: _I('ligar', 'on'), 12: _I('desligar', 'off'), 13: _I('clonar agora', 'clone now'),
        15: _O('clonou', 'cloned'), 16: _O('acabaram os clones (p1)', 'clone count used up (p1)'),
        17: _O('todos os clones sumiram (e se destrói)', 'all clones gone (and destroys itself)'),
    },
    0x38ACC9A1: {  # STOMP Player
        4: _I('pré-carregar a sequência', 'prefetch the sequence'), 5: _I('tocar', 'play'),
        6: _I('parar (se não está tocando, se destrói)', 'stop (if not playing, destroys itself)'), 7: _O('terminou', 'finished'),
    },
    0x21C015A3: {  # Screen Fader
        13: _I('(?) liga +0x1E (padrão Test)', '(?) sets +0x1E (default Test)'), 15: _I('começar / próxima etapa', 'start / next stage'),
        16: _I('pré-carregar (textura p6, som p9)', 'prefetch (texture p6, sound p9)'), 17: _O('terminou (?)', 'finished (?)'),
    },
    0xDF14E5A3: {1: _I('pré-carregar os objetos da lista p0', 'prefetch the objects in p0')},  # Instance Prefetcher
    0x8B3CE12E: {  # Time Scale
        0: ('Velocidade (%)', 'Speed (%)'), 1: ('Tempo para chegar (s)', 'Time to reach it (s)'), 2: ('Tempo para voltar (s)', 'Time to return (s)'),
        3: _I('mudar a velocidade do jogo (p0 % em p1 s)', 'change game speed (p0 % over p1 s)'), 4: _I('voltar ao normal (em p2 s)', 'back to normal (over p2 s)'),
    },
    0x36E88832: {32: _I('começar (?)', 'start (?)'), 33: _I('parar (?)', 'stop (?)')},  # Ambient Creature
    0x2C3BC493: {12: _I('ligar', 'on'), 13: _I('desligar (some em p11)', 'off (fades over p11)')},  # Screen Blur
    0xAA7D6985: {  # Invisible Static Object
        7: _I('ligar (limpa a flag 0x400000)', 'on (clears flag 0x400000)'), 8: _I('desligar (liga a flag 0x400000)', 'off (sets flag 0x400000)'),
    },
    0x08A4DE62: {0: _I('salvar o jogo', 'save the game')},  # Autosave
    0x7FE56467: {  # EdgeToggler
        1: _I('marcar a ligação de caminho (flag 0x80) (?)', 'mark the path edge (flag 0x80) (?)'),
        2: _I('desmarcar a ligação de caminho (?)', 'unmark the path edge (?)'),
    },
    0x6506A1BA: {6: _I('tremer (duração p2)', 'shake (duration p2)')},  # Camera Shake
    0xECA9EA64: {3: _I('trocar (neblina p0, céu p1)', 'switch (fog p0, sky p1)'), 4: _I('voltar ao anterior', 'go back to the previous one')},
    0xD61BC46F: {15: _I('ligar (?)', 'on (?)'), 16: _I('desligar (?)', 'off (?)'), 17: _I('(?) vtable +0x54', '(?) vtable +0x54')},  # Volumetric Rain
    0xA019FCED: {15: _I('ligar (?)', 'on (?)'), 16: _I('desligar (?)', 'off (?)'), 17: _I('(?) vtable +0x54', '(?) vtable +0x54')},  # Volumetric Fog
    0x97844105: {1: _I('desativar (?)', 'disable (?)'), 2: _I('ativar (?)', 'enable (?)')},  # Ranged Targeting Position
    0x10BD8382: {10: _I('trocar de fase', 'change level'), 11: _I('(?) liga +0x10', '(?) sets +0x10'), 12: _I('(?) zera +0x10', '(?) clears +0x10')},
    0xE8B96B57: {0: _I('pré-carregar', 'prefetch')},  # Node Prefetcher
    0x2FB36366: {4: _I('liberar entrada no Archives', 'unlock an Archives entry')},  # Archives Trigger
    0x04CB8BE8: {13: _I('ligar', 'on'), 14: _I('desligar', 'off'), 15: _I('(?) esconde o objeto projetado', '(?) hides the projected object'), 16: _I('(?)', '(?)')},
    0x5FEBD8E9: {30: _I('travar', 'lock'), 31: _I('destravar', 'unlock')},  # Pushable
    0xBD83621B: {11: _I('tocar', 'play'), 12: _I('parar (fade p4)', 'stop (fade p4)')},  # Flying Sound
    0x85449C44: {9: _I('mostrar', 'show'), 11: _I('fechar e se destruir', 'close and destroy itself'), 12: _O('fechado', 'closed')},  # Help Popup
    0xE4002F8D: {  # Phone
        39: _I('tocar (chamar)', 'ring'), 40: _I('parar de tocar', 'stop ringing'), 41: _I('usar o grupo de falas 1', 'use dialogue bank 1'),
        42: _I('usar o grupo de falas 2', 'use dialogue bank 2'), 43: _I('usar o grupo de falas 3', 'use dialogue bank 3'),
        44: _I('limpar o grupo de falas', 'clear the dialogue bank'),
    },
    0x5556A86A: {  # Action Dialog
        24: _I('ligar no NPC linkado', 'attach to the linked NPC'), 25: _I('soltar do NPC', 'detach from the NPC'),
        26: _I('(?) liga a flag 0x80', '(?) sets flag 0x80'), 27: _I('(?) limpa a flag 0x80', '(?) clears flag 0x80'),
        28: _I('remover e se destruir', 'remove and destroy itself'), 29: _I('(?) liga a flag 4', '(?) sets flag 4'),
    },
    0xAAAD15CA: {10: _I('tocar', 'play'), 11: _I('pré-carregar', 'prefetch'), 12: _I('parar', 'stop')},  # Movie Player
    0x53748F71: {27: _I('assumir (?)', 'take over (?)'), 28: _I('soltar (?)', 'release (?)'), 29: _I('soltar e se destruir', 'release and destroy itself')},
    0xCD739B63: {11: _I('tocar esta música de combate', 'play this combat music')},  # Combat Music
    0x4A1EB7A1: {1: _I('ligar', 'on')},  # Level Transition Remover
    0x64254E79: {7: _I('ligar (no jogador)', 'on (on the player)'), 8: _I('desligar', 'off')},  # Insanity Screen Flash
    0xAB9213ED: {  # Allow Player Insanity Object
        3: _I('limpa a flag 0x80 do Player (?)', 'clears Player flag 0x80 (?)'), 4: _I('limpa a flag 0x100 do Player (?)', 'clears Player flag 0x100 (?)'),
        5: _I('liga as flags 0x80 e 0x100 do Player (?)', 'sets Player flags 0x80 and 0x100 (?)'),
    },
    0x1589A3E3: {  # Mechanism
        59: _I('canal A: posição 0', 'channel A: position 0'), 60: _I('canal A: posição 1', 'channel A: position 1'),
        61: _I('canal A: parar (?)', 'channel A: stop (?)'), 62: _I('canal A: ir à outra posição (?)', 'channel A: go to the other position (?)'),
        63: _I('canal B: posição 0', 'channel B: position 0'), 64: _I('canal B: posição 1', 'channel B: position 1'),
        65: _I('canal B: parar (?)', 'channel B: stop (?)'), 66: _I('canal B: ir à outra posição (?)', 'channel B: go to the other position (?)'),
    },
    0xB51C3DA1: {  # MorphingModel
        16: _I('começar', 'start'), 17: _I('sentido normal', 'forward'), 18: _I('sentido inverso', 'reverse'),
        19: _I('(?) liga a flag 0x200', '(?) sets flag 0x200'), 20: _I('(?) continua se a flag 0x100', '(?) resumes if flag 0x100'),
        21: _I('parar', 'stop'), 22: _I('inverter o sentido', 'flip direction'), 23: _I('voltar ao início (e parar)', 'reset (and stop)'),
        14: _O('chegou ao fim (?)', 'reached the end (?)'),
    },
    0x19E0722B: {1: _I('trocar o mapa (p0)', 'switch the map (p0)')},  # Map Switcher
}
ClassSlots[0x3C3D9695] = ClassSlots[0xB51C3DA1]   # DripMorphingModel: mesmas funções / same handlers

# PT: classes NPC (entradas 26/27/136/137): saídas pela mensagem padrão do template, conferidas onde indicado
# EN: NPC classes: outputs
NpcOutputs = {
    15: _O('sofreu dano', 'damaged'), 28: _O('morreu', 'died'), 31: _O('(?) padrão ISeeYou', '(?) default ISeeYou'),
    35: _O('atingido pelo jogador (?)', 'hit by the player (?)'),
}


def SlotName(ClassId, Index, IsTTB):
    """PT: (nome PT, nome EN) de um slot de mensagem, ou None. EN: (PT, EN) name of a message slot, or None."""
    if IsTTB:
        return None
    Names = ClassSlots.get(ClassId, {})
    if Index in Names:
        return Names[Index]
    Row = Handlers.get('TS1', {}).get(ClassId)
    if not Row:
        return None
    Handler = Row['Inputs'].get(str(Index))
    if Handler and int(Handler, 16) in BaseInputs:
        return BaseInputs[int(Handler, 16)]
    for Site in Row['OutputSites'].get(str(Index), []):
        if (int(Site, 16), Index) in BaseOutputs:
            return BaseOutputs[(int(Site, 16), Index)]
    if '136' in Row['Inputs'] and Index in NpcOutputs:
        return NpcOutputs[Index]
    return None
