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
Backs the Audio, STOMP and Video tabs (layouts above). Videos are WMV2: they are rebuilt as .wmv and, when ffmpeg is
available, converted to MP4 for the browser preview.
"""
import io
import os
import shutil
import struct
import subprocess
import tempfile
import wave
import zlib

from .RiotPackages import RefName
from .RiotLevel import ReadInstances
from .RiotProperties import MessageName

LineOfDialog = 0xCC015D52
SoundCategories = {0: 'Effect', 1: 'Ambient', 2: 'Music', 3: 'Movie', 4: 'GUI', 5: 'GUI FX', 6: 'Dialog'}
SequenceEvents = {0: '<4f3fII3f', 1: '<II3fI', 2: '<IHH', 3: '<IHH', 4: '<II', 5: '<I', 6: '<I', 7: '<3I', 8: '<II4fI', 9: '<fII', 10: '<'}
# PT: nomes dos tipos de chave conferidos com o projeto "the-suffering-engine" (src/game/world/stomp.ts); 2 e 8 só na TTB
# EN: key type names cross-checked with "the-suffering-engine"; 2 and 8 only occur in TTB
EventNames = {0: 'Transform', 1: 'Animation', 2: 'Command 2 (TTB)', 3: 'Sound', 4: 'Attach', 5: 'Control', 6: 'Visibility',
              7: 'Message', 8: 'Command 8 (TTB)', 9: 'Camera', 10: 'Marker'}


def ParseSequence(Data, IsTTB):
    """PT: Sequência 0x0311 -> {Flags, Radius, Tracks}. EN: Parses a 0x0311 sequence."""
    Events = dict(SequenceEvents)
    if IsTTB:
        Events[0] = '<4f3fII3f3f'
    Position = 0

    def Read(Format):
        nonlocal Position
        Values = struct.unpack_from(Format, Data, Position)
        Position += struct.calcsize(Format)
        return Values
    if IsTTB and len(Data) >= 28 and struct.unpack_from('<II', Data, 0) == (1, 2):
        Header = Read('<IIfIfII')
        Flags, Radius, TrackCount = Header[3], Header[4], Header[6]
    else:
        Flags, Radius, _Unknown, TrackCount = Read('<IfII')
    Tracks = []
    for _Track in range(TrackCount):
        Length = Read('<H')[0]
        Name = Data[Position:Position + Length].split(b'\0')[0].decode('latin1')
        Position += Length
        A, ObjectId, C, EventCount = Read('<4I')
        Items = []
        for _Event in range(EventCount):
            Type, Time = Read('<Hf')
            Items.append((Type, Time, Read(Events.get(Type, '<'))))
        Tracks.append({'Name': Name, 'A': A, 'Object': ObjectId, 'C': C, 'Events': Items})
    return {'Flags': Flags, 'Radius': Radius, 'Tracks': Tracks}, Position


class RiotMedia:
    """PT: Consultas das abas Áudio, STOMP e Vídeo. EN: Audio, STOMP and Video tab queries."""

    def __init__(self, Game, Classes, Templates):
        self.Game = Game
        self.Classes = Classes
        self.Templates = Templates
        self._Strings = {}
        self._SequenceLevels = {}
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
            try:
                Instances, _Complete = ReadInstances(self.Game.Container(Level['Path']))
            except (OSError, ValueError, struct.error):
                continue
            ById = {Instance['Id']: Instance for Instance in Instances}
            Hits = sum(1 for Id in ObjectIds if Id in ById)
            if Hits > Best[0]:
                Best = (Hits, Level, ById)
        self._SequenceLevels[Key] = Best[1:]
        return Best[1:]

    def Sequence(self, PackageId, Index):
        Container = self.Game.PackageContainer(PackageId, '.qdu')
        Chunk = Container.Resource(Index).get(0x0311) if Container else None
        if not Chunk:
            return None
        Sequence, Used = ParseSequence(Container.ChunkData(Chunk), self.Game.IsTTB)
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
                'Complete': Used == Chunk.Size}

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
