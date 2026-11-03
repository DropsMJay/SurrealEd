"""
RiotRoundTrip — teste de regravação / rewrite test
==================================================

PT: Regrava (na memória) todos os arquivos SRSC de uma instalação e confere que saem idênticos byte a byte.
    Também troca um pedaço por um maior e por um menor e confere que tudo continua legível e igual.
    Uso: python Tools/RiotRoundTrip.py "<pasta do jogo>"
EN: Rewrites (in memory) every SRSC file of an install and checks they come out byte-identical; also checks that
    growing and shrinking a chunk keeps every other chunk intact.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from Riot.RiotContainer import RiotContainer, RebuildContainer   # noqa: E402
from Riot.RiotLevel import ReadInstances, WriteInstances          # noqa: E402


def IsContainer(Name):
    Lower = Name.lower()
    return Lower.endswith('.lvl') or (len(Lower) > 4 and Lower[-4] == '.' and Lower.endswith('du'))


def Check(Root):
    Files = Same = Resized = Levels = LevelsSame = 0
    Problems = []
    for Folder, _Folders, Names in os.walk(Root):
        if 'SurrealEd Backup' in Folder:
            continue
        for Name in sorted(Names):
            if not IsContainer(Name):
                continue
            Path = os.path.join(Folder, Name)
            Container = RiotContainer(Path)
            Files += 1
            if RebuildContainer(Container) == Container.Data:
                Same += 1
            else:
                Problems.append('not identical: ' + Path)
            # PT: pedaço maior e menor / EN: grow and shrink one chunk
            Target = max(Container.Chunks, key=lambda Chunk: Chunk.Size)
            for Payload in (Container.ChunkData(Target) + b'\x55' * 37, Container.ChunkData(Target)[:max(1, Target.Size // 2)]):
                Changed = RiotContainer(Data=RebuildContainer(Container, Replace={Target: Payload}))
                Good = len(Changed.Chunks) == len(Container.Chunks)
                for Old, New in zip(Container.Chunks, Changed.Chunks):
                    Expected = Payload if Old is Target else Container.ChunkData(Old)
                    if (Old.ChunkType, Old.ChunkId) != (New.ChunkType, New.ChunkId) or Changed.ChunkData(New) != Expected or New.Offset % 8:
                        Good = False
                        break
                if not Good:
                    Problems.append('resize failed: ' + Path)
                    break
            else:
                Resized += 1
            if Name.lower().endswith('.lvl'):
                Levels += 1
                Chunk = Container.FirstOfType(0x0020)
                Instances, Complete = ReadInstances(Container)
                if Chunk and Complete and WriteInstances(Instances) == Container.ChunkData(Chunk):
                    LevelsSame += 1
                elif Chunk:
                    Problems.append('instances differ: ' + Path)
    print('%s: %d/%d identical, %d/%d resize ok, %d/%d levels: instances identical' % (Root, Same, Files, Resized, Files, LevelsSame, Levels))
    for Problem in Problems[:20]:
        print('  ' + Problem)
    return not Problems


if __name__ == '__main__':
    Ok = all(Check(Root) for Root in sys.argv[1:])
    sys.exit(0 if Ok else 1)
