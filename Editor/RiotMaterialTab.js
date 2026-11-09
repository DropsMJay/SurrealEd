/*
 * RiotMaterialTab — aba Material: materiais como nós, com prévia / Material tab: materials as nodes, with preview
 *
 * PT: Lista os materiais de um pacote (templates do .odu das classes de material do motor: Simple, Advanced, Layered,
 *     Animating, Landscape) e mostra cada um como um grafo: texturas / quadros / camadas / curva de rolagem (.wdu)
 *     entrando no nó do material (parâmetros editáveis) e dele para a saída. Em cima, uma prévia num plano, numa esfera
 *     e num cubo com a mesma mistura, tinta e animação usadas no visor da fase. Gravar troca só os slots mudados do
 *     template no .odu (vale para todas as fases que usam o material; backup na primeira vez).
 *     Slots sem nome conhecido aparecem como valor bruto (hex) marcados "(?)".
 * EN: Lists a package's materials and shows each as a graph: textures / frames / layers / scroll curve into the
 *     material node (editable parameters) and on to the output, with a live preview on top. Saving patches only the
 *     changed template slots in the .odu (affects every level using the material; backup on first save).
 */
(() => {
  const $ = Id => document.getElementById(Id);
  const { Make, SplitRef, LoadPackages, FillPackageSelect, Remember } = RiotAssetTabs.Shared;
  const Ui = () => RiotAssetTabs.Shared.Ui();
  const BitsFloat = Raw => { const View = new DataView(new ArrayBuffer(4)); View.setUint32(0, Raw >>> 0, true); return View.getFloat32(0, true); };
  const FloatBits = Value => { const View = new DataView(new ArrayBuffer(4)); View.setFloat32(0, Value, true); return View.getUint32(0, true); };
  const RefText = Raw => (Raw >>> 16) ? `${Raw >>> 16}_${(Raw & 0xFFFF).toString(16).padStart(4, '0')}` : '';
  const ParseRef = Text => { const Match = /^\s*(\d+)_([0-9a-f]{1,4})\s*$/i.exec(Text || ''); return Match ? ((Number(Match[1]) << 16) | parseInt(Match[2], 16)) >>> 0 : (Text.trim() === '' ? 0 : null); };
  const Label = Row => (RiotLanguage === 'pt' ? Row.Pt : Row.En);

  // ------------------------------------------------------------------ prévia / preview
  class MaterialPreview {
    constructor(Container) {
      this.Container = Container;
      this.Renderer = new THREE.WebGLRenderer({ antialias: true });
      this.Renderer.outputEncoding = THREE.sRGBEncoding;
      Container.appendChild(this.Renderer.domElement);
      this.Scene = new THREE.Scene();
      this.Scene.background = new THREE.Color(0x24262a);
      this.Camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
      this.Camera.position.set(0, 1.6, 4.2);
      this.Camera.lookAt(0, 0.4, 0);
      this.Scene.add(new THREE.AmbientLight(0xffffff, 0.45));
      const Sun = new THREE.DirectionalLight(0xffffff, 0.9);
      Sun.position.set(2, 3, 2);
      this.Scene.add(Sun);
      const Geometries = [new THREE.PlaneGeometry(6, 3), new THREE.SphereGeometry(0.7, 48, 24), new THREE.BoxGeometry(1, 1, 1)];
      this.Meshes = Geometries.map(Geometry => new THREE.Mesh(Geometry, new THREE.MeshBasicMaterial({ color: 0x555555 })));
      this.Meshes[0].rotation.x = -Math.PI / 2;
      this.Meshes[0].position.set(0, -0.3, -0.4);
      this.Meshes[1].position.set(-0.95, 0.45, 0);
      this.Meshes[2].position.set(0.95, 0.25, 0);
      for (const Mesh of this.Meshes) this.Scene.add(Mesh);
      this.Clock = new THREE.Clock();
      this.Maps = [];
      this.State = null;
      this.Active = false;
      new ResizeObserver(() => this.Resize()).observe(Container);
      this.Resize();
      const Loop = () => { if (this.Active) this.Frame(); requestAnimationFrame(Loop); };
      requestAnimationFrame(Loop);
    }

    Resize() {
      const Width = Math.max(1, this.Container.clientWidth), Height = Math.max(1, this.Container.clientHeight);
      this.Renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.Renderer.setSize(Width, Height, false);
      this.Camera.aspect = Width / Height;
      this.Camera.updateProjectionMatrix();
    }

    /** PT: State: { Maps: [DataTexture], Fps, Blend, Tint, AlphaIsMask, Scale, Offset, Wave }. EN: Preview state. */
    Set(State) {
      this.State = State;
      const Blend = State.Blend || 'opaque', Map = State.Maps[0] || null;
      const Options = { map: Map, side: THREE.DoubleSide };
      if (Blend === 'alpha' || Blend === 'oneA') Object.assign(Options, { transparent: !State.AlphaIsMask, alphaTest: 0.01, depthWrite: false });
      else if (Blend === 'cutout') Object.assign(Options, { alphaTest: 0.5 });
      else if (Blend === 'add') Object.assign(Options, { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      else if (Blend === 'sub') Object.assign(Options, { transparent: true, blending: THREE.SubtractiveBlending, depthWrite: false });
      else if (Blend === 'mul' || Blend === 'mulA' || Blend === 'mod2x') Object.assign(Options, { transparent: true, blending: THREE.MultiplyBlending, depthWrite: false });
      // PT: passe sem luz e tingido: textura × tinta / EN: unlit tinted pass: texture × tint
      const Material = State.Tint ? new THREE.MeshBasicMaterial(Object.assign(Options, { color: new THREE.Color(State.Tint).convertSRGBToLinear() }))
        : new THREE.MeshLambertMaterial(Options);
      if (!Map) Material.color = new THREE.Color(0x7a7d76);
      for (const Mesh of this.Meshes) { Mesh.material.dispose(); Mesh.material = Material; }
    }

    Frame() {
      const Time = this.Clock.getElapsedTime(), State = this.State;
      this.Meshes[1].rotation.y = Time * 0.4;
      this.Meshes[2].rotation.set(Time * 0.3, Time * 0.5, 0);
      if (State) {
        const Material = this.Meshes[0].material;
        if (State.Maps.length > 1 && State.Fps > 0) {
          const Map = State.Maps[Math.floor(Time * State.Fps) % State.Maps.length];
          if (Material.map !== Map) { Material.map = Map; Material.needsUpdate = true; }
        }
        if (Material.map) {
          const Scale = State.Scale || 1;
          let U = State.Offset ? State.Offset[0] : 0, V = State.Offset ? State.Offset[1] : 0;
          if (State.Wave && State.Wave.Channels >= 2) {
            // PT: curva .wdu (canais u/v somados às coordenadas, em loop) / EN: .wdu curve added to UVs, looped
            const Wave = State.Wave, Count = Wave.Samples.length / Wave.Channels;
            const Position = (Time * Wave.Rate) % Math.max(1, Count), Index = Math.floor(Position), Next = (Index + 1) % Count, T = Position - Index;
            U += Wave.Samples[Index * Wave.Channels] * (1 - T) + Wave.Samples[Next * Wave.Channels] * T;
            V += Wave.Samples[Index * Wave.Channels + 1] * (1 - T) + Wave.Samples[Next * Wave.Channels + 1] * T;
          }
          Material.map.repeat.set(Scale, Scale);
          Material.map.offset.set(U, V);
        }
      }
      this.Renderer.render(this.Scene, this.Camera);
    }
  }

  // ------------------------------------------------------------------ aba / tab
  const MaterialTab = {
    List: [], Selected: null, Info: null, Changes: new Map(), Decoded: new Map(), Graph: null, Preview: null, Request: 0,

    Open() { if (!this.Opening) this.Opening = this.OpenOnce(); return this.Opening; },

    async OpenOnce() {
      this.Graph = new RiotNodeGraph($('MaterialGraph'), { OnOpen: Node => { if (Node.Ref && Node.Kind === 'material') this.OpenRef(Node.Ref); } });
      this.Preview = new MaterialPreview($('MaterialPreview'));
      this.Preview.Active = true;
      await LoadPackages();
      FillPackageSelect($('MaterialPackage'), 'Textures', 'NPCs');
      const Wanted = Remember('MaterialPackage');
      if (Wanted && [...$('MaterialPackage').options].some(Option => Option.value === Wanted)) $('MaterialPackage').value = Wanted;
      $('MaterialPackage').addEventListener('change', () => { Remember('MaterialPackage', $('MaterialPackage').value); this.LoadPackage(); });
      $('MaterialFilter').addEventListener('input', () => this.RenderList());
      $('MaterialSave').addEventListener('click', () => this.Save());
      $('MaterialRevert').addEventListener('click', () => { this.Changes.clear(); this.Render(); });
      $('MaterialExport').addEventListener('click', () => this.Export());
      $('MaterialImport').addEventListener('click', () => $('MaterialFile').click());
      $('MaterialFile').addEventListener('change', () => this.Import($('MaterialFile').files[0]));
      await this.LoadPackage();
    },

    async LoadPackage() {
      $('MaterialCount').textContent = Text('AssetLoading');
      const List = await Ui().FetchJson('/api/Materials/' + $('MaterialPackage').value);
      this.List = List.Error ? [] : List;
      this.RenderList();
      if (this.List.length && !this.Selected) this.Select(this.List[0]);
    },

    RenderList() {
      const Query = $('MaterialFilter').value.trim().toLowerCase();
      const Rows = $('MaterialList');
      Rows.innerHTML = '';
      const Shown = this.List.filter(Item => !Query || `${Item.Ref} ${Item.Class} ${Item.Texture || ''} ${Item.Blend || ''}`.toLowerCase().includes(Query));
      $('MaterialCount').textContent = Text('AssetCount', { Shown: NumberText(Shown.length), Total: NumberText(this.List.length) });
      for (const Item of Shown.slice(0, 3000)) {
        const Row = Make('div', 'AssetRow');
        Row.setAttribute('role', 'option');
        Row.tabIndex = 0;
        Row.dataset.ref = Item.Ref;
        Row.setAttribute('aria-selected', String(Boolean(this.Selected && this.Selected.Ref === Item.Ref)));
        Row.append(Make('span', 'Ref', Item.Ref), Make('span', 'Name', Item.Class), Make('span', 'Meta', Item.Blend || ''),
          Make('span', 'Sub', Item.Texture ? Text('MaterialTextureOf', { Ref: Item.Texture }) : '—'));
        Row.addEventListener('click', () => this.Select(Item));
        Rows.appendChild(Row);
      }
    },

    async OpenRef(Ref) {
      const [Package] = SplitRef(Ref);
      if ($('MaterialPackage').value !== String(Package) && [...$('MaterialPackage').options].some(Option => Option.value === String(Package))) {
        $('MaterialPackage').value = String(Package);
        await this.LoadPackage();
      }
      const Item = this.List.find(Entry => Entry.Ref === Ref) || { Ref };
      await this.Select(Item);
    },

    async Select(Item) {
      if (this.Changes.size && !window.confirm(Text('MaterialDiscard'))) return;
      this.Selected = Item;
      for (const Row of document.querySelectorAll('#MaterialList .AssetRow')) Row.setAttribute('aria-selected', String(Row.dataset.ref === Item.Ref));
      const [Package, Index] = SplitRef(Item.Ref);
      const Request = ++this.Request;
      const Info = await Ui().FetchJson(`/api/Material/${Package}/${Index}`);
      if (Request !== this.Request || Info.Error) return;
      this.Info = Info;
      this.Changes.clear();
      $('MaterialEmpty').hidden = true;
      await this.Render();
    },

    Raw(Slot) { return this.Changes.has(Slot) ? this.Changes.get(Slot) : this.Original(Slot); },
    Original(Slot) {
      const Row = this.Info.Slots.find(Item => Item.Slot === Slot);
      if (Row) return Row.Raw;
      for (const Items of Object.values(this.Info.Arrays)) { const Item = Items.find(Entry => Entry.Slot === Slot); if (Item) return Item.Raw; }
      return 0;
    },
    Set(Slot, Raw) {
      Raw >>>= 0;
      if (Raw === (this.Original(Slot) >>> 0)) this.Changes.delete(Slot); else this.Changes.set(Slot, Raw);
      this.SyncButtons();
      this.UpdatePreview();
    },

    SyncButtons() {
      $('MaterialSave').disabled = !this.Changes.size;
      $('MaterialRevert').disabled = !this.Changes.size;
      $('MaterialExport').disabled = !this.Info;
      $('MaterialImport').disabled = !this.Info;
      $('MaterialChanged').textContent = this.Changes.size ? Text('MaterialChanged', { Count: this.Changes.size }) : '';
    },

    async Texture(Code) {
      if (!Code) return null;
      if (this.Decoded.has(Code)) return this.Decoded.get(Code);
      try {
        const [Package, Index] = SplitRef(Code);
        const Bundle = await Ui().FetchBuffer(`/api/Texture/${Package}/${Index}`);
        const Decoded = RiotTextureDecoder.DecodeBundle(Bundle);
        const Info = Decoded.get(Code) || [...Decoded.values()][0] || null;
        this.Decoded.set(Code, Info);
        return Info;
      } catch (Error) { this.Decoded.set(Code, null); return null; }
    },

    Thumb(Info) {
      const Canvas = document.createElement('canvas');
      Canvas.width = Canvas.height = 96;
      if (!Info) return Canvas;
      const Source = document.createElement('canvas');
      Source.width = Info.Width; Source.height = Info.Height;
      const Image = new ImageData(new Uint8ClampedArray(Info.Pixels), Info.Width, Info.Height);
      Source.getContext('2d').putImageData(Image, 0, 0);
      const Paint = Canvas.getContext('2d');
      Paint.translate(0, 96); Paint.scale(1, -1);     // PT: linhas vêm de baixo para cima / EN: rows are bottom-up
      Paint.drawImage(Source, 0, 0, 96, 96);
      return Canvas;
    },

    MapOf(Info) {
      const Map = new THREE.DataTexture(Info.Pixels, Info.Width, Info.Height, THREE.RGBAFormat);
      Map.encoding = THREE.sRGBEncoding;
      Map.wrapS = Map.wrapT = THREE.RepeatWrapping;
      Map.magFilter = THREE.LinearFilter;
      Map.minFilter = THREE.LinearMipmapLinearFilter;
      Map.generateMipmaps = true;
      Map.needsUpdate = true;
      return Map;
    },

    /** PT: Textura que um ref dá (direto ou via material). EN: Texture a reference resolves to. */
    TextureOfTarget(Target) { return Target ? Target.Texture : null; },

    // ------------------------------------------------------------------ grafo / graph
    async Render() {
      const Info = this.Info;
      const Nodes = [], Edges = [];
      const Inputs = [];
      let Y = 0;
      const Source = async (Key, Title, Target, Slot, Kind) => {
        const Texture = this.TextureOfTarget(Target);
        const Rows = [];
        if (Slot !== null) {
          const Field = document.createElement('input');
          Field.value = RefText(this.Raw(Slot));
          Field.placeholder = 'pkg_idx';
          Field.title = Text('MaterialRefTip');
          Field.addEventListener('change', () => {
            const Raw = ParseRef(Field.value);
            if (Raw === null) { Field.value = RefText(this.Raw(Slot)); return; }
            this.Set(Slot, Raw);
            this.Render();
          });
          Rows.push(Field);
        }
        const Node = {
          Id: Key, Title, Subtitle: Target ? `${Target.Ref}${Target.Class ? ' · ' + Target.Class : ''}` : '—', X: 0, Y, Width: 190,
          Outputs: [{ Key: 'out', Label: Kind === 'wave' ? Text('MaterialCurve') : Text('MaterialColour') }], Rows,
          Ref: Target ? Target.Ref : null, Kind: Target ? Target.Kind : null, Color: Kind === 'wave' ? '#2f4660' : Target && Target.Kind === 'material' ? '#4a3456' : '#2f5040',
        };
        if (Kind === 'wave') Node.Thumbnail = this.WaveCanvas();
        else if (Texture) Node.Thumbnail = this.Thumb(await this.Texture(Texture));
        Nodes.push(Node);
        Y += 200 + Rows.length * 26;
        return Node;
      };
      // PT: entradas: slots de referência e itens das arrays / EN: inputs: reference slots and array items
      for (const Row of Info.Slots) {
        if (!['tex', 'mat', 'wave', 'ref'].includes(Row.Kind) || (Row.Kind === 'ref' && !this.Raw(Row.Slot))) continue;
        const Target = this.Changes.has(Row.Slot) ? null : Row.Target;
        const Node = await Source('s' + Row.Slot, Label(Row), Target, Row.Slot, Row.Kind);
        Inputs.push({ Key: 's' + Row.Slot, Label: Label(Row) });
        Edges.push({ From: [Node.Id, 'out'], To: ['material', 's' + Row.Slot] });
      }
      for (const [Slot, Items] of Object.entries(Info.Arrays)) {
        const Row = Info.Slots.find(Item => Item.Slot === Number(Slot));
        for (const [Position, Item] of Items.slice(0, 16).entries()) {
          const Key = 'a' + Item.Slot;
          const Node = await Source(Key, `${Label(Row)} [${Position}]`, this.Changes.has(Item.Slot) ? null : Item.Target, Item.Slot, 'item');
          Inputs.push({ Key, Label: `${Label(Row)} [${Position}]` });
          Edges.push({ From: [Node.Id, 'out'], To: ['material', Key] });
        }
      }
      // PT: nó do material com os parâmetros / EN: material node with the parameters
      const Rows = Info.Slots.filter(Row => !['tex', 'mat', 'wave', 'array', 'ref'].includes(Row.Kind)).map(Row => this.ParamRow(Row));
      Nodes.push({ Id: 'material', Title: Info.Class, Subtitle: Info.Ref, X: 300, Y: 0, Width: 300, Inputs, Outputs: [{ Key: 'out', Label: Text('MaterialSurface') }], Rows, Color: '#5a4a20' });
      Nodes.push({ Id: 'output', Title: Text('MaterialOutput'), Subtitle: '', X: 680, Y: 0, Width: 200, Inputs: [{ Key: 'in', Label: Text('MaterialSurface') }], Rows: this.SummaryRows(), Color: '#33363c' });
      Edges.push({ From: ['material', 'out'], To: ['output', 'in'] });
      this.Graph.SetData(Nodes, Edges);
      this.SyncButtons();
      await this.UpdatePreview();
    },

    ParamRow(Row) {
      const Line = Make('label', 'MaterialParam' + (this.Changes.has(Row.Slot) ? ' Edited' : ''));
      Line.appendChild(Make('span', 'MaterialParamName' + (Row.Kind === 'raw' ? ' Unknown' : ''), `p${Row.Slot} · ${Label(Row)}`));
      const Raw = this.Raw(Row.Slot);
      let Field;
      const Commit = Value => { this.Set(Row.Slot, Value); Line.classList.toggle('Edited', this.Changes.has(Row.Slot)); this.RefreshSummary(); };
      if (Row.Kind === 'blend') {
        Field = document.createElement('select');
        for (const [Value, Name] of Object.entries(this.Info.BlendTable)) Field.add(new Option(`${Value} · ${Name}`, Value));
        if (!(String(Raw) in this.Info.BlendTable)) Field.add(new Option(`${Raw} · ?`, Raw));
        Field.value = String(Raw);
        Field.addEventListener('change', () => Commit(Number(Field.value)));
      } else if (Row.Kind === 'uvgen') {
        Field = document.createElement('select');
        [[0, Text('MaterialUvModel')], [1, Text('MaterialUvEnv') + ' 1'], [2, Text('MaterialUvEnv') + ' 2'], [3, Text('MaterialUvEnv') + ' 3']].forEach(([Value, Name]) => Field.add(new Option(`${Value} · ${Name}`, Value)));
        if (Raw > 3) Field.add(new Option(`${Raw} · ?`, Raw));
        Field.value = String(Raw);
        Field.addEventListener('change', () => Commit(Number(Field.value)));
      } else if (Row.Kind === 'enum') {
        Field = document.createElement('select');
        for (const Choice of Row.Options || []) Field.add(new Option(`${Choice.Value} · ${Label(Choice)}`, Choice.Value));
        if (!(Row.Options || []).some(Choice => Choice.Value === Raw)) Field.add(new Option(`${Raw} · ?`, Raw));
        Field.value = String(Raw);
        Field.addEventListener('change', () => Commit(Number(Field.value)));
      } else if (Row.Kind === 'int') {
        Field = document.createElement('input');
        Field.type = 'number';
        Field.step = '1';
        Field.value = String(Raw | 0);
        Field.addEventListener('change', () => { const Value = Number(Field.value); if (Number.isInteger(Value)) Commit(Value >>> 0); else Field.value = String(this.Raw(Row.Slot) | 0); });
      } else if (Row.Kind === 'bool') {
        Field = document.createElement('input');
        Field.type = 'checkbox';
        Field.checked = Raw !== 0;
        Field.addEventListener('change', () => Commit(Field.checked ? 1 : 0));
      } else if (Row.Kind === 'color') {
        Field = document.createElement('input');
        Field.type = 'color';
        Field.value = '#' + (Raw & 0xFFFFFF).toString(16).padStart(6, '0');
        Field.addEventListener('input', () => Commit(((Raw & 0xFF000000) | parseInt(Field.value.slice(1), 16)) >>> 0));
      } else if (Row.Kind === 'float') {
        Field = document.createElement('input');
        Field.type = 'number';
        Field.step = 'any';
        Field.value = String(Math.round(BitsFloat(Raw) * 1e5) / 1e5);
        Field.addEventListener('change', () => { const Value = Number(Field.value); if (Number.isFinite(Value)) Commit(FloatBits(Value)); });
      } else {
        // PT: slot de sentido desconhecido: hex bruto (mostra também como float) / EN: unknown slot: raw hex (float hint)
        Field = document.createElement('input');
        Field.value = '0x' + (Raw >>> 0).toString(16).toUpperCase();
        const AsFloat = BitsFloat(Raw);
        Field.title = Text('MaterialRawTip', { Float: Number.isFinite(AsFloat) && Math.abs(AsFloat) < 1e7 ? Math.round(AsFloat * 1e5) / 1e5 : '—', Int: Raw >>> 0 });
        Field.addEventListener('change', () => { const Value = Number(Field.value); if (Number.isFinite(Value) && Value >= 0 && Value <= 0xFFFFFFFF) Commit(Value); else Field.value = '0x' + (this.Raw(Row.Slot) >>> 0).toString(16).toUpperCase(); });
      }
      Line.appendChild(Field);
      return Line;
    },

    /** PT: Valores efetivos do passe (como o visor da fase usa). EN: Effective pass values (as the level viewport uses). */
    Effective() {
      const Info = this.Info, Class = Info.Class, Raw = Slot => this.Raw(Slot);
      const Result = { Blend: Info.Blend, Tint: Info.Tint, Scale: 1, Offset: [0, 0], Fps: 0 };
      if (Class === 'Advanced Material' || Class === 'Simple Material') Result.Blend = Info.BlendTable[Raw(2)] || Info.Blend;
      if (Class === 'Animating Material') { Result.Blend = Info.BlendTable[Raw(4)] || Info.Blend; Result.Fps = BitsFloat(Raw(2)) || 15; }
      if (Class === 'Advanced Material') {
        Result.Tint = Raw(3) ? '#' + (Raw(4) & 0xFFFFFF).toString(16).padStart(6, '0') : null;
        if (!Raw(11)) { const Scale = BitsFloat(Raw(6)); Result.Scale = Number.isFinite(Scale) && Scale ? Scale : 1; Result.Offset = [BitsFloat(Raw(7)) || 0, BitsFloat(Raw(8)) || 0]; }
      }
      if (Class === 'Animating Material') Result.Tint = Raw(5) ? '#' + (Raw(6) & 0xFFFFFF).toString(16).padStart(6, '0') : null;
      return Result;
    },

    SummaryRows() {
      const Effective = this.Effective();
      return [
        Make('div', 'MaterialSummary', `${Text('MaterialBlend')}: ${Effective.Blend || '—'}`),
        Make('div', 'MaterialSummary', `${Text('MaterialLighting')}: ${Effective.Tint ? Text('MaterialUnlit', { Tint: Effective.Tint }) : Text('MaterialLit')}`),
        Make('div', 'MaterialSummary', `${Text('MaterialAlpha')}: ${this.Info.AlphaIsMask ? Text('MaterialAlphaMask') : Text('MaterialAlphaTransparency')}`),
      ];
    },

    RefreshSummary() {
      const Node = document.querySelector('#MaterialGraph .Node[data-id="output"] .NodeBody');
      if (!Node) return;
      for (const Row of Node.querySelectorAll('.MaterialSummary')) Row.remove();
      for (const Row of this.SummaryRows()) { Row.classList.add('NodeRow'); Node.appendChild(Row); }
    },

    WaveCanvas() {
      const Canvas = document.createElement('canvas');
      Canvas.width = 180; Canvas.height = 70;
      const Wave = this.Info.Wave;
      if (!Wave) return Canvas;
      const Paint = Canvas.getContext('2d'), Count = Wave.Samples.length / Wave.Channels;
      let Min = Infinity, Max = -Infinity;
      for (const Value of Wave.Samples) { Min = Math.min(Min, Value); Max = Math.max(Max, Value); }
      const Span = Max - Min || 1;
      ['#e0a33c', '#7fb2e5', '#8fd18a', '#d98bb8'].slice(0, Wave.Channels).forEach((Color, Channel) => {
        Paint.strokeStyle = Color; Paint.beginPath();
        for (let Index = 0; Index < Count; Index++) {
          const X = Index / Math.max(1, Count - 1) * 176 + 2, Y = 66 - (Wave.Samples[Index * Wave.Channels + Channel] - Min) / Span * 62;
          if (Index) Paint.lineTo(X, Y); else Paint.moveTo(X, Y);
        }
        Paint.stroke();
      });
      return Canvas;
    },

    async UpdatePreview() {
      if (!this.Info) return;
      const Info = this.Info, Effective = this.Effective();
      let Codes = [];
      if (Info.Animation && Info.Animation.fr && !this.Changes.size) Codes = Info.Animation.fr;
      else if (Info.Class === 'Animating Material') Codes = (Info.Arrays['1'] || []).map(Item => this.Changes.has(Item.Slot) ? RefText(this.Raw(Item.Slot)) : this.TextureOfTarget(Item.Target)).filter(Boolean);
      else {
        const Row = Info.Slots.find(Item => Item.Kind === 'tex');
        Codes = [Row && this.Changes.has(Row.Slot) ? RefText(this.Raw(Row.Slot)) : Info.Texture].filter(Boolean);
      }
      const Maps = [];
      for (const Code of Codes) { const Decoded = await this.Texture(Code); if (Decoded) Maps.push(this.MapOf(Decoded)); }
      const Wave = Info.Wave && Info.Class === 'Advanced Material' && !this.Raw(11) && this.Raw(10) ? Info.Wave : null;
      this.Preview.Set(Object.assign(Effective, { Maps, Wave, AlphaIsMask: Info.AlphaIsMask }));
    },

    // ------------------------------------------------------------------ gravar / save
    async Save() {
      if (!this.Info || !this.Changes.size) return;
      const [Package, Index] = SplitRef(this.Info.Ref);
      let Result;
      try {
        const Response = await fetch(`/api/SaveTemplate/${Package}/${Index}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Properties: Object.fromEntries(this.Changes) }) });
        Result = await Response.json();
      } catch (Error) { Result = { Error: String(Error) }; }
      if (Result.Error) { Ui().SetStatus(Text('SaveFailed', { Error: Result.Error })); return; }
      Ui().SetStatus(Text('MaterialSaved', { Ref: this.Info.Ref, Count: Result.Saved, Backup: Result.Backup }));
      this.Changes.clear();
      const Item = this.Selected;
      this.Selected = null;
      await this.Select(Item);
      await this.LoadPackage();
    },

    Export() {
      if (!this.Info) return;
      const Data = { Ref: this.Info.Ref, Class: this.Info.Class, Slots: this.Info.Slots.map(Row => ({ Slot: Row.Slot, Name: Row.En, Raw: this.Raw(Row.Slot) })),
        Arrays: Object.fromEntries(Object.entries(this.Info.Arrays).map(([Slot, Items]) => [Slot, Items.map(Item => ({ Slot: Item.Slot, Raw: this.Raw(Item.Slot), Ref: RefText(this.Raw(Item.Slot)) }))])) };
      const Blob_ = new Blob([JSON.stringify(Data, null, 1)], { type: 'application/json' });
      const Link = document.createElement('a');
      Link.href = URL.createObjectURL(Blob_);
      Link.download = `material_${this.Info.Ref}.json`;
      document.body.appendChild(Link);
      Link.click();
      setTimeout(() => { URL.revokeObjectURL(Link.href); Link.remove(); }, 1000);
    },

    /** PT: Importa um JSON exportado (mesma classe): vira edição pendente. EN: Imports an exported JSON as pending edits. */
    async Import(File) {
      if (!File || !this.Info) return;
      $('MaterialFile').value = '';
      let Data;
      try { Data = JSON.parse(await File.text()); } catch (Error) { Ui().SetStatus(Text('MaterialImportBad')); return; }
      if (Data.Class !== this.Info.Class) { Ui().SetStatus(Text('MaterialImportClass', { Class: Data.Class || '?' })); return; }
      const Items = [...(Data.Slots || []), ...Object.values(Data.Arrays || {}).flat()];
      const Known = new Set([...this.Info.Slots.map(Row => Row.Slot), ...Object.values(this.Info.Arrays).flat().map(Item => Item.Slot)]);
      for (const Item of Items) if (Known.has(Item.Slot) && Number.isFinite(Item.Raw) && Item.Raw >= 0) this.Set(Item.Slot, Item.Raw);
      await this.Render();
      Ui().SetStatus(Text('MaterialImported', { Count: this.Changes.size }));
    },

    Relabel() { if (this.List.length) this.RenderList(); if (this.Info) this.Render(); },
    Show(Active) { if (Active) this.Open(); if (this.Preview) this.Preview.Active = Active; },
  };

  RiotAssetTabs.Register('Material', MaterialTab);
})();
