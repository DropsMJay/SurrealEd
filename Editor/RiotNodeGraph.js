/*
 * RiotNodeGraph — editor de nós genérico (abas Material e Scripting) / generic node editor (Material and Scripting tabs)
 *
 * PT: Nós em HTML (assim cada linha pode ter um campo de edição) sobre uma camada SVG com os fios. Arrastar o fundo
 *     desliza a vista, a roda aproxima, arrastar o título move o nó, arrastar de uma porta de saída até uma porta de
 *     entrada pede uma ligação (OnConnect decide), clicar num fio o seleciona e Delete pede para apagá-lo
 *     (OnDisconnect decide). Clique duplo num nó chama OnOpen.
 *       Node: { Id, Title, Subtitle, X, Y, Color, Width, Inputs: [{ Key, Label }], Outputs: [{ Key, Label }],
 *               Rows: [ HTMLElement ], Thumbnail: HTMLElement, Muted }
 *       Edge: { From: [NodeId, PortKey], To: [NodeId, PortKey], Label, Dashed, Color }
 * EN: HTML nodes (so rows can hold inputs) over an SVG wire layer. Background drag pans, wheel zooms, title drag
 *     moves a node, dragging output → input asks OnConnect, clicking a wire selects it and Delete asks OnDisconnect.
 *     Double click on a node calls OnOpen.
 */
class RiotNodeGraph {
  constructor(Container, Options = {}) {
    this.Container = Container;
    this.Options = Options;
    this.Nodes = new Map();
    this.Edges = [];
    this.Scale = 1;
    this.PanX = 40;
    this.PanY = 40;
    this.SelectedEdge = null;
    this.SelectedNode = null;
    Container.classList.add('NodeGraph');
    Container.tabIndex = 0;
    this.Surface = document.createElement('div');
    this.Surface.className = 'NodeSurface';
    this.Wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.Wires.classList.add('NodeWires');
    this.Surface.appendChild(this.Wires);
    Container.appendChild(this.Surface);
    this.Bind();
    new ResizeObserver(() => this.DrawWires()).observe(Container);
  }

  // ------------------------------------------------------------------ dados / data
  SetData(Nodes, Edges, KeepView) {
    for (const Element of this.Surface.querySelectorAll('.Node')) Element.remove();
    this.Nodes.clear();
    this.SelectedEdge = null;
    for (const Node of Nodes) this.AddNode(Node);
    this.Edges = Edges.slice();
    this.StackColumns();
    if (!KeepView) this.Fit();
    this.DrawWires();
  }

  AddNode(Node) {
    const Element = document.createElement('div');
    Element.className = 'Node' + (Node.Muted ? ' Muted' : '') + (Node.Class ? ' ' + Node.Class : '');
    Element.dataset.id = Node.Id;
    if (Node.Width) Element.style.width = Node.Width + 'px';
    const Head = document.createElement('div');
    Head.className = 'NodeHead';
    if (Node.Color) Head.style.background = Node.Color;
    const Title = document.createElement('b');
    Title.textContent = Node.Title;
    Head.appendChild(Title);
    if (Node.Subtitle) { const Sub = document.createElement('small'); Sub.textContent = Node.Subtitle; Head.appendChild(Sub); }
    Element.appendChild(Head);
    if (Node.Thumbnail) { Node.Thumbnail.classList.add('NodeThumb'); Element.appendChild(Node.Thumbnail); }
    const Body = document.createElement('div');
    Body.className = 'NodeBody';
    const PortRow = (Port, Side) => {
      const Row = document.createElement('div');
      Row.className = 'NodePort ' + Side;
      const Dot = document.createElement('i');
      Dot.dataset.node = Node.Id;
      Dot.dataset.port = Port.Key;
      Dot.dataset.side = Side;
      if (Port.Color) Dot.style.background = Port.Color;
      const Label = document.createElement('span');
      Label.textContent = Port.Label || '';
      if (Side === 'In') Row.append(Dot, Label); else Row.append(Label, Dot);
      return Row;
    };
    for (const Port of Node.Outputs || []) Body.appendChild(PortRow(Port, 'Out'));
    for (const Port of Node.Inputs || []) Body.appendChild(PortRow(Port, 'In'));
    for (const Row of Node.Rows || []) { Row.classList.add('NodeRow'); Body.appendChild(Row); }
    Element.appendChild(Body);
    Element.style.left = Node.X + 'px';
    Element.style.top = Node.Y + 'px';
    this.Surface.appendChild(Element);
    this.Nodes.set(String(Node.Id), { Node, Element });
    Element.addEventListener('pointerdown', Event => { if (!Event.target.closest('input,select,button,textarea')) this.SelectNode(Node.Id); });
    Element.addEventListener('dblclick', Event => { if (!Event.target.closest('input,select,button,textarea') && this.Options.OnOpen) this.Options.OnOpen(Node); });
    Head.addEventListener('pointerdown', Event => this.DragNode(Event, Node, Element));
  }

  /**
   * PT: Empilha os nós de cada coluna (mesmo X) pela altura real, na ordem dos Y pedidos.
   * EN: Stacks each column's nodes (same X) by their real height, keeping the requested Y order.
   */
  StackColumns(Gap = 18) {
    const Columns = new Map();
    for (const Entry of this.Nodes.values()) {
      const Key = Math.round(Entry.Node.X);
      if (!Columns.has(Key)) Columns.set(Key, []);
      Columns.get(Key).push(Entry);
    }
    for (const Entries of Columns.values()) {
      if (Entries.some(Entry => !Entry.Element.offsetHeight)) continue;
      Entries.sort((A, B) => A.Node.Y - B.Node.Y);
      let Y = Entries[0].Node.Y;
      for (const Entry of Entries) {
        Entry.Node.Y = Y;
        Entry.Element.style.top = Y + 'px';
        Y += Entry.Element.offsetHeight + Gap;
      }
    }
  }

  SelectNode(Id) {
    this.SelectedNode = Id === null ? null : String(Id);
    for (const { Element } of this.Nodes.values()) Element.classList.toggle('Selected', Element.dataset.id === this.SelectedNode);
    if (this.Options.OnSelect) this.Options.OnSelect(Id === null ? null : this.Nodes.get(String(Id)).Node);
  }

  // ------------------------------------------------------------------ vista / view
  Apply() {
    this.Surface.style.transform = `translate(${this.PanX}px, ${this.PanY}px) scale(${this.Scale})`;
  }

  /** PT: Enquadra todos os nós. EN: Frames every node. */
  Fit() {
    if (!this.Nodes.size) { this.Scale = 1; this.PanX = 40; this.PanY = 40; this.Apply(); return; }
    let MinX = Infinity, MinY = Infinity, MaxX = -Infinity, MaxY = -Infinity;
    for (const { Node, Element } of this.Nodes.values()) {
      MinX = Math.min(MinX, Node.X); MinY = Math.min(MinY, Node.Y);
      MaxX = Math.max(MaxX, Node.X + (Element.offsetWidth || 220)); MaxY = Math.max(MaxY, Node.Y + (Element.offsetHeight || 80));
    }
    const Width = Math.max(1, this.Container.clientWidth), Height = Math.max(1, this.Container.clientHeight);
    this.Scale = Math.max(0.2, Math.min(1.1, Math.min((Width - 60) / (MaxX - MinX), (Height - 60) / (MaxY - MinY))));
    this.PanX = (Width - (MaxX - MinX) * this.Scale) / 2 - MinX * this.Scale;
    this.PanY = (Height - (MaxY - MinY) * this.Scale) / 2 - MinY * this.Scale;
    this.Apply();
  }

  /** PT: Ponto da tela -> coordenadas da superfície. EN: Screen point -> surface coordinates. */
  ToSurface(ClientX, ClientY) {
    const Box = this.Container.getBoundingClientRect();
    return [(ClientX - Box.left - this.PanX) / this.Scale, (ClientY - Box.top - this.PanY) / this.Scale];
  }

  PortPoint(NodeId, PortKey, Side) {
    const Entry = this.Nodes.get(String(NodeId));
    if (!Entry) return null;
    const Dot = Entry.Element.querySelector(`i[data-side="${Side}"][data-port="${CSS.escape(String(PortKey))}"]`);
    if (!Dot) return null;
    const Box = Dot.getBoundingClientRect();
    return this.ToSurface(Box.left + Box.width / 2, Box.top + Box.height / 2);
  }

  // ------------------------------------------------------------------ fios / wires
  DrawWires(Preview) {
    const Svg = this.Wires;
    while (Svg.firstChild) Svg.firstChild.remove();
    const Make = (Name, Attributes) => { const Element = document.createElementNS('http://www.w3.org/2000/svg', Name); for (const [Key, Value] of Object.entries(Attributes)) Element.setAttribute(Key, Value); return Element; };
    const Curve = (A, B) => { const Bend = Math.max(40, Math.abs(B[0] - A[0]) * 0.45); return `M${A[0]},${A[1]} C${A[0] + Bend},${A[1]} ${B[0] - Bend},${B[1]} ${B[0]},${B[1]}`; };
    this.Edges.forEach((Edge, Index) => {
      const A = this.PortPoint(Edge.From[0], Edge.From[1], 'Out'), B = this.PortPoint(Edge.To[0], Edge.To[1], 'In');
      if (!A || !B) return;
      const Path = Curve(A, B);
      const Selected = this.SelectedEdge === Index;
      const Wire = Make('path', { d: Path, class: 'Wire' + (Edge.Dashed ? ' Dashed' : '') + (Selected ? ' Selected' : '') });
      if (Edge.Color && !Selected) Wire.style.stroke = Edge.Color;
      const Hit = Make('path', { d: Path, class: 'WireHit' });
      Hit.addEventListener('pointerdown', Event => { Event.stopPropagation(); this.SelectedEdge = Index; this.Container.focus(); this.DrawWires(); if (this.Options.OnEdgeSelect) this.Options.OnEdgeSelect(Edge); });
      Svg.append(Wire, Hit);
      if (Edge.Label) {
        const Text = Make('text', { x: (A[0] + B[0]) / 2, y: (A[1] + B[1]) / 2 - 5, class: 'WireLabel', 'text-anchor': 'middle' });
        Text.textContent = Edge.Label;
        Svg.appendChild(Text);
      }
    });
    if (Preview) Svg.appendChild(Make('path', { d: Curve(Preview[0], Preview[1]), class: 'Wire Preview' }));
  }

  // ------------------------------------------------------------------ interação / interaction
  Bind() {
    const Container = this.Container;
    Container.addEventListener('wheel', Event => {
      Event.preventDefault();
      const [X, Y] = this.ToSurface(Event.clientX, Event.clientY);
      this.Scale = Math.max(0.15, Math.min(2.5, this.Scale * Math.pow(1.1, -Math.sign(Event.deltaY))));
      const Box = Container.getBoundingClientRect();
      this.PanX = Event.clientX - Box.left - X * this.Scale;
      this.PanY = Event.clientY - Box.top - Y * this.Scale;
      this.Apply();
    }, { passive: false });
    Container.addEventListener('pointerdown', Event => {
      const Dot = Event.target.closest('i[data-side]');
      if (Dot && Dot.dataset.side === 'Out') { this.DragWire(Event, Dot); return; }
      if (Event.target.closest('.Node')) return;
      if (this.SelectedEdge !== null) { this.SelectedEdge = null; this.DrawWires(); }
      this.SelectNode(null);
      const StartX = Event.clientX, StartY = Event.clientY, PanX = this.PanX, PanY = this.PanY;
      Container.setPointerCapture(Event.pointerId);
      const Move = Moved => { this.PanX = PanX + Moved.clientX - StartX; this.PanY = PanY + Moved.clientY - StartY; this.Apply(); };
      const Up = () => { Container.removeEventListener('pointermove', Move); Container.removeEventListener('pointerup', Up); };
      Container.addEventListener('pointermove', Move);
      Container.addEventListener('pointerup', Up);
    });
    Container.addEventListener('keydown', Event => {
      if (/INPUT|SELECT|TEXTAREA/.test(Event.target.tagName)) return;
      if ((Event.key === 'Delete' || Event.key === 'Backspace') && this.SelectedEdge !== null) {
        Event.preventDefault();
        const Edge = this.Edges[this.SelectedEdge];
        this.SelectedEdge = null;
        if (Edge && this.Options.OnDisconnect) this.Options.OnDisconnect(Edge);
      } else if (Event.key === 'f' || Event.key === 'F') this.Fit();
    });
  }

  DragNode(Event, Node, Element) {
    if (Event.button !== 0) return;
    Event.stopPropagation();
    const [StartX, StartY] = this.ToSurface(Event.clientX, Event.clientY), X = Node.X, Y = Node.Y;
    Element.setPointerCapture(Event.pointerId);
    const Move = Moved => {
      const [NowX, NowY] = this.ToSurface(Moved.clientX, Moved.clientY);
      Node.X = X + NowX - StartX; Node.Y = Y + NowY - StartY;
      Element.style.left = Node.X + 'px'; Element.style.top = Node.Y + 'px';
      this.DrawWires();
    };
    const Up = () => { Element.removeEventListener('pointermove', Move); Element.removeEventListener('pointerup', Up); if (this.Options.OnMove) this.Options.OnMove(Node); };
    Element.addEventListener('pointermove', Move);
    Element.addEventListener('pointerup', Up);
  }

  DragWire(Event, Dot) {
    Event.stopPropagation();
    Event.preventDefault();
    const From = [Dot.dataset.node, Dot.dataset.port];
    const Start = this.PortPoint(From[0], From[1], 'Out');
    this.Container.setPointerCapture(Event.pointerId);
    const Move = Moved => this.DrawWires([Start, this.ToSurface(Moved.clientX, Moved.clientY)]);
    const Up = Released => {
      this.Container.removeEventListener('pointermove', Move);
      this.Container.removeEventListener('pointerup', Up);
      const Target = document.elementFromPoint(Released.clientX, Released.clientY);
      const InDot = Target && Target.closest('i[data-side="In"]');
      this.DrawWires();
      if (InDot && this.Options.OnConnect && InDot.dataset.node !== From[0]) this.Options.OnConnect(From, [InDot.dataset.node, InDot.dataset.port]);
    };
    this.Container.addEventListener('pointermove', Move);
    this.Container.addEventListener('pointerup', Up);
  }
}
