"""
RiotMedia — sons, sequências STOMP e vídeos / sounds, STOMP sequences and videos
================================================================================

PT-BR
-----
Serve as abas Áudio, STOMP e Vídeo.

Sons (.sdu, leitor 0x43D8E0):
    0x0302 (60 bytes)  u32 ?, u32 volume (0–10000), u32 flags (0x8 = repetir), u32 prioridade, f ?, f distância
                       mínima, f máxima, f, f (×2048 no jogo), u32 (TTB: legenda = u16 índice, u16 pacote do .xdu),
                       u32, u16 canais, u16 bits, u32 taxa, u32 bytes
    0x0303             PCM com sinal (little-endian)
    0x0305             envelope de amplitude para a boca (25 valores por segundo; zlib se comprimido)
    TS1: a legenda vem do template "Line of Dialog" (0xCC015D52) de mesmo índice: p1 = duração, p2 = texto.

Sequências STOMP (.qdu, leitor 0x44BFD0): 0x0311 = cabeçalho + trilhas; cada trilha tem um objeto da fase
(id de instância do .lvl) e eventos no tempo (tipos abaixo). TTB: cabeçalho de 28 bytes e evento 0 com 3 f32 a mais.
    0 transformação: quaternião, posição, u32 0, u32 flags (0x10 linear / 0x20 Catmull-Rom até esta chave, nenhum =
      degrau; 0x40/0x80/0xC0 ease-out/in/in-out; 0x100/0x200/0x400 não mexe em posição/rotação/escala; 0x800 posição
      em velocidade constante), escala
    1 animação: u32 canal (tabela de hardpoints do modelo; 0 = corpo todo), ref do clipe, f32 início, f32 mistura,
      f32 velocidade, u32 flags (4 modos de root motion de 2 bits; 0x100 descarregar o clipe; 0x200 camada independente)
    3 som: ref, u16 volume (1/10000), u16 flags (0x10 = não posicional)
    4 attach: u32 trilha do objeto (0 = soltar), u32 hardpoint      5 controle: 0 = o script assume o objeto, 1 = devolve
    6 visibilidade: 0 escondido / 1 visível      7 mensagem: u32 id, u32 parâmetro, u32 flags
    9 câmera: f32 escala de tempo, u32 FOV vertical em graus (0 = mantém), u32 interpolação (3 bits)      10 marcador
    2 e 8 só existem na TTB (sentido aberto). Tabela conferida com o projeto "the-suffering-engine".

Vídeos (.vdu): 0x0342 (76 bytes) = versão, fps, duração (ms), largura, altura, bpp, tabela de blocos; 0x0343 = ASF/WMV
com o índice simples movido para o começo. Devolver o índice ao fim dá um .wmv normal. Navegadores não tocam WMV:
com o ffmpeg instalado, o servidor converte para MP4 só para a pré-visualização.

EN
--
Backs the Audio, STOMP and Video tabs (layouts above). STOMP sequences can be written back (WriteSequence; every TS1 and
TTB sequence round-trips byte-identical). Videos are WMV2: they are rebuilt as .wmv and, when ffmpeg is
available, converted to MP4 for the browser preview.
"""
import io
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import wave
import zlib

from .RiotMessageFlow import RiotMessageFlow
from .RiotScreenFx import RiotScreenFx
from .RiotPackages import RefName
from .RiotLevel import InstanceProperties, ReadInstances
from .RiotProperties import MessageName

LineOfDialog = 0xCC015D52
SoundCategories = {0: 'Effect', 1: 'Ambient', 2: 'Music', 3: 'Movie', 4: 'GUI', 5: 'GUI FX', 6: 'Dialog'}
SequenceEvents = {0: '<4f3fII3f', 1: '<II3fI', 2: '<IHH', 3: '<IHH', 4: '<II', 5: '<I', 6: '<I', 7: '<3I', 8: '<II4fI', 9: '<fII', 10: '<'}
# PT: nomes dos tipos de chave conferidos com o projeto "the-suffering-engine" (src/game/world/stomp.ts); 2 e 8 só na TTB
# EN: key type names cross-checked with "the-suffering-engine"; 2 and 8 only occur in TTB
EventNames = {0: 'Transform', 1: 'Animation', 2: 'Command 2 (TTB)', 3: 'Sound', 4: 'Attach', 5: 'Control', 6: 'Visibility',
              7: 'Message', 8: 'Command 8 (TTB)', 9: 'Camera', 10: 'Marker'}


def FormatCodes(Format):
    """PT: '<4f3fII' -> 'ffffffffII' (um código por valor). EN: one struct code per value."""
    return ''.join(Code * int(Count or 1) for Count, Code in re.findall(r'(\d*)([a-zA-Z])', Format))


def SequenceEventFormats(IsTTB):
    """PT: Formato struct de cada tipo de evento. EN: struct format of each event type."""
    Events = dict(SequenceEvents)
    if IsTTB:
        Events[0] = '<4f3fII3f3f'
    return Events


def ParseSequence(Data, IsTTB):
    """
    PT: Sequência 0x0311 -> {Flags, Radius, Tracks, Header, HeaderFormat, Tail}. Guarda também os campos que o
        editor não mexe (cabeçalho inteiro, bytes do nome de cada trilha, sobra no fim) para WriteSequence devolver
        exatamente os mesmos bytes quando nada mudou.
    EN: Parses a 0x0311 sequence, keeping everything WriteSequence needs to give the same bytes back.
    """
    Events = SequenceEventFormats(IsTTB)
    Position = 0

    def Read(Format):
        nonlocal Position
        Values = struct.unpack_from(Format, Data, Position)
        Position += struct.calcsize(Format)
        return Values
    if IsTTB and len(Data) >= 28 and struct.unpack_from('<II', Data, 0) == (1, 2):
        HeaderFormat = '<IIfIfII'
        Header = Read(HeaderFormat)
        Flags, Radius, TrackCount = Header[3], Header[4], Header[6]
    else:
        HeaderFormat = '<IfII'
        Header = Read(HeaderFormat)
        Flags, Radius, _Unknown, TrackCount = Header
    Tracks = []
    for _Track in range(TrackCount):
        Length = Read('<H')[0]
        NameRaw = Data[Position:Position + Length]
        Name = NameRaw.split(b'\0')[0].decode('latin1')
        Position += Length
        A, ObjectId, C, EventCount = Read('<4I')
        Items = []
        for _Event in range(EventCount):
            Type, Time = Read('<Hf')
            if Type not in Events:
                raise struct.error('unknown event type %d' % Type)
            Items.append((Type, Time, Read(Events[Type])))
        Tracks.append({'Name': Name, 'NameRaw': NameRaw, 'A': A, 'Object': ObjectId, 'C': C, 'Events': Items})
    return {'Flags': Flags, 'Radius': Radius, 'Tracks': Tracks, 'Header': list(Header), 'HeaderFormat': HeaderFormat,
            'Tail': Data[Position:]}, Position


def WriteSequence(Sequence, IsTTB):
    """
    PT: Inverso de ParseSequence. O nº de trilhas no cabeçalho e o nº de eventos de cada trilha saem das listas;
        o resto vem como está (Flags/Radius vão para as posições deles no cabeçalho).
    EN: Inverse of ParseSequence. Track and event counts come from the lists; Flags/Radius go to their header slots.
    """
    Events = SequenceEventFormats(IsTTB)
    Header = list(Sequence['Header'])
    if Sequence['HeaderFormat'] == '<IIfIfII':
        Header[3], Header[4], Header[6] = Sequence['Flags'], Sequence['Radius'], len(Sequence['Tracks'])
    else:
        Header[0], Header[1], Header[3] = Sequence['Flags'], Sequence['Radius'], len(Sequence['Tracks'])
    Out = [struct.pack(Sequence['HeaderFormat'], *Header)]
    for Track in Sequence['Tracks']:
        NameRaw = Track['NameRaw']
        Out.append(struct.pack('<H', len(NameRaw)) + NameRaw)
        Out.append(struct.pack('<4I', Track['A'], Track['Object'], Track['C'], len(Track['Events'])))
        for Type, Time, Values in Track['Events']:
            if Type not in Events:
                raise ValueError('unknown event type %d / tipo de evento desconhecido' % Type)
            Out.append(struct.pack('<Hf', Type, Time) + struct.pack(Events[Type], *Values))
    Out.append(Sequence.get('Tail', b''))
    return b''.join(Out)


class RiotMedia:
    """PT: Consultas das abas Áudio, STOMP e Vídeo. EN: Audio, STOMP and Video tab queries."""

    def __init__(self, Game, Classes, Templates):
        self.Game = Game
        self.Classes = Classes
        self.Templates = Templates
        self._Strings = {}
        self._SequenceLevels = {}
        self._LevelInstances = {}       # PT: caminho do .lvl -> {id: instância} / EN: .lvl path -> {id: instance}
        self._VideoCache = os.path.join(tempfile.gettempdir(), 'SurrealEdVideo')
        self.Ffmpeg = shutil.which('ffmpeg')

    # ------------------------------------------------------------------ textos / strings
    def String(self, PackageId, Index):
        if PackageId not in self._Strings:
            Table = {}
            Container = self.Game.PackageContainer(PackageId, '.xdu')
            if Container:
                for Chunk in Container.ChunksOfType(0x0400):
                    Length = struct.unpack_from('<H', Container.Data, Chunk.Offset)[0]
                    Table[Chunk.Index] = Container.Data[Chunk.Offset + 2:Chunk.Offset + 2 + Length].decode('utf-16-le', 'replace').rstrip('\0')
            self._Strings[PackageId] = Table
        return self._Strings[PackageId].get(Index)

    def StringPackages(self):
        """PT: Pacotes com .xdu (textos). EN: Packages that have a .xdu (strings)."""
        Result = []
        for PackageId in sorted(self.Game.Packages):
            Container = self.Game.PackageContainer(PackageId, '.xdu')
            if Container:
                Result.append({'Id': PackageId, 'Name': self.Game.PackageNames.get(PackageId, str(PackageId)),
                               'Folder': os.path.dirname(os.path.relpath(self.Game.Packages[PackageId], self.Game.Root)).replace(os.sep, '/'),
                               'Count': len(Container.ChunksOfType(0x0400))})
        return Result

    def StringList(self, PackageId):
        """
        PT: Todos os textos de um .xdu. Pedaço 0x0400 = u16 tamanho em bytes (com o terminador) + UTF-16LE terminado em 0
            (conferido: os 2037 textos do TS1 e os 3638 da TTB voltam idênticos ao recodificar).
        EN: Every string of a .xdu: chunk 0x0400 = u16 byte length (terminator included) + NUL-terminated UTF-16LE
            (re-encoding gives back all 2037 TS1 and 3638 TTB strings byte for byte).
        """
        Container = self.Game.PackageContainer(PackageId, '.xdu')
        if not Container:
            return None
        Result = []
        for Chunk in Container.ChunksOfType(0x0400):
            Data = Container.ChunkData(Chunk)
            Length = struct.unpack_from('<H', Data, 0)[0]
            Result.append({'Index': Chunk.Index, 'Ref': RefName(PackageId, Chunk.Index),
                           'Text': Data[2:2 + Length].decode('utf-16-le', 'replace').rstrip('\0')})
        return Result

    @staticmethod
    def EncodeString(Text, Original=None):
        """
        PT: Codifica um texto mantendo a quantidade de terminadores do original (alguns textos têm dois NUL).
        EN: Encodes a string keeping the original's number of NUL terminators (some strings have two).
        """
        Nulls = 1
        if Original:
            Length = struct.unpack_from('<H', Original, 0)[0]
            Old = Original[2:2 + Length].decode('utf-16-le', 'replace')
            Nulls = max(1, len(Old) - len(Old.rstrip('\0')))
        Encoded = (Text + '\0' * Nulls).encode('utf-16-le')
        if len(Encoded) > 0xFFFF:
            raise ValueError('text too long / texto longo demais')
        return struct.pack('<H', len(Encoded)) + Encoded

    def StringRef(self, Ref):
        return self.String(Ref >> 16, Ref & 0xFFFF) if Ref else None

    # ------------------------------------------------------------------ sons / sounds
    def _SoundHeader(self, Container, Index):
        Chunk = Container.Resource(Index).get(0x0302)
        if not Chunk or Chunk.Size < 60:
            return None
        Values = struct.unpack_from('<4I5f2I2HII', Container.Data, Chunk.Offset)
        # PT: +0 categoria, +0xC prioridade = (valor >> 4) & 0xF, +0x10 variação aleatória de pitch em % (0x43D8E0)
        # EN: +0 category, +0xC priority = (value >> 4) & 0xF, +0x10 random pitch variation in % (0x43D8E0)
        return {'Category': SoundCategories.get(Values[0], str(Values[0])), 'PitchVariation': round(Values[4], 2),
                'Volume': Values[1], 'Flags': Values[2], 'Priority': (Values[3] >> 4) & 0xF, 'MinDistance': Values[5], 'MaxDistance': Values[6],
                'Subtitle': Values[9], 'Channels': Values[11], 'Bits': Values[12], 'Rate': Values[13], 'Bytes': Values[14]}

    def Subtitle(self, PackageId, Index, Header):
        """PT: Texto da fala (TTB: cabeçalho; TS1: Line of Dialog de mesmo índice). EN: Spoken line text."""
        if self.Game.IsTTB:
            Ref = Header['Subtitle']
            if Ref >> 16 and (Ref >> 16) in self.Game.Packages:
                return self.StringRef(Ref)
            return None
        Template = self.Templates.Get(PackageId, Index)
        if Template and Template.ClassId == LineOfDialog:
            for Ref in Template.SlotArray(2) or [Template.Slot(2)]:
                Text = self.StringRef(Ref)
                if Text:
                    return Text
        return None

    def SoundList(self, PackageId):
        Container = self.Game.PackageContainer(PackageId, '.sdu')
        if not Container:
            return []
        Result = []
        for Index in Container.ResourceIndexes(0x0302):
            Header = self._SoundHeader(Container, Index)
            if not Header or not Header['Rate'] or not Header['Channels'] or not Header['Bits']:
                continue
            Data = Container.Resource(Index).get(0x0303)
            Bytes = Data.Size if Data else 0
            Text = self.Subtitle(PackageId, Index, Header)
            Result.append({'Index': Index, 'Ref': RefName(PackageId, Index), 'Rate': Header['Rate'], 'Channels': Header['Channels'],
                           'Bits': Header['Bits'], 'Duration': round(Bytes / (Header['Rate'] * Header['Channels'] * Header['Bits'] / 8), 3),
                           'Volume': Header['Volume'], 'Loop': bool(Header['Flags'] & 0x8), 'Text': Text,
                           'LipSync': 0x0305 in Container.Resource(Index)})
        return Result

    def SoundInfo(self, PackageId, Index):
        Container = self.Game.PackageContainer(PackageId, '.sdu')
        if not Container:
            return None
        Header = self._SoundHeader(Container, Index)
        if not Header:
            return None
        Data = Container.Resource(Index).get(0x0303)
        Info = dict(Header, Ref=RefName(PackageId, Index), Text=self.Subtitle(PackageId, Index, Header),
                    MinDistance=round(Header['MinDistance'], 3), MaxDistance=round(Header['MaxDistance'], 3), Bytes=Data.Size if Data else 0,
                    Duration=round((Data.Size if Data else 0) / max(1, Header['Rate'] * Header['Channels'] * Header['Bits'] / 8), 3),
                    Flags='0x%X' % Header['Flags'], Loop=bool(Header['Flags'] & 0x8), LipSync=None)
        Info.pop('Subtitle', None)
        Chunk = Container.Resource(Index).get(0x0305)
        if Chunk:
            try:
                Compressed, Rate, Step, _Constant, Count = struct.unpack_from('<5I', Container.Data, Chunk.Offset)
                Start = Chunk.Offset + 20
                if Compressed:
                    Size = struct.unpack_from('<I', Container.Data, Start)[0]
                    Raw = zlib.decompress(Container.Data[Start + 4:Start + 4 + Size])
                else:
                    Raw = Container.Data[Start:Start + 2 * Count]
                Values = struct.unpack_from('<%dh' % Count, Raw, 0)
                Info['LipSync'] = {'PerSecond': round(Rate / Step, 3) if Step else 25, 'Values': list(Values)}
            except (struct.error, zlib.error):
                pass
        return Info

    def SoundWav(self, PackageId, Index):
        """PT: Som como arquivo WAV. EN: Sound as a WAV file."""
        Container = self.Game.PackageContainer(PackageId, '.sdu')
        if not Container:
            return None
        Header = self._SoundHeader(Container, Index)
        Chunk = Container.Resource(Index).get(0x0303)
        if not Header or not Chunk or not Header['Rate']:
            return None
        Buffer = io.BytesIO()
        with wave.open(Buffer, 'wb') as Output:
            Output.setnchannels(Header['Channels'])
            Output.setsampwidth(Header['Bits'] // 8)
            Output.setframerate(Header['Rate'])
            Output.writeframes(Container.ChunkData(Chunk))
        return Buffer.getvalue()

    # ------------------------------------------------------------------ sequências / sequences
    def SequenceList(self, PackageId):
        Container = self.Game.PackageContainer(PackageId, '.qdu')
        if not Container:
            return []
        Result = []
        for Chunk in Container.ChunksOfType(0x0311):
            try:
                Sequence, _Used = ParseSequence(Container.ChunkData(Chunk), self.Game.IsTTB)
            except struct.error:
                continue
            Duration = max((Event[1] for Track in Sequence['Tracks'] for Event in Track['Events']), default=0)
            Result.append({'Index': Chunk.Index, 'Ref': RefName(PackageId, Chunk.Index), 'Tracks': len(Sequence['Tracks']),
                           'Duration': round(Duration, 3), 'Names': [Track['Name'] for Track in Sequence['Tracks']][:6]})
        return Result

    def _InstancesOf(self, Level):
        if Level['Path'] not in self._LevelInstances:
            try:
                Instances, _Complete = ReadInstances(self.Game.Container(Level['Path']))
                self._LevelInstances[Level['Path']] = {Instance['Id']: Instance for Instance in Instances}
            except (OSError, ValueError, struct.error):
                self._LevelInstances[Level['Path']] = None
        return self._LevelInstances[Level['Path']]

    def LevelSequences(self, LevelKey):
        """
        PT: Sequências STOMP de uma fase: os .qdu da mesma pasta, ficando só as sequências cujos objetos são desta fase
            (1a e 1b dividem a pasta "1 PrisonDeathRow").
        EN: A level's STOMP sequences: the .qdu packages of the same folder, keeping the ones whose objects are here.
        """
        Level = next((Item for Item in self.Game.Levels() if Item['Key'] == LevelKey), None)
        if not Level:
            return None
        Folder = os.path.dirname(Level['Path'])
        Result = []
        for PackageId, Base in sorted(self.Game.Packages.items()):
            if os.path.dirname(Base) != Folder:
                continue
            Container = self.Game.PackageContainer(PackageId, '.qdu')
            if not Container:
                continue
            for Chunk in Container.ChunksOfType(0x0311):
                try:
                    Sequence, _Used = ParseSequence(Container.ChunkData(Chunk), self.Game.IsTTB)
                except struct.error:
                    continue
                Ids = [Track['Object'] for Track in Sequence['Tracks'] if Track['Object']]
                Found, _ById = self._LevelFor(PackageId, Ids) if Ids else (None, None)
                if Ids and (not Found or Found['Key'] != LevelKey):
                    continue
                Duration = max((Event[1] for Track in Sequence['Tracks'] for Event in Track['Events']), default=0)
                Result.append({'Index': Chunk.Index, 'Ref': RefName(PackageId, Chunk.Index), 'Tracks': len(Sequence['Tracks']),
                               'Duration': round(Duration, 3), 'Names': [Track['Name'] for Track in Sequence['Tracks']][:6]})
        return Result

    def _LevelFor(self, PackageId, ObjectIds):
        """PT: Fase cujas instâncias contêm os objetos das trilhas. EN: Level whose instances hold the tracks' objects."""
        Key = (PackageId, tuple(sorted(ObjectIds)))
        if Key in self._SequenceLevels:
            return self._SequenceLevels[Key]
        Folder = os.path.dirname(self.Game.Packages.get(PackageId, ''))
        Best = (0, None, None)
        for Level in self.Game.Levels():
            if os.path.dirname(Level['Path']) != Folder:
                continue
            ById = self._InstancesOf(Level)
            if ById is None:
                continue
            Hits = sum(1 for Id in ObjectIds if Id in ById)
            if Hits > Best[0]:
                Best = (Hits, Level, ById)
        self._SequenceLevels[Key] = Best[1:]
        return Best[1:]

    def _SequenceChunk(self, PackageId, Index):
        Container = self.Game.PackageContainer(PackageId, '.qdu')
        Chunk = Container.Resource(Index).get(0x0311) if Container else None
        return (Container, Chunk) if Chunk else (None, None)

    def Sequence(self, PackageId, Index):
        Container, Chunk = self._SequenceChunk(PackageId, Index)
        if not Chunk:
            return None
        Sequence, Used = ParseSequence(Container.ChunkData(Chunk), self.Game.IsTTB)
        return self.DescribeSequence(PackageId, Index, Sequence, Used == Chunk.Size)

    def SequenceRaw(self, PackageId, Index):
        """
        PT: A sequência em forma editável: os valores crus de cada evento (os mesmos que vão para o arquivo), mais o
            que o editor precisa para converter (PositionScale, formato de cada tipo).
        EN: The sequence in editable form: raw event values (exactly what is written) plus conversion info.
        """
        Container, Chunk = self._SequenceChunk(PackageId, Index)
        if not Chunk:
            return None
        Sequence, _Used = ParseSequence(Container.ChunkData(Chunk), self.Game.IsTTB)
        return {
            'Ref': RefName(PackageId, Index), 'Flags': Sequence['Flags'], 'Radius': Sequence['Radius'],
            'Scale': self.Game.PositionScale, 'IsTTB': self.Game.IsTTB,
            'Formats': {str(Type): FormatCodes(Format) for Type, Format in SequenceEventFormats(self.Game.IsTTB).items()},
            'Tracks': [{'Name': Track['Name'], 'NameHex': Track['NameRaw'].hex(), 'A': Track['A'], 'Object': Track['Object'],
                        'C': Track['C'], 'Events': [{'Type': Type, 'Time': Time, 'Values': list(Values)} for Type, Time, Values in Track['Events']]}
                       for Track in Sequence['Tracks']],
        }

    def SequenceFromRaw(self, PackageId, Index, Raw):
        """
        PT: Monta a sequência (como ParseSequence devolve) a partir da forma editável, conferindo cada valor contra o
            formato do tipo; cabeçalho e sobra vêm do arquivo atual. Os eventos de cada trilha ficam em ordem de tempo
            (todas as 527 sequências originais, TS1 e TTB, já estão assim). Levanta ValueError se algo não cabe.
        EN: Builds the parsed form from the editable one, validating every value; events are kept in time order.
        """
        Container, Chunk = self._SequenceChunk(PackageId, Index)
        if not Chunk:
            raise ValueError('unknown sequence / sequência desconhecida')
        Original, _Used = ParseSequence(Container.ChunkData(Chunk), self.Game.IsTTB)
        Formats = SequenceEventFormats(self.Game.IsTTB)
        Tracks = []
        for Track in Raw['Tracks']:
            Events = []
            for Event in Track['Events']:
                Type = int(Event['Type'])
                if Type not in Formats:
                    raise ValueError('unknown event type %d / tipo de evento desconhecido' % Type)
                Format = FormatCodes(Formats[Type])
                Values = list(Event['Values'])
                if len(Values) != len(Format):
                    raise ValueError('event type %d needs %d values / o tipo %d pede %d valores' % (Type, len(Format), Type, len(Format)))
                Values = tuple(float(Value) if Code == 'f' else int(Value) for Code, Value in zip(Format, Values))
                Time = float(Event['Time'])
                if not math.isfinite(Time) or Time < 0 or any(isinstance(Value, float) and not math.isfinite(Value) for Value in Values):
                    raise ValueError('invalid number / número inválido')
                struct.pack('<' + Format, *Values)
                Events.append((Type, Time, Values))
            Events.sort(key=lambda Item: Item[1])
            Tracks.append({'Name': Track.get('Name', ''), 'NameRaw': bytes.fromhex(Track['NameHex']), 'A': int(Track['A']),
                           'Object': int(Track['Object']), 'C': int(Track['C']), 'Events': Events})
        Result = dict(Original, Flags=int(Raw['Flags']), Radius=float(Raw['Radius']), Tracks=Tracks)
        try:
            WriteSequence(Result, self.Game.IsTTB)
        except struct.error as Error:
            raise ValueError(str(Error))
        return Result

    def DescribeSequence(self, PackageId, Index, Sequence, Complete=True):
        """PT: Visão decodificada (para o tocador e a lista de chaves). EN: Decoded view (for the player and sheet)."""
        Scale = self.Game.PositionScale
        Level, ById = self._LevelFor(PackageId, [Track['Object'] for Track in Sequence['Tracks'] if Track['Object']])
        Tracks = []
        Duration = 0.0
        for Track in Sequence['Tracks']:
            Instance = (ById or {}).get(Track['Object'])
            ClassName = None
            if Instance:
                Template = self.Templates.Get(Instance['TemplatePackage'], Instance['TemplateIndex'])
                ClassName = self.Classes.Name(Template.ClassId) if Template else None
            Events = []
            for Type, Time, Values in Track['Events']:
                Duration = max(Duration, Time)
                Event = {'Type': Type, 'Name': EventNames.get(Type, 'Command %d' % Type), 'Time': round(Time, 4)}
                if Type == 0:
                    Event['Rotation'] = [round(Value, 5) for Value in Values[0:4]]
                    Event['Position'] = [round(Value / Scale, 4) for Value in Values[4:7]]
                    Event['Flags'] = Values[8]
                    Event['Scale'] = [round(Value, 4) for Value in Values[9:12]]
                elif Type == 1:
                    Event['Animation'] = RefName(Values[1] >> 16, Values[1] & 0xFFFF)
                    Event['Channel'] = Values[0]
                    Event['Start'], Event['Blend'], Event['Speed'] = (round(Value, 4) for Value in Values[2:5])
                    Event['AnimFlags'] = '0x%X' % Values[5]
                    Event['Values'] = [round(Value, 4) for Value in Values[2:5]] + [Values[5]]
                elif Type == 3:
                    Event['Sound'] = RefName(Values[0] >> 16, Values[0] & 0xFFFF)
                    Event['Volume'] = round(Values[1] / 10000, 3)
                    Event['Positional'] = not (Values[2] & 0x10)
                    Event['Values'] = list(Values[1:])
                    Playable = self.Game.PackageContainer(Values[0] >> 16, '.sdu')
                    Event['Playable'] = bool(Playable and self._SoundHeader(Playable, Values[0] & 0xFFFF))
                    Template = self.Templates.Get(Values[0] >> 16, Values[0] & 0xFFFF)
                    if Template and Template.ClassId == LineOfDialog:
                        Event['Text'] = next((self.StringRef(Ref) for Ref in (Template.SlotArray(2) or [Template.Slot(2)]) if self.StringRef(Ref)), None)
                    else:
                        SoundContainer = self.Game.PackageContainer(Values[0] >> 16, '.sdu')
                        Header = self._SoundHeader(SoundContainer, Values[0] & 0xFFFF) if SoundContainer else None
                        if Header:
                            Event['Text'] = self.Subtitle(Values[0] >> 16, Values[0] & 0xFFFF, Header)
                elif Type == 9:
                    Event['TimeScale'] = round(Values[0], 4)
                    Event['Fov'] = Values[1] or None
                    Event['Interpolation'] = {0: 'step', 1: 'linear', 3: 'linear', 5: 'linear', 2: 'ease-out', 4: 'ease-in', 6: 'ease-in-out'}.get(Values[2] & 7, Values[2] & 7)
                    Event['Values'] = list(Values)
                elif Type == 7:
                    Event['Message'] = '%d · %s' % (Values[0], MessageName(Values[0], self.Game.IsTTB) or '?')
                    # PT: efeitos que esta mensagem liga/desliga (prévia; RiotMessageFlow) / EN: effects it switches
                    if ById:
                        Event['Effects'] = [[Target, Action] for Target, Action in
                                            RiotMessageFlow(self.Templates, self.Game.IsTTB).Resolve(ById, Track['Object'], Values[0])]
                        # PT: o que a mensagem põe na tela (títulos, flashes; TTB, RiotScreenFx) / EN: on-screen effect
                        Target = ById.get(Track['Object'])
                        if Target:
                            TargetTemplate = self.Templates.Get(Target['TemplatePackage'], Target['TemplateIndex'])
                            Screen = RiotScreenFx(self.Templates, self.Classes, self.Game.IsTTB).Resolve(
                                TargetTemplate, InstanceProperties(TargetTemplate, Target) if TargetTemplate else {}, Values[0])
                            if Screen:
                                Event['Screen'] = Screen
                    Event['Values'] = list(Values)
                elif Type in (5, 6):
                    Event['State'] = {5: {0: 'take', 1: 'release'}, 6: {0: 'hidden', 1: 'shown'}}[Type].get(Values[0], Values[0])
                    Event['Values'] = list(Values)
                else:
                    Event['Values'] = [round(Value, 4) if isinstance(Value, float) else Value for Value in Values]
                Events.append(Event)
            Tracks.append({'Name': Track['Name'], 'Object': Track['Object'], 'Class': ClassName,
                           'Position': [round(Value / Scale, 3) for Value in Instance['Position']] if Instance else None, 'Events': Events})
        return {'Ref': RefName(PackageId, Index), 'Duration': round(Duration, 3), 'Flags': '0x%X' % Sequence['Flags'],
                'Radius': round(Sequence['Radius'], 3),
                'Level': Level['File'] if Level else None, 'LevelKey': Level['Key'] if Level else None, 'Tracks': Tracks,
                'Complete': Complete}

    # ------------------------------------------------------------------ vídeos / videos
    def VideoList(self, PackageId):
        Container = self.Game.PackageContainer(PackageId, '.vdu')
        if not Container:
            return []
        Result = []
        for Chunk in Container.ChunksOfType(0x0342):
            Version, Fps, Milliseconds, Width, Height, Bpp = struct.unpack_from('<6I', Container.Data, Chunk.Offset)
            Payload = Container.Resource(Chunk.Index).get(0x0343)
            Result.append({'Index': Chunk.Index, 'Ref': RefName(PackageId, Chunk.Index), 'Fps': Fps, 'Duration': round(Milliseconds / 1000, 2),
                           'Width': Width, 'Height': Height, 'Bytes': Payload.Size if Payload else 0})
        return Result

    def VideoWmv(self, PackageId, Index):
        """PT: Vídeo como .wmv normal (índice devolvido ao fim). EN: Video rebuilt as a regular .wmv."""
        Container = self.Game.PackageContainer(PackageId, '.vdu')
        Chunk = Container.Resource(Index).get(0x0343) if Container else None
        if not Chunk:
            return None
        Blob = Container.ChunkData(Chunk)
        IndexSize = struct.unpack_from('<Q', Blob, 16)[0]
        return Blob[IndexSize:] + Blob[:IndexSize]

    def VideoMp4(self, PackageId, Index):
        """PT: Caminho de um MP4 convertido com o ffmpeg (cache), ou None. EN: Path of an ffmpeg-converted MP4, or None."""
        if not self.Ffmpeg:
            return None
        os.makedirs(self._VideoCache, exist_ok=True)
        Name = '%s_%d_%04x' % (self.Game.Game, PackageId, Index)
        Target = os.path.join(self._VideoCache, Name + '.mp4')
        if os.path.exists(Target):
            return Target
        Wmv = self.VideoWmv(PackageId, Index)
        if not Wmv:
            return None
        Source = os.path.join(self._VideoCache, Name + '.wmv')
        with open(Source, 'wb') as Handle:
            Handle.write(Wmv)
        try:
            subprocess.run([self.Ffmpeg, '-nostdin', '-v', 'error', '-y', '-i', Source, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', Target], check=True, timeout=600)
        except (OSError, subprocess.SubprocessError):
            return None
        finally:
            try:
                os.remove(Source)
            except OSError:
                pass
        return Target if os.path.exists(Target) else None
