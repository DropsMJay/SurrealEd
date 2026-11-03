"""
RiotMessageNames — nomes das mensagens do jogo / the game's message names
=========================================================================

PT: Lê a tabela {char* nome, u32 id} do .rfl (TS1 0x6DC74658; a TTB é achada procurando o par "<none>"/"On")
    e grava Riot/RiotMessageNames.json = {"TS1": {id: nome}, "TTB": {...}}. Uso:
        python Tools/RiotMessageNames.py "<pasta do TS1>" "<pasta da TTB>"
EN: Reads the {char* name, u32 id} table from the .rfl and writes Riot/RiotMessageNames.json.
"""
import json
import os
import struct
import sys

import pefile


def Names(Path):
    Pe = pefile.PE(Path)
    Base = Pe.OPTIONAL_HEADER.ImageBase
    Image = Pe.get_memory_mapped_image()

    def String(Va):
        Offset = Va - Base
        if not 0 <= Offset < len(Image):
            return None
        End = Image.find(b'\0', Offset, Offset + 64)
        Raw = Image[Offset:End] if End > 0 else None
        if Raw is None or not all(32 <= Byte < 127 for Byte in Raw):
            return None
        return Raw.decode('ascii')

    NoneAt = Image.find(b'<none>\0')
    while NoneAt >= 0:
        Pointer = struct.pack('<II', Base + NoneAt, 0)
        Table = Image.find(Pointer)
        while Table >= 0:
            Result, Offset = {}, Table
            while Offset + 8 <= len(Image):
                Va, Id = struct.unpack_from('<II', Image, Offset)
                Name = String(Va)
                if Name is None or Id > 0x10000:
                    break
                Result[Id] = Name
                Offset += 8
            if len(Result) > 20 and Result.get(1) == 'On':
                return Result
            Table = Image.find(Pointer, Table + 4)
        NoneAt = Image.find(b'<none>\0', NoneAt + 1)
    return {}


def Find(Root):
    for Name in os.listdir(Root):
        if Name.lower().endswith('.rfl'):
            return os.path.join(Root, Name)
    return None


if __name__ == '__main__':
    Output = {}
    for Label, Root in zip(('TS1', 'TTB'), sys.argv[1:3]):
        Path = Find(Root)
        if Path:
            Output[Label] = {str(Id): Name for Id, Name in sorted(Names(Path).items())}
            print(Label, len(Output[Label]), 'names')
    Target = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'Riot', 'RiotMessageNames.json')
    json.dump(Output, open(Target, 'w'), indent=0, ensure_ascii=False)
