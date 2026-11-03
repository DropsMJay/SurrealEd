"""
RiotProperties — flags e propriedades das instâncias / instance flags and properties
====================================================================================

PT-BR
-----
Flags da instância (u32 logo depois da posição, no .lvl 0x0020). Leitura em lvl_ReadInstance (0x45A5C0).
Vários bits funcionam em pares "sobrescrever + valor": se o bit de sobrescrever está desligado, o valor vem
do template (flags do objeto-template, +0x20 dele em memória).

    0x00000001  Visível ...................... vai para objeto+0xC bit 0x8000000; só instâncias visíveis são desenhadas
    0x00000008  Excluída / desativada ........ testado junto com (0x10000 << n), um bit por variante (dificuldade
                                                ou plataforma?) — hipótese
    0x00000010  Tem valor extra .............. lê um u32/f32 a mais logo depois das flags (padrão 0x5F0AC723)
    0x00000080  (?) .......................... muito comum (54% das instâncias da 1a); não é lido por lvl_ReadInstance
    0x00000100  Tem escala ................... lê 3 f32 de escala
    0x00000200  (?) .......................... muito comum (49%); não é lido por lvl_ReadInstance
    0x00000400  Projeta sombra dinâmica ...... só vale com 0x1000; vira objeto+8 bit 0x1000000, testado pelo
                                                gerenciador de sombras (0x492A00, shadow_Render 0x4CD550)
    0x00000800  (par do 0x400) ............... só vale com 0x1000; objeto+8 bit 0x2000000 (usado na animação) — sentido aberto
    0x00001000  Sobrescrever sombra .......... usa 0x400/0x800 da instância em vez do template
    0x00002000  Sobrescrever grupo B ......... usa 0x4000 e 0x1000000 da instância
    0x00004000  (grupo B, 1º) ................ objeto+8 bit 0x80000 (desliga uma atualização por quadro) — sentido aberto
    0x00008000  Modelo próprio ............... bloco com ref de modelo + esfera + matriz (a TTB monta a arquitetura assim)
    0x00100000  (campo de 2 bits, 1º) ........ objeto+0x10 bit 8 — sentido aberto
    0x00200000  (campo de 2 bits, 2º) ........ objeto+0x10 bit 0x10 — sentido aberto
    0x00400000  (grupo C) .................... só vale com 0x800000; objeto+0x10 bit 0x20, usado na árvore de células
    0x00800000  Sobrescrever grupo C
    0x01000000  (grupo B, 2º) ................ objeto+8 bit 0x20000 — sentido aberto
    0x02000000  ............................... objeto+0x10 bit 0x400 — sentido aberto
    0x10000000  ............................... com o campo 0x300000: objeto+0x10 bit 0x4000 — sentido aberto

Propriedades: um valor de 4 bytes por propriedade da classe (tipos em RiotClasses). A instância guarda só as
que ela muda: nValores × u32 + nPropriedades × u16 índices. Propriedades-array (bit 0x1000 no tipo) guardam
(contagem << 16) | deslocamento e os itens ficam depois dos valores diretos. Os nomes das propriedades não
existem nos arquivos; os poucos nomes abaixo foram deduzidos (dados + executável).

EN
--
Instance flags (u32 after the position in .lvl 0x0020), read by lvl_ReadInstance (0x45A5C0). Several bits are
"override + value" pairs: without the override bit the value comes from the template. 0x400 (with 0x1000) is
"casts dynamic shadow" (object+8 bit 0x1000000, checked by the shadow manager). Unknown meanings are marked.
Properties: one 4-byte value per class property; the instance stores only the ones it overrides. Array
properties (type bit 0x1000) store (count << 16) | offset. Property names are not stored in the files.
"""
import json
import os
import struct

# PT: nomes das mensagens tirados do .rfl (Tools/RiotMessageNames.py) / EN: message names read from the .rfl
try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'RiotMessageNames.json'), encoding='utf-8') as _Handle:
        MessageNames = {Game: {int(Id): Name for Id, Name in Names.items()} for Game, Names in json.load(_Handle).items()}
except (OSError, ValueError):
    MessageNames = {}


# PT: entradas/saídas de mensagem por classe (Ghidra/Atlas/RiotMessageMaps.py) / EN: message slots per class
try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'RiotMessageMaps.json'), encoding='utf-8') as _Handle:
        MessageMaps = {Game: {int(Id, 16): Row for Id, Row in Rows.items()} for Game, Rows in json.load(_Handle).items()}
except (OSError, ValueError):
    MessageMaps = {}


def MessageSlots(ClassId, IsTTB):
    """PT: {'inputs', 'outputs', 'fixed'} de uma classe. EN: Message slots of a class."""
    return MessageMaps.get('TTB' if IsTTB else 'TS1', {}).get(ClassId) or {'inputs': [], 'outputs': [], 'fixed': []}


def MessageName(Id, IsTTB):
    """PT: Nome de uma mensagem (ou None). EN: Message name (or None)."""
    return MessageNames.get('TTB' if IsTTB else 'TS1', {}).get(Id)

# (bit, nome PT, nome EN, confirmado?)
InstanceFlagBits = [
    # PT: lvl_ReadInstance (0x45A5C0); nomes conferidos com o projeto "the-suffering-engine" (docs/re/object-model.md §2)
    # EN: lvl_ReadInstance (0x45A5C0); names cross-checked with "the-suffering-engine"
    (0x00000001, 'Visível no início', 'Shown at start', True),
    (0x00000008, 'Nunca criado (com 0x10000 << dificuldade)', 'Never created (with 0x10000 << difficulty)', True),
    (0x00000010, 'Distância de desenho própria (f32)', 'Own draw distance (f32)', True),
    (0x00000080, 'Só do editor (não lido pelo jogo)', 'Editor only (not read by the game)', True),
    (0x00000100, 'Tem escala', 'Has scale', True),
    (0x00000200, 'Só do editor (sempre com 0x80)', 'Editor only (always with 0x80)', True),
    (0x00000400, 'Projeta sombra dinâmica', 'Casts dynamic shadow', True),
    (0x00000800, 'Flag de sombra 2 (bit 1 do template; malhas estáticas, portas)', 'Shadow flag 2 (template bit 1; static meshes, doors)', False),
    (0x00001000, 'Sobrescrever sombra do template', 'Override template shadow', True),
    (0x00002000, 'Sobrescrever grupo B (bits 6/10 do template)', 'Override group B (template bits 6/10)', True),
    (0x00004000, 'Grupo B: sem atualização por quadro', 'Group B: no per-frame update', False),
    (0x00008000, 'Modelo/limites próprios', 'Own model / bounds', True),
    (0x00010000, 'Excluído na dificuldade 0', 'Excluded on difficulty 0', False),
    (0x00020000, 'Excluído na dificuldade 1', 'Excluded on difficulty 1', False),
    (0x00040000, 'Excluído na dificuldade 2', 'Excluded on difficulty 2', False),
    (0x00100000, 'Campo D, bit 1 (bits 8/9 do template)', 'Field D, bit 1 (template bits 8/9)', False),
    (0x00200000, 'Campo D, bit 2 (bits 8/9 do template)', 'Field D, bit 2 (template bits 8/9)', False),
    (0x00400000, 'Grupo C: células', 'Group C: cells', False),
    (0x00800000, 'Sobrescrever grupo C (bit 7 do template)', 'Override group C (template bit 7)', True),
    (0x01000000, 'Grupo B, 2º', 'Group B, 2nd', False),
    (0x02000000, 'Objeto +0x10 bit 0x400', 'Object +0x10 bit 0x400', False),
    (0x10000000, 'Substitui o bit 0x800 do template (com o campo D)', 'Replaces template bit 0x800 (with field D)', False),
]

TypeNames = {0x0001: 'int/bool', 0x0002: 'float', 0x0003: 'ref', 0x0005: 'resource ref', 0x0015: 'float (21)', 0x0007: 'int (7)', 0x000A: 'int (10)',
             0x000E: 'texture ref', 0x000F: 'color', 0x0011: 'enum (17)', 0x2003: 'ref', 0x3003: 'ref[]', 0x4003: 'ref', 0x5003: 'ref[]'}

# PT: nomes deduzidos (classe -> {índice: (PT, EN)}); TTB pode ter índices deslocados.
# EN: deduced names (class -> {index: (PT, EN)}); TTB may shift indexes.

# PT: efeitos (TS1), deduzidos do código do Suffering.rfl e do sistema de partículas do .exe (notas, seção 9r).
#     "(?)" = provável, ainda não confirmado no jogo.
# EN: effects (TS1), from Suffering.rfl code and the .exe particle system (notes section 9r). "(?)" = probable.
ParticleFountainNames = {
    0: ('Emitir da superfície do modelo', 'Emit from model surface'),
    1: ('Escala do tamanho (× 2048)', 'Size scale (× 2048)'),
    2: ('Desacelerar ao longo da vida', 'Slow down over lifetime'),
    3: ('Velocidade das partículas', 'Particle speed'),
    4: ('Ângulo inicial do emissor A (?)', 'Emitter start angle A (?)'),
    5: ('Ângulo inicial do emissor B (?)', 'Emitter start angle B (?)'),
    6: ('Giro do emissor A por segundo (?)', 'Emitter spin A per second (?)'),
    7: ('Giro do emissor B por segundo (?)', 'Emitter spin B per second (?)'),
    8: ('Ângulo de espalhamento (graus)', 'Spread angle (degrees)'),
    9: ('Giro do objeto (graus/s)', 'Object spin (degrees/s)'),
    10: ('Duração da emissão (s; 0 = sempre)', 'Emission duration (s; 0 = forever)'),
    11: ('Volume/alcance do som (?)', 'Sound volume/range (?)'),
    12: ('Som ao começar', 'Start sound'),
    13: ('Som em loop', 'Loop sound'),
    14: ('Começa ligado', 'Starts on'),
    15: ('Preso ao osso do dono', 'Attached to owner bone'),
    16: ('Reiniciar sem dono (?)', 'Restart without owner (?)'),
    17: ('Mensagem/estado (?)', 'Message/state (?)'),
    18: ('Dano por segundo', 'Damage per second'),
    19: ('Tipo de dano', 'Damage type'),
    20: ('Força do impacto (?)', 'Hit force (?)'),
    21: ('Efeito no atingido (BurnFX…)', 'Effect on hit (BurnFX…)'),
    23: ('Eixo de emissão (0 X, 1 Y, 2 Z)', 'Emission axis (0 X, 1 Y, 2 Z)'),
    24: ('Eixo secundário (?)', 'Secondary axis (?)'),
    25: ('Flag 0x200000 do emissor (?)', 'Emitter flag 0x200000 (?)'),
    26: ('Emissão a distância (%) (?)', 'Far emission (%) (?)'),
    29: ('Distância de emissão plena (?)', 'Full emission distance (?)'),
    30: ('Distância máxima (× 2048)', 'Max distance (× 2048)'),
    31: ('Valor para o emissor +0x20 (?)', 'Emitter +0x20 value (?)'),
    32: ('Forçar modo completo (?)', 'Force full mode (?)'),
    33: ('Cor inicial', 'Start colour'),
    34: ('Cor final', 'End colour'),
    35: ('Cor muda ao longo da vida', 'Colour changes over lifetime'),
    36: ('Texturas (uma ao acaso por partícula)', 'Textures (one at random per particle)'),
    37: ('Tamanho mínimo', 'Min size'),
    38: ('Tamanho máximo', 'Max size'),
    39: ('Crescimento do tamanho por segundo', 'Size growth per second'),
    40: ('Vida da partícula (s)', 'Particle lifetime (s)'),
    41: ('Tempo de desaparecer (s)', 'Fade-out time (s)'),
    42: ('Tempo de aparecer (s)', 'Fade-in time (s)'),
    43: ('Gravidade (escala)', 'Gravity (scale)'),
    44: ('Vento (escala)', 'Wind (scale)'),
    45: ('Partículas por emissão (?)', 'Particles per burst (?)'),
    46: ('Mistura (0 normal, 1 aditiva, 2 subtrativa?, 3 cor fixa)', 'Blend (0 normal, 1 additive, 2 subtractive?, 3 fixed colour)'),
    47: ('Flag 0x200 do emissor (?)', 'Emitter flag 0x200 (?)'),
    48: ('Atrito (velocidade × 0,95 por quadro)', 'Drag (velocity × 0.95 per frame)'),
    49: ('Rotação das partículas (graus)', 'Particle rotation (degrees)'),
}
FireNames = {
    0: ('Começa aceso', 'Starts lit'),
    3: ('Escala inicial X', 'Start scale X'), 4: ('Escala inicial Y', 'Start scale Y'), 5: ('Escala inicial Z', 'Start scale Z'),
    6: ('Escala final X', 'Full scale X'), 7: ('Escala final Y', 'Full scale Y'), 8: ('Escala final Z', 'Full scale Z'),
    10: ('Tempo para crescer (s) (?)', 'Grow time (s) (?)'), 11: ('Intensidade inicial (?)', 'Start intensity (?)'),
    12: ('Intensidade final (?)', 'Full intensity (?)'), 14: ('Tempo para apagar (s) (?)', 'Die-down time (s) (?)'),
    16: ('Dano', 'Damage'), 17: ('Tipo/força do dano (?)', 'Damage type/force (?)'), 18: ('Efeito no atingido (BurnFX)', 'Effect on hit (BurnFX)'),
    19: ('Repetir (0 = some no fim)', 'Repeat (0 = removed at the end)'),
}
ScreenFaderNames = {
    0: ('Tempo de aparecer (s)', 'Fade-in time (s)'), 1: ('Tempo parado (s)', 'Hold time (s)'), 2: ('Tempo de sumir (s)', 'Fade-out time (s)'),
    3: ('Começa ligado', 'Starts on'), 4: ('Remover no fim', 'Remove at the end'), 6: ('Textura/efeito de tela', 'Screen texture/effect'),
    7: ('Cor', 'Colour'), 8: ('Opacidade máxima', 'Max opacity'), 9: ('Recurso extra (?)', 'Extra resource (?)'), 10: ('Etapa que dispara evento (?)', 'Stage that fires an event (?)'),
}
CameraShakeNames = {
    2: ('Duração (s)', 'Duration (s)'), 4: ('Amplitude (× 2048)', 'Amplitude (× 2048)'), 5: ('Raio de alcance (× 2048)', 'Falloff radius (× 2048)'),
}
ObjectGeneratorNames = {
    0: ('Objetos gerados (lista)', 'Generated objects (list)'), 1: ('Quantidade de cada objeto', 'Count of each object'),
    3: ('Gerado pertence ao dono (?)', 'Spawned belongs to owner (?)'), 5: ('Flag 2 (?)', 'Flag 2 (?)'),
    10: ('Inclinação X (graus)', 'Tilt X (degrees)'), 11: ('Giro Y (graus)', 'Turn Y (degrees)'), 12: ('Rolagem Z (graus)', 'Roll Z (degrees)'),
    13: ('Variação aleatória A (?)', 'Random variation A (?)'), 14: ('Variação aleatória B (?)', 'Random variation B (?)'),
    15: ('Cone: ângulo mínimo (graus)', 'Cone: min angle (degrees)'), 16: ('Cone: ângulo máximo (graus; 0 = sem cone)', 'Cone: max angle (degrees; 0 = no cone)'),
    17: ('Distância à frente', 'Forward offset'), 18: ('Alinhar à direção', 'Align to direction'), 19: ('Eixo do giro aleatório', 'Random spin axis'),
    20: ('Giro aleatório (±)', 'Random spin (±)'), 21: ('Intervalo (0 = de uma vez) (?)', 'Interval (0 = all at once) (?)'),
    23: ('Máximo de objetos vivos', 'Max objects alive'), 24: ('Começa ligado', 'Starts on'), 25: ('Objeto que segue (Follower)', 'Follower object'),
    27: ('Usar orientação do dono', 'Use owner orientation'), 28: ('Distância máxima ao jogador (× 2048)', 'Max distance to player (× 2048)'),
    29: ('Limite vertical acima (× 2048) (?)', 'Vertical limit above (× 2048) (?)'), 30: ('Limite vertical abaixo (× 2048) (?)', 'Vertical limit below (× 2048) (?)'),
}

KnownNamesTS1 = {
    0x7EA6E450: ParticleFountainNames, 0x1D84210F: FireNames, 0x21C015A3: ScreenFaderNames, 0x6506A1BA: CameraShakeNames,
    0xBE08B1A0: ObjectGeneratorNames,
    0x7DFFD694: {0: ('Cor', 'Colour', 0x000F), 3: ('Animador de luz', 'Light animator', 0x2003), 6: ('Ligada', 'Enabled', 0x0001), 8: ('Raio / intensidade', 'Radius / intensity', 0x0002), 9: ('Modo (0/1/2)', 'Mode (0/1/2)', 0x0001)},
    0xBFD00933: {14: ('Sombra: início do fade', 'Shadow fade start'), 15: ('Sombra: fim do fade', 'Shadow fade end')},
    0xECA9EA64: {0: ('Sky Properties', 'Sky Properties'), 1: ('Segunda referência', 'Second reference'), 2: ('Tempo de transição (s)', 'Transition time (s)')},
}
KnownNamesTTB = {
    0x1D84210F: FireNames, 0x21C015A3: ScreenFaderNames, 0x6506A1BA: CameraShakeNames, 0xBE08B1A0: ObjectGeneratorNames,
    0x7DFFD694: {0: ('Cor', 'Colour', 0x000F), 7: ('Ligada', 'Enabled', 0x0001), 9: ('Raio / intensidade', 'Radius / intensity', 0x0002)},
}


def _Float(Value):
    return struct.unpack('<f', struct.pack('<I', Value & 0xFFFFFFFF))[0]


def GuessText(Value):
    """
    PT: Para classes do motor sem tipos conhecidos: mostra como float se parecer float, senão como inteiro, e o hex.
    EN: For engine classes without known types: float if it looks like one, otherwise integer, plus hex.
    """
    Float = _Float(Value)
    Exponent = (Value >> 23) & 0xFF
    if Value and 100 < Exponent < 160 and Float == Float:
        return '%.6g  (0x%08X)' % (Float, Value)
    return '%d  (0x%08X)' % (Value - 0x100000000 if Value >= 0x80000000 else Value, Value)


def FormatValue(Type, Value, Items=None, IsTTB=False):
    """PT: Texto de exibição de um valor bruto conforme o tipo. EN: Display text of a raw value by type."""
    if Type == 0x0011 and Items is None and MessageName(Value, IsTTB):
        return '%d · %s' % (Value, MessageName(Value, IsTTB))
    if Type == 0 and Items is None:
        return GuessText(Value)
    if Items is not None:
        if Type & 0x2000 or Type in (0x3003, 0x5003):
            return '[' + ', '.join(FormatRef(Item) for Item in Items) + ']'
        return '[' + ', '.join(str(Item) for Item in Items) + ']'
    if Type in (0x0002, 0x0015, 0x0016):
        return ('%.6g' % _Float(Value))
    if Type == 0x000F:
        return '#%06X' % (Value & 0xFFFFFF) + ((' α%02X' % (Value >> 24)) if Value >> 24 else '')
    if Type & 0x6000 or Type in (0x0003, 0x0005, 0x000E):
        return FormatRef(Value)
    if Value >= 0x80000000:
        return '%d' % (Value - 0x100000000)
    return str(Value)


def FormatRef(Value):
    if not Value:
        return '—'
    return '%d_%04x' % (Value >> 16, Value & 0xFFFF)


def _ArrayItems(Words, Header):
    Offset, Count = Header & 0xFFFF, Header >> 16
    if Count and Offset + Count <= len(Words):
        return Words[Offset:Offset + Count]
    return []


def DescribeInstance(Instance, Template, ClassName, PropertyTypes, IsTTB, PositionScale, ModelRef):
    """
    PT: Tudo o que o painel de propriedades mostra sobre uma instância (dicionário pronto para JSON).
    EN: Everything the properties panel shows about one instance (JSON-ready dict).
    """
    Flags = Instance['Flags']
    FlagList = [{'Bit': Bit, 'Pt': Pt, 'En': En, 'Confirmed': Confirmed, 'On': bool(Flags & Bit)} for Bit, Pt, En, Confirmed in InstanceFlagBits]
    Unknown = Flags & ~sum(Bit for Bit, _a, _b, _c in InstanceFlagBits)
    Known = (KnownNamesTTB if IsTTB else KnownNamesTS1).get(Template.ClassId if Template else None, {})
    Overrides = {Index: Number for Number, Index in enumerate(Instance['PropertyIndexes'])}
    Slots = MessageSlots(Template.ClassId, IsTTB) if Template else MessageSlots(None, IsTTB)
    Properties = []
    Count = len(PropertyTypes) if PropertyTypes else (len(Template.Slots) if Template else 0)
    TemplateSlots = Template.Slots if Template else []
    for Index in range(Count):
        Type = PropertyTypes[Index] if PropertyTypes and Index < len(PropertyTypes) else 0
        if not Type and Index in Known and len(Known[Index]) > 2:
            Type = Known[Index][2]
        IsArray = bool(Type & 0x1000)
        Default = TemplateSlots[Index] if Index < len(TemplateSlots) else None
        DefaultText = None
        if Default is not None:
            DefaultText = FormatValue(Type, Default, _ArrayItems(TemplateSlots, Default) if IsArray else None, IsTTB)
        TypeName = '?' if not Type else TypeNames.get(Type) or (TypeNames.get(Type & ~0x1000, '0x%04X' % (Type & ~0x1000)) + '[]' if IsArray else '0x%04X' % Type)
        Effective = Instance['Values'][Overrides[Index]] if Index in Overrides and Overrides[Index] < len(Instance['Values']) else Default
        Row = {'Index': Index, 'Type': Type, 'TypeName': TypeName, 'Raw': Effective, 'TemplateRaw': Default,
               'Slot': 'in' if Index in Slots['inputs'] else 'out' if Index in Slots['outputs'] else None,
               'Default': DefaultText, 'Overridden': Index in Overrides}
        if Index in Known:
            Row['Pt'], Row['En'] = Known[Index][0], Known[Index][1]
        elif Row['Slot'] and Default is not None and Type == 0x0011:
            # PT: sem nome conhecido: nome pela mensagem padrão do template (ex.: entrada "BlowUp")
            # EN: no known name: named after the template's default message (e.g. input "BlowUp")
            Message = MessageName(Default, IsTTB) if Default else None
            Row['Pt'] = ('Entrada' if Row['Slot'] == 'in' else 'Saída') + (' "%s"' % Message if Message else '')
            Row['En'] = ('Input' if Row['Slot'] == 'in' else 'Output') + (' "%s"' % Message if Message else '')
        if Index in Overrides:
            Value = Instance['Values'][Overrides[Index]] if Overrides[Index] < len(Instance['Values']) else 0
            Row['Value'] = FormatValue(Type, Value, _ArrayItems(Instance['Values'], Value) if IsArray else None, IsTTB)
        Properties.append(Row)
    Scale = PositionScale
    return {
        'Id': Instance['Id'], 'Class': ClassName, 'ClassId': '0x%08X' % Template.ClassId if Template else None,
        'Template': '%d_%04x' % (Instance['TemplatePackage'], Instance['TemplateIndex']), 'Model': FormatRef(ModelRef),
        'Position': [round(Value / Scale, 4) for Value in Instance['Position']], 'PositionRaw': list(Instance['Position']),
        'Rotation': list(Instance['Rotation']), 'Scale': list(Instance['Scale']),
        'Flags': '0x%08X' % Flags, 'FlagList': FlagList, 'UnknownFlags': '0x%08X' % Unknown if Unknown else None,
        'Extra': None if Instance['Extra'] is None else '%.1f m' % (Instance['Extra'] / 2048.0 if not IsTTB else Instance['Extra']),
        'Links': [Link for Link in Instance['Links']], 'BakedLight': FormatRef(Instance['Tail']),
        'FixedInputs': ['%d · %s' % (Id, MessageName(Id, IsTTB) or '?') for Id in Slots['fixed'] if Id < 0x1000],
        'Properties': Properties, 'OverrideCount': len(Overrides),
    }
