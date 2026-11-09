/*
 * RiotScriptTab — aba Scripting: a lógica da fase como nós / Scripting tab: the level logic as nodes
 *
 * PT: O jogo não tem scripts em texto: a lógica são objetos da fase ligados entre si. Cada objeto tem propriedades de
 *     SAÍDA (a mensagem que ele manda para TODAS as suas ligações quando o evento acontece) e de ENTRADA (a mensagem que
 *     ele escuta); a lista de ligações (Links) fica no .lvl, na instância de origem. Um alvo só reage quando uma
 *     entrada dele (ou uma entrada fixa da classe) bate com uma mensagem mandada — o fio mostra quais batem; fio
 *     tracejado = ligação que o alvo ignora.
 *     A lista à direita traz os "pontos de entrada" (objetos que ninguém liga: detectores, interruptores, timers…);
 *     escolher um mostra a cadeia que sai dele. Clique duplo num nó recentra nele. Arrastar da porta "Links" de um nó
 *     até a porta de entrada de outro cria uma ligação; clicar num fio + Delete apaga. Mudar a mensagem de uma
 *     saída/entrada edita a propriedade. Tudo vai para o .lvl pelo mesmo "Salvar" da aba Fase.
 * EN: The game has no text scripts: the logic is level objects linked together. Output properties hold the message an
 *     object sends to ALL its links; input properties hold what it listens to; the Links list lives on the source
 *     instance in the .lvl. Wires show which messages match (dashed = the target ignores it). Entry points (objects
 *     nobody links to) are listed on the right. Drag "Links" → input to link, select a wire + Delete to unlink, edit a
 *     message to change the property. Saved to the .lvl with the Level tab's Save.
 */
(() => {
  const $ = Id => document.getElementById(Id);
  const { Make, Remember } = RiotAssetTabs.Shared;
  const Ui = () => RiotAssetTabs.Shared.Ui();
  const PathClasses = /^(Move Node Object|Path Node|Waypoint)$/;
  const ClassColors = [[/Detector|Trigger|Switch|Button|Volume/, '#5a4a20'], [/Relay|Timer|Counter|Filter|Logic|Random/, '#2f4660'], [/Light|Sound|Music|Fx|Particle|Generator/, '#4a3456'],
    [/NPC|Creature|Horace|Torque|Character|Spawn/, '#5a2e2a'], [/Door|Static|Animating|Breakable|Decoration/, '#2f5040']];

  const ScriptTab = {
    Data: null, ById: new Map(), Key: null, Root: null, Expanded: new Set(), Graph: null, Entries: [],

    Open() { if (!this.Opening) this.Opening = this.OpenOnce(); return this.Opening; },

    async OpenOnce() {
      this.Graph = new RiotNodeGraph($('ScriptGraph'), {
        OnConnect: (From, To) => this.Connect(Number(From[0]), Number(To[0])),
        OnDisconnect: Edge => this.Disconnect(Number(Edge.From[0]), Number(Edge.To[0])),
        OnOpen: Node => this.Focus(Number(Node.Id)),
      });
      const Select = $('ScriptLevel');
      for (const Level of Ui().Levels()) {
        const Option = document.createElement('option');
        Option.value = Level.Key;
        Option.textContent = Level.File === Level.Name ? Level.File : `${Level.File} — ${Level.Name}`;
        Select.appendChild(Option);
      }
      Select.addEventListener('change', () => this.LoadLevel(Select.value));
      $('ScriptFilter').addEventListener('input', () => this.RenderList());
      $('ScriptHidePaths').addEventListener('change', () => { this.Index(); this.RenderList(); if (this.Root !== null) this.Focus(this.Root); });
      $('ScriptFromLevel').addEventListener('click', () => {
        const Id = Ui().SelectedInstanceId();
        if (Id === null) { Ui().SetStatus(Text('ScriptNoSelection')); return; }
        this.FocusAny(Id);
      });
      $('ScriptSave').addEventListener('click', async () => { await Ui().SaveLevel(); await this.LoadLevel(this.Key, true); });
      $('ScriptFit').addEventListener('click', () => this.Graph.Fit());
      const Previous = Ui().OnDirty;
      Ui().OnDirty = Count => { if (Previous) Previous(Count); $('ScriptSave').disabled = !Count; };
      const Current = Ui().Stage().LevelView.Scene;
      Select.value = Current ? Current.Key : (Remember('ScriptLevel') || Select.value);
      await this.LoadLevel(Select.value);
    },

    async LoadLevel(Key, KeepFocus) {
      if (!Key) return;
      Remember('ScriptLevel', Key);
      $('ScriptLevel').value = Key;
      $('ScriptCount').textContent = Text('AssetLoading');
      // PT: as edições ficam na fase aberta da aba Fase: troca a fase lá também / EN: edits belong to the Level tab's level
      const View = Ui().Stage().LevelView;
      if (!View.Scene || View.Scene.Key !== Key) await Ui().LoadLevel(Key);
      const Data = await Ui().FetchJson('/api/LevelScript/' + encodeURIComponent(Key));
      if (Data.Error) { $('ScriptCount').textContent = Data.Error; return; }
      this.Data = Data;
      this.Key = Key;
      this.ById = new Map(Data.Nodes.map(Node => [Node.Id, Node]));
      this.Options();
      this.Index();
      this.RenderList();
      $('ScriptSave').disabled = !Ui().DirtyCount();
      if (KeepFocus && this.Root !== null && this.ById.has(this.Root)) this.Focus(this.Root, true);
      else if (this.Entries.length) this.Focus(this.Entries[0].Id);
      else this.Graph.SetData([], []);
    },

    /** PT: Lista de mensagens para os campos (um datalist só). EN: Message list for the fields (one datalist). */
    Options() {
      const List = $('ScriptMessages');
      List.innerHTML = '';
      for (const [Id, Name] of Object.entries(this.Data.MessageNames).sort((A, B) => A[0] - B[0])) {
        const Option = document.createElement('option');
        Option.value = `${Id} · ${Name}`;
        List.appendChild(Option);
      }
    },

    Hidden(Node) { return $('ScriptHidePaths').checked && PathClasses.test(Node.Class); },

    /** PT: Ligações atuais (com edições). EN: Current links (with edits). */
    LinksOf(Node) { const Edited = Ui().EditedLinks(Node.Id); return Edited || Node.Links; },

    /** PT: Mensagem atual de uma propriedade (com edições). EN: Current message of a property (with edits). */
    MessageOf(Node, Port) { const Edited = Ui().EditedProperty(Node.Id, Port.Property); return Edited !== undefined ? Edited : Port.Message; },

    Index() {
      this.Incoming = new Map();
      for (const Node of this.Data.Nodes) {
        if (this.Hidden(Node)) continue;
        for (const Target of this.LinksOf(Node)) if (this.ById.has(Target) && !this.Hidden(this.ById.get(Target))) this.Incoming.set(Target, (this.Incoming.get(Target) || 0) + 1);
      }
      // PT: pontos de entrada: ninguém liga para eles, mas eles ligam para alguém / EN: nobody links to them, they link out
      this.Entries = this.Data.Nodes.filter(Node => !this.Hidden(Node) && !this.Incoming.get(Node.Id) && this.LinksOf(Node).some(Target => this.ById.has(Target)))
        .map(Node => ({ Id: Node.Id, Class: Node.Class, Reach: this.Reach(Node.Id) }))
        .sort((A, B) => (A.Class.startsWith('?') - B.Class.startsWith('?')) || A.Class.localeCompare(B.Class) || B.Reach - A.Reach);
    },

    Reach(Id) {
      const Seen = new Set([Id]), Queue = [Id];
      while (Queue.length && Seen.size < 500) {
        const Node = this.ById.get(Queue.shift());
        for (const Target of Node ? this.LinksOf(Node) : []) if (this.ById.has(Target) && !Seen.has(Target) && !this.Hidden(this.ById.get(Target))) { Seen.add(Target); Queue.push(Target); }
      }
      return Seen.size;
    },

    RenderList() {
      const Query = $('ScriptFilter').value.trim().toLowerCase();
      const Rows = $('ScriptList');
      Rows.innerHTML = '';
      const Shown = this.Entries.filter(Entry => !Query || `${Entry.Class} ${Entry.Id}`.toLowerCase().includes(Query));
      // PT: a busca também acha objetos que não são ponto de entrada / EN: the search also finds non-entry objects
      const Extra = Query ? this.Data.Nodes.filter(Node => !this.Hidden(Node) && !Shown.some(Entry => Entry.Id === Node.Id) && `${Node.Class} ${Node.Id}`.toLowerCase().includes(Query)).slice(0, 200) : [];
      $('ScriptCount').textContent = Text('ScriptCountText', { Entries: NumberText(Shown.length), Objects: NumberText(this.Data.Nodes.length) });
      for (const Entry of [...Shown, ...Extra.map(Node => ({ Id: Node.Id, Class: Node.Class, Reach: null }))].slice(0, 2000)) {
        const Row = Make('div', 'AssetRow');
        Row.setAttribute('role', 'option');
        Row.tabIndex = 0;
        Row.dataset.ref = String(Entry.Id);
        Row.setAttribute('aria-selected', String(Entry.Id === this.Root));
        Row.append(Make('span', 'Ref', '#' + Entry.Id), Make('span', 'Name', Entry.Class),
          Make('span', 'Meta', Entry.Reach === null ? '' : Text('ScriptReach', { Count: Entry.Reach })));
        Row.addEventListener('click', () => this.Focus(Entry.Id));
        Rows.appendChild(Row);
      }
    },

    // ------------------------------------------------------------------ grafo / graph
    /**
     * PT: Foca um objeto mesmo sem ligações: busca o nó dele e o mostra sozinho (entradas/saídas de mensagem visíveis,
     *     dá para arrastar um link a partir dele).
     * EN: Focuses any object; an unlinked one is fetched and shown alone.
     */
    async FocusAny(Id) {
      if (!this.ById.has(Id)) {
        let Node = null;
        try { Node = await Ui().FetchJson(`/api/LevelScriptNode/${encodeURIComponent(this.Key)}/${Id}`); } catch (Error) { Node = null; }
        if (!Node || Node.Error) { Ui().SetStatus(Text('ScriptNotLinked')); return false; }
        this.ById.set(Id, Node);
        this.Data.Nodes.push(Node);
        Ui().SetStatus(Text('ScriptAlone'));
      }
      this.Focus(Id);
      return true;
    },

    /** PT: Mostra o nó, a cadeia que sai dele (até 4 passos) e quem liga para ele. EN: Node, its downstream chain and callers. */
    Focus(Id, KeepView) {
      this.Root = Id;
      for (const Row of document.querySelectorAll('#ScriptList .AssetRow')) Row.setAttribute('aria-selected', String(Number(Row.dataset.ref) === Id));
      const Depth = new Map([[Id, 0]]), Queue = [Id], Limit = 90;
      while (Queue.length && Depth.size < Limit) {
        const Current = Queue.shift(), Node = this.ById.get(Current);
        if (!Node || Depth.get(Current) >= 4) continue;
        for (const Target of this.LinksOf(Node)) {
          if (!this.ById.has(Target) || Depth.has(Target) || this.Hidden(this.ById.get(Target))) continue;
          Depth.set(Target, Depth.get(Current) + 1);
          Queue.push(Target);
          if (Depth.size >= Limit) break;
        }
      }
      for (const Node of this.Data.Nodes) {
        if (Depth.size >= Limit + 15) break;
        if (!Depth.has(Node.Id) && !this.Hidden(Node) && this.LinksOf(Node).includes(Id)) Depth.set(Node.Id, -1);
      }
      // PT: colunas por profundidade / EN: columns by depth
      const Columns = new Map();
      for (const [NodeId, Level] of Depth) { if (!Columns.has(Level)) Columns.set(Level, []); Columns.get(Level).push(NodeId); }
      const Nodes = [];
      for (const [Level, Ids] of [...Columns].sort((A, B) => A[0] - B[0])) {
        let Y = 0;
        for (const NodeId of Ids) {
          const Node = this.MakeNode(this.ById.get(NodeId), NodeId === Id);
          Node.X = (Level + 1) * 330;
          Node.Y = Y;
          Y += 70 + 22 * Node.Rows.length;
          Nodes.push(Node);
        }
      }
      const Edges = [];
      for (const NodeId of Depth.keys()) {
        const Source = this.ById.get(NodeId);
        const Sent = new Set(Source.Outputs.map(Port => this.MessageOf(Source, Port)).filter(Boolean));
        for (const Target of this.LinksOf(Source)) {
          if (!Depth.has(Target)) continue;
          const Node = this.ById.get(Target);
          const Heard = [...Node.Inputs.map(Port => this.MessageOf(Node, Port)), ...Node.Fixed.map(Port => Port.Message)].filter(Message => Message && Sent.has(Message));
          const Names = [...new Set(Heard)].map(Message => this.Data.MessageNames[Message] || Message);
          Edges.push({ From: [NodeId, 'out'], To: [Target, 'in'], Label: Names.join(', '), Dashed: !Names.length });
        }
      }
      this.Graph.SetData(Nodes, Edges, KeepView);
      this.Graph.SelectNode(Id);
      $('ScriptRoot').textContent = Text('ScriptRootText', { Class: this.ById.get(Id).Class, Id, Count: Depth.size });
    },

    MakeNode(Node, IsRoot) {
      const Rows = [];
      const Expanded = this.Expanded.has(Node.Id);
      const Field = (Port, Kind) => {
        const Message = this.MessageOf(Node, Port);
        const Row = Make('label', 'ScriptRow ' + Kind);
        const Name = Port.Label ? Port.Label[RiotLanguage === 'pt' ? 0 : 1].replace(/^(Entrada|Saída|Input|Output): /, '') : '';
        const Prop = Make('span', 'ScriptProp', `${Kind === 'Out' ? '→' : '←'} p${Port.Property}${Name ? ' ' + Name : ''}`);
        if (Port.Label) Prop.title = `p${Port.Property} · ${Port.Label[RiotLanguage === 'pt' ? 0 : 1]}`;
        Row.appendChild(Prop);
        const Input = document.createElement('input');
        Input.setAttribute('list', 'ScriptMessages');
        Input.value = Message ? `${Message} · ${this.Data.MessageNames[Message] || '?'}` : '';
        Input.placeholder = '—';
        Input.title = Text(Kind === 'Out' ? 'ScriptOutputTip' : 'ScriptInputTip');
        if (Message !== Port.Message) Row.classList.add('Edited');
        Input.addEventListener('change', () => {
          const Value = Input.value.trim() === '' ? 0 : parseInt(Input.value, 10);
          if (!Number.isFinite(Value) || Value < 0) { Input.value = Message ? `${Message} · ${this.Data.MessageNames[Message] || '?'}` : ''; return; }
          Ui().SetInstanceProperty(Node.Id, Port.Property, Value, Port.Message);
          this.Focus(this.Root, true);
        });
        Row.appendChild(Input);
        return Row;
      };
      let Empty = 0;
      for (const Port of Node.Outputs) { if (this.MessageOf(Node, Port) || Expanded) Rows.push(Field(Port, 'Out')); else Empty++; }
      for (const Port of Node.Inputs) { if (this.MessageOf(Node, Port) || Expanded) Rows.push(Field(Port, 'In')); else Empty++; }
      if (Node.Fixed.length) Rows.push(Make('div', 'ScriptFixed', Text('ScriptFixed', { List: Node.Fixed.map(Port => Port.Name || Port.Message).join(', ') })));
      if (Empty || Expanded) {
        const More = Make('button', 'ScriptMore', Expanded ? Text('ScriptLess') : Text('ScriptMore', { Count: Empty }));
        More.addEventListener('click', () => { if (Expanded) this.Expanded.delete(Node.Id); else this.Expanded.add(Node.Id); this.Focus(this.Root, true); });
        Rows.push(More);
      }
      // PT: Sound Effect: ▶ toca cada som da lista p0 (clique de novo para parar) / EN: play each sound of the p0 list
      for (const Ref of Node.Sounds || []) {
        const Play = Make('button', 'ScriptMore ScriptPlay', `▶ ${Text('ScriptPlaySound', { Ref })}`);
        Play.addEventListener('click', Event => {
          Event.stopPropagation();
          const Idle = () => { Play.textContent = `▶ ${Text('ScriptPlaySound', { Ref })}`; };
          if (Ui().ToggleSound(Ref, Idle)) Play.textContent = `■ ${Text('ScriptPlaySound', { Ref })}`; else Idle();
        });
        Rows.push(Play);
      }
      const Go = Make('button', 'ScriptMore', Text('ScriptGoLevel'));
      Go.addEventListener('click', () => Ui().GoToInstance(Node.Id, Node.Position));
      Rows.push(Go);
      const Links = this.LinksOf(Node);
      const Color = (ClassColors.find(([Pattern]) => Pattern.test(Node.Class)) || [null, '#33363c'])[1];
      return {
        Id: Node.Id, Title: Node.Class, Subtitle: `#${Node.Id}` + (Ui().EditedLinks(Node.Id) ? ' · ' + Text('ScriptEdited') : ''), Color, Width: 250,
        Class: IsRoot ? 'Root' : '',
        Inputs: [{ Key: 'in', Label: Text('ScriptIn', { Count: this.Incoming.get(Node.Id) || 0 }) }],
        Outputs: [{ Key: 'out', Label: Text('ScriptOut', { Count: Links.length }) }],
        Rows,
      };
    },

    Connect(SourceId, TargetId) {
      const Source = this.ById.get(SourceId);
      if (!Source || !this.ById.has(TargetId)) return;
      const Links = this.LinksOf(Source).slice();
      if (Links.includes(TargetId)) return;
      Links.push(TargetId);
      Ui().SetInstanceLinks(SourceId, Links, Source.Links);
      this.Index();
      this.Focus(this.Root, true);
    },

    Disconnect(SourceId, TargetId) {
      const Source = this.ById.get(SourceId);
      if (!Source) return;
      const Links = this.LinksOf(Source).filter(Id => Id !== TargetId);
      Ui().SetInstanceLinks(SourceId, Links, Source.Links);
      this.Index();
      this.RenderList();
      this.Focus(this.Root, true);
    },

    Relabel() { if (this.Data) { this.RenderList(); if (this.Root !== null) this.Focus(this.Root, true); } },
    Show(Active) { if (Active) this.Open(); },
  };

  RiotAssetTabs.Register('Scripting', ScriptTab);
})();
