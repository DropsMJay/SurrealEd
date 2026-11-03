"""
RiotLevelEdit — copiar, colar e apagar objetos numa fase / copy, paste and delete level objects
===============================================================================================

PT-BR
-----
Criar ou apagar uma instância mexe em três pedaços do .lvl:

* 0x0020 (instâncias): o índice ganha {id, template} e o registro vai no fim (WriteInstances).
* 0x0026 (árvore de células): cada objeto visível é uma "folha" pendurada num nó (célula/sala). Nós e folhas
  dividem um único espaço de índices de 1 base: G = 1 + nó, ou G = 1 + nNós + folha. Ponteiros nesse espaço:
  nó.pai / nó.1º filho / nó.irmão (u16), folha.célula (u32, o nó pai), folha.próxima (u16, irmã seguinte) e, na
  TTB, o u32 final da folha (outra folha do mesmo objeto, quando ele está em várias células). 0 = nenhum.
  As folhas vêm em dois blocos: o 1º (cabeçalho a) é o dos objetos, gravado em objeto +0x40; o 2º (cabeçalho b)
  é o das luzes (Point/Directional/Ambient Light), em objeto +0x44 (FUN_004B9840 procura o objeto pelo id).
  Folha nova = cópia da folha do original com o id novo e a caixa deslocada, pendurada como 1º filho do nó mais
  fundo cuja caixa contém a posição nova; as caixas dos nós acima crescem se for preciso. No bloco dos objetos,
  inserir no fim do bloco empurra +1 todos os ponteiros para as luzes.
* 0x0028 (histórico do editor): uma linha de "criado" e uma de "alterado" por instância, na mesma ordem.

EN
--
Adding/removing an instance touches 0x0020, the 0x0026 cell tree (shared 1-based index space for nodes and leaves;
object leaves block, then light leaves block; pointers listed above) and the 0x0028 editor history.
"""
import datetime
import struct

_NodeFields = {'Parent': 8, 'Child': 10, 'Sibling': 12}


class RiotCellTree:
    """PT: 0x0026 editável, regravado byte a byte. EN: Editable 0x0026, rewritten byte for byte."""

    def __init__(self, Data, IsTTB):
        self.IsTTB = IsTTB
        Base = 8 if IsTTB else 0
        self.Prefix = bytes(Data[:Base])
        self.Header = list(struct.unpack_from('<5I', Data, Base))
        Position = Base + 20
        self.Nodes = []
        for _Node in range(self.Header[1]):
            Length = struct.unpack_from('<H', Data, Position + 42)[0]
            Size = 44 + Length + (4 if IsTTB else 0)
            self.Nodes.append(bytearray(Data[Position:Position + Size]))
            Position += Size
        self.EntrySize = 46 if IsTTB else 42
        self.Entries = []
        for _Entry in range(self.Header[2] + self.Header[3]):
            self.Entries.append(bytearray(Data[Position:Position + self.EntrySize]))
            Position += self.EntrySize
        self.Rest = bytes(Data[Position:])

    def Write(self):
        Header = list(self.Header)
        Header[1] = len(self.Nodes)
        return self.Prefix + struct.pack('<5I', *Header) + b''.join(bytes(Node) for Node in self.Nodes) + \
            b''.join(bytes(Entry) for Entry in self.Entries) + self.Rest

    # ---------------------------------------------------------------- campos / fields
    @staticmethod
    def _U16(Raw, Offset, Value=None):
        if Value is None:
            return struct.unpack_from('<H', Raw, Offset)[0]
        struct.pack_into('<H', Raw, Offset, Value)

    @staticmethod
    def _U32(Raw, Offset, Value=None):
        if Value is None:
            return struct.unpack_from('<I', Raw, Offset)[0]
        struct.pack_into('<I', Raw, Offset, Value)

    def EntryG(self, Number):
        return 1 + len(self.Nodes) + Number

    def EntryId(self, Number):
        return self._U32(self.Entries[Number], 38)

    def EntryKind(self, Number):
        return self._U32(self.Entries[Number], 0)

    def EntriesOf(self, InstanceId):
        return [Number for Number in range(len(self.Entries)) if self.EntryKind(Number) == 2 and self.EntryId(Number) == InstanceId]

    def _Box(self, Raw):
        Values = struct.unpack_from('<6f', Raw, 14)
        return list(Values[:3]), list(Values[3:])       # PT: máximo, mínimo / EN: max, min

    def _SetBox(self, Raw, Maximum, Minimum):
        struct.pack_into('<6f', Raw, 14, *Maximum, *Minimum)

    def _Next(self, G, Value=None):
        """PT: Ponteiro "irmão seguinte" de G (nó ou folha). EN: Next-sibling pointer of G."""
        if G <= len(self.Nodes):
            return self._U16(self.Nodes[G - 1], 12, Value)
        return self._U16(self.Entries[G - 1 - len(self.Nodes)], 12, Value)

    def _Shift(self, From, Delta):
        """PT: Soma Delta a todo ponteiro >= From. EN: Adds Delta to every pointer >= From."""
        for Node in self.Nodes:
            for Offset in _NodeFields.values():
                Value = self._U16(Node, Offset)
                if Value >= From:
                    self._U16(Node, Offset, Value + Delta)
        for Entry in self.Entries:
            Value = self._U16(Entry, 12)
            if Value >= From:
                self._U16(Entry, 12, Value + Delta)
            Value = self._U32(Entry, 8)
            if Value >= From:
                self._U32(Entry, 8, Value + Delta)
            if self.IsTTB:
                Value = self._U32(Entry, 42)
                if Value >= From:
                    self._U32(Entry, 42, Value + Delta)

    def _Depth(self, NodeNumber):
        Depth, G = 0, NodeNumber + 1
        while Depth < 512:
            Parent = self._U16(self.Nodes[G - 1], 8)
            if not Parent or Parent == G:
                break
            G, Depth = Parent, Depth + 1
        return Depth

    def _ParentFor(self, Point, Preferred):
        """PT: Nó mais fundo cuja caixa contém o ponto (o do original, se ainda contém). EN: Deepest node containing the point."""
        def Contains(NodeNumber):
            Maximum, Minimum = self._Box(self.Nodes[NodeNumber])
            return all(Minimum[Axis] - 1e-3 <= Point[Axis] <= Maximum[Axis] + 1e-3 for Axis in range(3))
        if Preferred and Contains(Preferred - 1):
            return Preferred
        Best, BestDepth = Preferred, -1
        for NodeNumber in range(len(self.Nodes)):
            if Contains(NodeNumber):
                Depth = self._Depth(NodeNumber)
                if Depth > BestDepth:
                    Best, BestDepth = NodeNumber + 1, Depth
        return Best

    def _Grow(self, ParentG, Maximum, Minimum):
        G, Guard = ParentG, 0
        while G and G <= len(self.Nodes) and Guard < 512:
            Node = self.Nodes[G - 1]
            NodeMax, NodeMin = self._Box(Node)
            self._SetBox(Node, [max(A, B) for A, B in zip(NodeMax, Maximum)], [min(A, B) for A, B in zip(NodeMin, Minimum)])
            Parent = self._U16(Node, 8)
            if Parent == G:
                break
            G, Guard = Parent, Guard + 1

    # ---------------------------------------------------------------- operações / operations
    def AddCopy(self, SourceId, NewId, Delta, Point):
        """
        PT: Folha nova para NewId, copiada da folha de SourceId com a caixa deslocada por Delta (unidades do arquivo).
            Devolve False se o original não tem folha (objetos de lógica: nada a fazer).
        EN: New leaf for NewId copied from SourceId's leaf, box moved by Delta. False if the source has no leaf.
        """
        Found = self.EntriesOf(SourceId)
        if not Found:
            return False
        Source = Found[0]
        Raw = bytearray(self.Entries[Source])
        self._U32(Raw, 38, NewId)
        if self.IsTTB:
            self._U32(Raw, 42, 0)
        Maximum, Minimum = self._Box(Raw)
        Maximum = [Value + Change for Value, Change in zip(Maximum, Delta)]
        Minimum = [Value + Change for Value, Change in zip(Minimum, Delta)]
        self._SetBox(Raw, Maximum, Minimum)
        InLights = Source >= self.Header[2]
        Number = len(self.Entries) if InLights else self.Header[2]
        G = self.EntryG(Number)
        if not InLights:
            self._Shift(G, +1)
        Parent = self._ParentFor(Point, self._U32(Raw, 8))
        self._U32(Raw, 8, Parent)
        self._U16(Raw, 12, self._U16(self.Nodes[Parent - 1], 10))   # PT: vira o 1º filho / EN: becomes first child
        self.Entries.insert(Number, Raw)
        self._U16(self.Nodes[Parent - 1], 10, G)
        self.Header[3 if InLights else 2] += 1
        self._Grow(Parent, Maximum, Minimum)
        return True

    def Remove(self, InstanceId):
        """PT: Tira todas as folhas do objeto. EN: Removes every leaf of the object."""
        Removed = 0
        for Number in sorted(self.EntriesOf(InstanceId), reverse=True):
            G = self.EntryG(Number)
            Next = self._U16(self.Entries[Number], 12)
            Parent = self._U32(self.Entries[Number], 8)
            # PT: desengata da lista de filhos do pai / EN: unlink from the parent's child list
            if Parent and self._U16(self.Nodes[Parent - 1], 10) == G:
                self._U16(self.Nodes[Parent - 1], 10, Next)
            else:
                Child = self._U16(self.Nodes[Parent - 1], 10) if Parent else 0
                Guard = 0
                while Child and Guard < 100000:
                    if self._Next(Child) == G:
                        self._Next(Child, Next)
                        break
                    Child, Guard = self._Next(Child), Guard + 1
            if self.IsTTB:
                for Entry in self.Entries:
                    if self._U32(Entry, 42) == G:
                        self._U32(Entry, 42, 0)
            del self.Entries[Number]
            self._Shift(G + 1, -1)
            self.Header[3 if Number >= self.Header[2] else 2] -= 1
            Removed += 1
        return Removed

    def Check(self):
        """PT: Toda folha alcançável exatamente uma vez a partir dos nós. EN: Every leaf reachable exactly once."""
        Seen = [0] * len(self.Entries)
        Count = len(self.Nodes)
        for Node in self.Nodes:
            Child, Guard = self._U16(Node, 10), 0
            while Child and Guard < 200000:
                if Child > Count:
                    if Child - 1 - Count >= len(self.Entries):
                        return False
                    Seen[Child - 1 - Count] += 1
                Child, Guard = self._Next(Child), Guard + 1
        return all(Value == 1 for Value in Seen)


class RiotHistory:
    """PT: 0x0028 editável (criado / alterado por instância). EN: Editable 0x0028."""

    def __init__(self, Data):
        Count = struct.unpack_from('<I', Data, 0)[0]
        Position = 4
        self.Rows = [[], []]
        for Table in range(2):
            for _Row in range(Count):
                if Position + 10 > len(Data):
                    break
                Length = struct.unpack_from('<H', Data, Position + 8)[0]
                self.Rows[Table].append(bytes(Data[Position:Position + 10 + Length]))
                Position += 10 + Length
        self.Rest = bytes(Data[Position:])

    @staticmethod
    def Row(Author='SurrealEd', When=None):
        When = When or datetime.datetime.utcnow()
        Ticks = int((When - datetime.datetime(1601, 1, 1)).total_seconds() * 10 ** 7)
        Name = Author.encode('latin1') + b'\0'
        return struct.pack('<QH', Ticks, len(Name)) + Name

    def Append(self, Count=1):
        for _Row in range(Count):
            self.Rows[0].append(self.Row())
            self.Rows[1].append(self.Row())

    def Remove(self, Number):
        for Table in self.Rows:
            if Number < len(Table):
                del Table[Number]

    def Write(self):
        return struct.pack('<I', len(self.Rows[0])) + b''.join(self.Rows[0]) + b''.join(self.Rows[1]) + self.Rest
