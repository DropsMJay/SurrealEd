/*
 * RiotEditor — interface do SurrealEd / SurrealEd UI shell
 *
 * PT: Menus, abas, painel lateral e barra de status. Conversa com o servidor local (Riot/RiotServer.py).
 *     Só a aba Fase está ativa nesta versão; as outras mostram um aviso.
 * EN: Menus, tabs, side panel and status bar. Talks to the local server (Riot/RiotServer.py).
 *     Only the Level tab is active in this version.
 */
const RiotEditor = (() => {
  const $ = Id => document.getElementById(Id);
  let Game = null, Viewport = null, LevelView = null, Gizmo = null, CurrentTab = 'Level', LastTimes = { ServerTime: 0, ClientTime: 0 };

  const Ui = {
    SetStatus(Message) { $('StatusText').classList.remove('Dirty'); $('StatusText').textContent = Message; },
    SelectTab(Name) { SelectTab(Name); },
    async FetchJson(Url) {
      const Response = await fetch(Url, { cache: 'no-store' });
      return Response.json();
    },
    async FetchBuffer(Url) {
      const Response = await fetch(Url, { cache: 'no-store' });
      if (!Response.ok) throw new Error(Response.status + ' ' + Url);
      return Response.arrayBuffer();
    },
    NextFrame() { return new Promise(Resolve => requestAnimationFrame(() => setTimeout(Resolve, 0))); },
    /** PT: Abre a fase da sequência e toca nela. EN: Opens the sequence's level and plays it there. */
    async PlayStomp(Sequence) {
      if (!Sequence.LevelKey) { Ui.SetStatus(Text('StompNoLevel')); return; }
      await Ui.OpenLevel(Sequence.LevelKey);
      const Player = LevelView.Stomp;
      if (!Player.Start(Sequence)) return;
      $('StompBarTime').max = String(Math.max(Sequence.Duration, 0.001));
      $('StompBarTitle').textContent = Sequence.Ref;
      $('StompBarTitle').title = Sequence.Tracks.map(Track => Track.Name).filter(Boolean).join(', ');
      Player.SceneCamera = $('StompBarCamera').checked;
      Player.Sound = $('StompBarSound').checked;
      const Missing = Player.Tracks.filter(Item => Item.Number < 0 && !Item.IsCamera).length;
      $('StompBarNote').textContent = [Player.CameraTrack ? '' : Text('StompNoCamera'), Missing ? Text('StompMissing', { Count: Missing }) : ''].filter(Boolean).join(' · ');
      $('StompBar').hidden = false;
      SyncStompBar();
      // PT: espera os personagens (modelos com esqueleto e clipes) antes de tocar / EN: wait for the characters first
      const Note = $('StompBarNote').textContent;
      $('StompBarNote').textContent = Text('StompLoadingRigs');
      $('StompBarPlay').disabled = true;
      try { await Player.Loading; } catch (Error) { /* PT: segue sem eles / EN: carry on without them */ }
      $('StompBarPlay').disabled = false;
      $('StompBarNote').textContent = Note;
      if (Player.Sequence === Sequence) Player.SetPlaying(true);
    },
    async OpenLevel(Key, Id, Position) {
      SelectTab('Level');
      const Select = $('LevelSelect');
      if (Select.value !== Key || !LevelView.Scene) { Select.value = Key; await LevelView.Load(Key); }
      if (Id) GoToInstance(Id, Position || [0, 0, 0]);
    },
    LevelByKey(Key) { return Game && Game.Levels.find(Level => Level.Key === Key); },
    ShowLoading(Message, IsError) {
      $('LoadingText').textContent = Message;
      $('LoadingText').className = IsError ? 'Error' : '';
      $('Loading').hidden = false;
    },
    HideLoading() { $('Loading').hidden = true; },
    ShowSelection(Description, Missed) {
      const Info = $('SelectionInfo'), Overlay = $('SelectionOverlay');
      if (!Description) {
        Info.className = 'SelectionInfo Empty';
        Info.textContent = Text(Missed ? 'SelectionNothing' : 'SelectionEmpty');
        Overlay.hidden = true;
        return;
      }
      Info.className = 'SelectionInfo';
      Info.textContent = Description;
      Overlay.textContent = Description;
      Overlay.hidden = false;
    },
    LevelLoaded(Scene, Times) {
      if (Times && Gizmo) { Gizmo.Reset(); ClearStructure(); $('StatusText').classList.remove('Dirty'); }
      LastTimes = Times || LastTimes;
      Times = LastTimes;
      $('InfoFile').textContent = Scene.File + '.lvl';
      $('InfoName').textContent = Scene.Name;
      document.title = Scene.Name + ' · SurrealEd';
      if (Times) { $('ShadowFadeStart').value = LevelView.Shadows.FadeStart; $('ShadowFadeEnd').value = LevelView.Shadows.FadeEnd; SyncShadows(); }
      const Stats = Scene.Stats;
      const Rows = [[Text('StatPlaced'), Stats.Placed], [Text('StatModels'), Stats.Models], [Text('StatRecords'), Stats.Records],
        [Text('StatTerrain'), Stats.TerrainTriangles], [Text('StatLights'), Stats.Lights], [Text('StatTextures'), Scene.Textures.length]];
      $('InfoStats').innerHTML = '';
      for (const [Label, Value] of Rows) {
        const Term = document.createElement('dt'), Data = document.createElement('dd');
        Term.textContent = Label; Data.textContent = NumberText(Value);
        $('InfoStats').append(Term, Data);
      }
      FillClasses();
      if (Times) LoadEnvironment(Scene.Key); else if (Ui.LastEnvironment) RenderEnvironment(Ui.LastEnvironment);
      Ui.ShowSelection(null);
      Ui.LevelStatus = Text('StatusLevel', { File: Scene.File, Ms: NumberText(Math.round(Times.ServerTime)), Client: NumberText(Math.round(Times.ClientTime)) });
      $('StatusText').textContent = Ui.LevelStatus;
      try { history.replaceState(null, '', '#' + Scene.Key); } catch (Error) { /* ignora */ }
      window.SurrealEdReady = true;
    },
    FillCells(Cells) {
      const Select = $('CellSelect');
      Select.innerHTML = '';
      const Entries = Object.entries(Cells.Nodes).filter(([Number, Node]) => Node.k === 1 || Cells.ByNode[Number] !== undefined)
        .sort((A, B) => A[1].n.localeCompare(B[1].n));
      for (const [Number, Node] of Entries) {
        const Option = document.createElement('option');
        Option.value = Number;
        const Cell = Cells.ByNode[Number];
        Option.textContent = Node.n + (Cell !== undefined ? ' · ' + Text('CellPortals', { Cell, Count: Cells.Cells[Cell].pt.length }) : '');
        Select.appendChild(Option);
      }
      const Has = Entries.length > 0;
      Select.disabled = !Has;
      $('CellGo').disabled = !Has;
      $('CellNote').textContent = Has ? Text('CellSummary', { Rooms: Object.values(Cells.Nodes).filter(Node => Node.k === 1).length, Cells: Cells.Cells.length }) : Text('CellNone');
    },
    /**
     * PT: Painel de propriedades da instância selecionada (flags, transformação e propriedades da classe), por enquanto só leitura.
     * EN: Properties panel of the selected instance (flags, transform and class properties), read-only for now.
     */
    async ShowProperties(LevelKey, InstanceId) {
      const Panel = $('PropertiesPanel');
      const Request = (Ui.PropertyRequest = (Ui.PropertyRequest || 0) + 1);
      const Note = Key => { Panel.innerHTML = ''; const P = document.createElement('p'); P.className = 'Note'; P.textContent = Text(Key); Panel.appendChild(P); };
      if (!LevelKey) { Ui.LastProperties = null; Note('PropEmpty'); return; }
      if (LevelKey === 'terrain') { Ui.LastProperties = null; Note('PropTerrain'); return; }
      Note('PropLoading');
      let Details;
      // PT: cópia ainda não gravada: mostra as propriedades do original, editando a cópia / EN: unsaved copy: source's data
      const Copy = InstanceId < 0 ? [...Structure.Added.values()].find(Item => Item.Temp === InstanceId) : null;
      try { Details = await Ui.FetchJson('/api/Instance/' + encodeURIComponent(LevelKey) + '/' + (Copy ? Copy.Source : InstanceId)); } catch (Error) { Details = null; }
      if (Request !== Ui.PropertyRequest) return;
      if (!Details || Details.Error) { Note('PropEmpty'); return; }
      if (Copy) { Details.Id = InstanceId; Details.CopyOf = Copy.Source; Details.LinkIn = []; }
      Ui.LastProperties = Details;
      RenderProperties(Details);
    },
    SelectionChanged(Number) { if (Gizmo) Gizmo.Attach(Number); },
    TransformChanged(Number, Instance, _GizmoCount) {
      if (Instance) UpdateTransformFields(Number, Instance);
      if (Instance && Instance[4] === 'Point Light' && LevelView.LightOf(Instance[6])) {
        const Light = LevelView.LightOf(Instance[6]);
        if (Light[0] !== Instance[1][0] || Light[1] !== Instance[1][1] || Light[2] !== Instance[1][2]) QueueLight(Instance[6], { Position: Instance[1].slice() });
      }
      const Count = DirtyCount();
      const Status = $('StatusText');
      Status.classList.toggle('Dirty', Count > 0);
      Status.textContent = Count > 0 ? Text('StatusModified', { Count }) : (Ui.LevelStatus || '');
      if (LevelView.Selected && LevelView.SelectedNumber() === Number) LevelView.Select(LevelView.Selected, false, true);
    },
    GizmoChanged() { SyncGizmoToolbar(); },
    StructureStep(Step, Undo) { ApplyStructureStep(Step, Undo); },
    ChosenCellNode() { const Value = $('CellSelect').value; return Value === '' ? null : Value; },
  };


  // ------------------------------------------------------------------ abas do painel / panel tabs
  function ShowPane(Name, Remember = true) {
    const World = Name === 'World';
    $('TabDetails').setAttribute('aria-selected', String(!World));
    $('TabWorld').setAttribute('aria-selected', String(World));
    $('DetailsPane').hidden = World;
    $('WorldPane').hidden = !World;
    if (Remember) { try { localStorage.setItem('SurrealEdPane', Name); } catch (Error) { /* ignora */ } }
  }
  function SetupPanes() {
    $('TabDetails').addEventListener('click', () => ShowPane('Details'));
    $('TabWorld').addEventListener('click', () => ShowPane('World'));
    let Saved = 'Details';
    try { Saved = localStorage.getItem('SurrealEdPane') || 'Details'; } catch (Error) { /* ignora */ }
    ShowPane(Saved, false);
  }

  // ------------------------------------------------------------------ ambiente da fase / level environment
  /**
   * PT: Lê /api/LevelEnvironment e mostra Level Properties → Sky Properties (neblina), switchers e névoa volumétrica.
   * EN: Reads /api/LevelEnvironment and shows Level Properties → Sky Properties (fog), switchers and volumetric fog.
   */
  async function LoadEnvironment(Key) {
    const Panel = $('EnvironmentPanel');
    Panel.innerHTML = '';
    Panel.appendChild(MakeElement('p', 'Note', Text('EnvLoading')));
    const Request = (Ui.EnvironmentRequest = (Ui.EnvironmentRequest || 0) + 1);
    let Environment = null;
    try { Environment = await Ui.FetchJson('/api/LevelEnvironment/' + encodeURIComponent(Key)); } catch (Error) { Environment = null; }
    if (Request !== Ui.EnvironmentRequest) return;
    Ui.LastEnvironment = Environment && !Environment.Error ? Environment : null;
    RenderEnvironment(Ui.LastEnvironment);
    ApplyFog();
  }

  function GoToInstance(Id, Position) {
    const Scene = LevelView.Scene;
    const Number = Scene ? Scene.Instances.findIndex(Instance => Instance[6] === Id) : -1;
    const Slots = Number >= 0 ? LevelView.InstanceSlots.get(Number) : null;
    if (Slots && Slots.length) {
      LevelView.Select({ Mesh: Slots[0][0], Slot: Slots[0][1], Point: null });
      LevelView.FocusSelection();
      return;
    }
    const Target = new THREE.Vector3(Position[0], Position[1], Position[2]);
    Viewport.SetView(new THREE.Vector3(Target.x + 3, Target.y + 2.5, Target.z + 4), Target);
  }

  // ------------------------------------------------------------------ campos numéricos / numeric fields
  /**
   * PT: Barra deslizante + campo numérico. A faixa sai do valor (0..1 para frações, potência de 10 acima do dobro do
   *     valor nos outros casos) e cresce se o campo receber algo maior. OnInput corre durante o arrasto, OnChange no fim.
   * EN: Slider + number box; the range comes from the value and grows when the box gets something larger.
   */
  function NumberSlider(Value, Float, OnInput, OnChange) {
    const Box = MakeElement('span', 'PropSlider');
    const Range = document.createElement('input'), Number_ = document.createElement('input');
    Range.type = 'range'; Number_.type = 'number'; Number_.className = 'PropInput';
    const Fit = Wanted => {
      const Magnitude = Math.abs(Wanted);
      let Max;
      if (Float && Magnitude <= 1 && Wanted >= 0) Max = 1;
      else Max = Math.pow(10, Math.ceil(Math.log10(Math.max(Float ? 1 : 10, Magnitude * 2))));
      Range.min = String(Wanted < 0 ? -Max : 0); Range.max = String(Max);
      Range.step = Float ? String(Max / 500) : String(Math.max(1, Math.round(Max / 500)));
    };
    const Show = Wanted => { Number_.value = Float ? String(+Number(Wanted).toPrecision(6)) : String(Math.round(Wanted)); };
    Fit(Value);
    Range.value = String(Value); Number_.step = Float ? 'any' : '1'; Show(Value);
    Range.addEventListener('input', () => { const Wanted = Float ? +Range.value : Math.round(+Range.value); Show(Wanted); OnInput(Wanted); });
    Range.addEventListener('change', () => OnChange(Float ? +Range.value : Math.round(+Range.value)));
    Number_.addEventListener('change', () => {
      const Wanted = Float ? (+Number_.value || 0) : Math.round(+Number_.value || 0);
      if (Wanted > +Range.max || Wanted < +Range.min) Fit(Wanted);
      Range.value = String(Wanted);
      OnChange(Wanted);
    });
    Box.append(Range, Number_);
    return Box;
  }

  function CheckBox(Checked, OnChange) {
    const Input = document.createElement('input');
    Input.type = 'checkbox'; Input.className = 'PropCheck'; Input.checked = Checked;
    Input.addEventListener('change', () => OnChange(Input.checked));
    return Input;
  }

  // ------------------------------------------------------------------ neblina / fog
  // PT: Sky Properties: p2 = fim da neblina (m), p3 = início como fração do fim, p4 = cor (neblina linear na profundidade)
  // EN: Sky Properties: p2 fog end (m), p3 start as a fraction of the end, p4 colour (linear fog in view depth)
  const FogKeys = ['EnvFogEnd', 'EnvFogStart', 'EnvFogColour'];
  const SkyEdits = new Map();       // PT: ref do céu -> {Properties} / EN: sky ref -> edits

  function FogOf(Sky) {
    const Edit = SkyEdits.get(Sky.Ref);
    const Raw = Key => { const Field = Sky.Fields.find(Item => Item.Key === Key); if (!Field) return null; return Edit && Edit.Properties[Field.Index] !== undefined ? Edit.Properties[Field.Index] : Field.Raw; };
    const End = BitsFloat(Raw('EnvFogEnd') || 0), Start = BitsFloat(Raw('EnvFogStart') || 0), Color = Raw('EnvFogColour') || 0;
    return { End, Start: Start * End, Color: [(Color >> 16 & 255) / 255, (Color >> 8 & 255) / 255, (Color & 255) / 255] };
  }

  /** PT: Céu ativo da fase (o do Level Properties). EN: The level's active sky. */
  function MainSky() {
    const Environment = Ui.LastEnvironment;
    if (!Environment || !Environment.LevelProperties.length) return null;
    const Link = Environment.LevelProperties[0].Sky[0];
    return Link ? Environment.Skies[Link.Ref] : null;
  }

  function ApplyFog() {
    const Sky = MainSky();
    LevelView.SetFog($('RenderFog').checked && Sky ? FogOf(Sky) : null);
    if (Sky) {
      // PT: a cúpula do céu usa p4..p7 da mesma Sky Properties (com as edições ainda não gravadas)
      // EN: the sky dome uses p4..p7 of the same Sky Properties (unsaved edits included)
      const Edit = SkyEdits.get(Sky.Ref), Raw = [];
      for (const Field of Sky.Fields) Raw[Field.Index] = Edit && Edit.Properties[Field.Index] !== undefined ? Edit.Properties[Field.Index] : Field.Raw;
      LevelView.SetDome(Raw);
    }
  }

  function SetSkyField(Sky, Field, Raw, Final) {
    let Edit = SkyEdits.get(Sky.Ref);
    if (!Edit) { Edit = { Properties: {} }; SkyEdits.set(Sky.Ref, Edit); }
    if ((Raw >>> 0) === (Field.Raw >>> 0)) delete Edit.Properties[Field.Index]; else Edit.Properties[Field.Index] = Raw >>> 0;
    if (FogKeys.includes(Field.Key) && !$('RenderFog').checked && Sky === MainSky()) $('RenderFog').checked = true;
    ApplyFog();
    if (Final) RenderEnvironment(Ui.LastEnvironment);
  }

  async function SaveSky(Sky) {
    const Edit = SkyEdits.get(Sky.Ref);
    if (!Edit) return;
    const [Package, Index] = Sky.Ref.split('_');
    if (Sky.UsedBy.length > 1 && !window.confirm(Text('FogSaveConfirm', { Count: Sky.UsedBy.length, Levels: Sky.UsedBy.join(', ') }))) return;
    const Response = await fetch(`/api/SaveTemplate/${Package}/${parseInt(Index, 16)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Properties: Edit.Properties }) });
    const Result = await Response.json();
    if (Result.Error) { Ui.SetStatus(Text('SaveFailed', { Error: Result.Error })); return; }
    SkyEdits.delete(Sky.Ref);
    Ui.SetStatus(Text('FogSaved', { Ref: Sky.Ref, Backup: Result.Backup }));
    if (LevelView.Scene) await LoadEnvironment(LevelView.Scene.Key);
    ApplyFog();
  }

  function SkyCard(Sky, Kind, Main) {
    const Card = MakeElement('div', 'EnvCard' + (Main ? ' Main' : ''));
    const Title = MakeElement('div', 'EnvCardTitle');
    Title.appendChild(MakeElement('b', null, Text(Kind)));
    const Others = Sky.UsedBy.length;
    const Tag = MakeElement('span', 'EnvTag' + (Others > 1 ? ' Shared' : ''), Others > 1 ? Text('EnvShared', { Count: Others }) : Text('EnvOnlyHere'));
    Title.appendChild(Tag);
    Card.appendChild(Title);
    Card.appendChild(MakeElement('div', 'EnvFrom', Text('EnvFrom', { Package: Sky.Package, Ref: Sky.Ref })));
    const Fields = MakeElement('div', 'EnvFields');
    const End = (Sky.Fields.find(Field => Field.Key === 'EnvFogEnd') || {}).Value;
    const Edit = SkyEdits.get(Sky.Ref);
    for (const Field of Sky.Fields) {
      const Label = MakeElement('span', 'Label' + (Field.Confirmed ? '' : ' Unknown'), Text(Field.Key));
      if (!Field.Confirmed) Label.title = Text('EnvUnconfirmed');
      const Value = MakeElement('span', 'Value');
      if (Field.Raw !== undefined && Field.Raw !== null && ['float', 'int', 'colour'].includes(Field.Kind)) {
        // PT: campos simples editáveis (neblina com prévia no visor) / EN: editable scalar fields (fog previewed live)
        const Raw = Edit && Edit.Properties[Field.Index] !== undefined ? Edit.Properties[Field.Index] : Field.Raw;
        if (Field.Kind === 'colour') {
          const Hex = Number_ => (Number_ & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
          const Swatch = MakeElement('button', 'PropSwatch', '#' + Hex(Raw));
          Swatch.type = 'button';
          Swatch.style.setProperty('--Swatch', '#' + Hex(Raw));
          Swatch.addEventListener('click', () => OpenColorPopup(Swatch, [(Raw >> 16 & 255) / 255, (Raw >> 8 & 255) / 255, (Raw & 255) / 255], (Rgb, Final) => {
            const [R, G, B] = Rgb.map(Channel => Math.round(Channel * 255));
            const New = ((Raw & 0xFF000000) | (R << 16) | (G << 8) | B) >>> 0;
            Swatch.textContent = '#' + Hex(New);
            Swatch.style.setProperty('--Swatch', '#' + Hex(New));
            SetSkyField(Sky, Field, New, Final);
          }));
          Value.appendChild(Swatch);
        } else {
          const IsFloat = Field.Kind === 'float';
          const Encode = Wanted => IsFloat ? FloatBits(Wanted) : (Wanted | 0) >>> 0;
          const Current = IsFloat ? BitsFloat(Raw) : (Raw | 0);
          Value.appendChild(NumberSlider(Current, IsFloat, Wanted => SetSkyField(Sky, Field, Encode(Wanted), false), Wanted => SetSkyField(Sky, Field, Encode(Wanted), true)));
          if (Field.Key === 'EnvFogStart') Value.appendChild(MakeElement('small', null, Text('EnvStartAt', { Value: NumberText(FogOf(Sky).End * BitsFloat(Raw), 1) })));
        }
      } else if (Field.Kind === 'colour') {
        const Swatch = MakeElement('span', 'Swatch');
        Swatch.style.background = Field.Value;
        Value.append(Swatch, MakeElement('span', null, Field.Value));
      } else if (Field.Kind === 'refs') {
        Value.textContent = Field.Value.length ? Field.Value.join(', ') : '—';
      } else {
        Value.textContent = Field.Kind === 'float' ? NumberText(Field.Value, Field.Value % 1 ? 2 : 0) : String(Field.Value);
        if (Field.Key === 'EnvFogStart' && typeof End === 'number') Value.appendChild(MakeElement('small', null, Text('EnvStartAt', { Value: NumberText(End * Field.Value, 1) })));
      }
      Fields.append(Label, Value);
    }
    Card.appendChild(Fields);
    if (Others) Card.appendChild(MakeElement('div', 'EnvUsedBy', Text('EnvUsedBy', { Levels: Sky.UsedBy.join(', ') })));
    if (Edit && Object.keys(Edit.Properties).length) {
      const Actions = MakeElement('div', 'InfoActions');
      const Save = MakeElement('button', 'Small', Text('FogSave', { Count: Sky.UsedBy.length || 1 }));
      Save.addEventListener('click', () => SaveSky(Sky));
      const Undo = MakeElement('button', 'Small', Text('FogUndo'));
      Undo.addEventListener('click', () => { SkyEdits.delete(Sky.Ref); RenderEnvironment(Ui.LastEnvironment); ApplyFog(); });
      Actions.append(Save, Undo);
      Card.appendChild(Actions);
      Card.appendChild(MakeElement('p', 'Note', Text('FogSaveNote')));
    }
    return Card;
  }

  function RenderEnvironment(Environment) {
    const Panel = $('EnvironmentPanel');
    Panel.innerHTML = '';
    if (!Environment || !Environment.LevelProperties.length) { Panel.appendChild(MakeElement('p', 'Note', Text('EnvNone'))); return; }
    const Shown = new Set();
    for (const Properties of Environment.LevelProperties) {
      const Head = MakeElement('div', 'EnvHead');
      Head.appendChild(MakeElement('b', null, Text('EnvLevelProps', { Id: Properties.Id, Template: Properties.Template, Package: Properties.TemplatePackage })));
      for (const Link of Properties.Sky) {
        Head.appendChild(MakeElement('div', null, Text('EnvSkyLink', Link) + ' · ' + Text(Link.Overridden ? 'EnvSkyLinkOverride' : 'EnvSkyLinkTemplate')));
      }
      Panel.appendChild(Head);
      for (const Link of Properties.Sky) {
        const Sky = Environment.Skies[Link.Ref];
        if (Sky && !Shown.has(Link.Ref)) { Shown.add(Link.Ref); Panel.appendChild(SkyCard(Sky, 'EnvMainSky', true)); }
      }
    }
    if (Environment.Switchers.length) {
      Panel.appendChild(MakeElement('div', 'EnvSub', Text('EnvSwitchers', { Count: Environment.Switchers.length })));
      const List = MakeElement('div', 'EnvList');
      for (const Switcher of Environment.Switchers) {
        const Row = MakeElement('div', 'EnvRow');
        const Ref = Switcher.Sky.length ? Switcher.Sky[0].Ref : '—';
        const Sky = Environment.Skies[Ref];
        const Colour = Sky ? (Sky.Fields.find(Field => Field.Key === 'EnvFogColour') || {}).Value : null;
        const Swatch = MakeElement('span', 'Swatch');
        if (Colour) Swatch.style.background = Colour; else Swatch.style.visibility = 'hidden';
        const Label = Text('EnvSwitcherRow', { Id: Switcher.Id, Ref }) + (Switcher.Time !== null ? ' · ' + Text('EnvTime', { Value: NumberText(Switcher.Time, Switcher.Time % 1 ? 1 : 0) }) : '');
        const Go = MakeElement('button', 'Small', Text('EnvGo'));
        Go.addEventListener('click', () => GoToInstance(Switcher.Id, Switcher.Position));
        Row.append(Swatch, MakeElement('span', null, Label), Go);
        List.appendChild(Row);
      }
      Panel.appendChild(List);
      for (const Switcher of Environment.Switchers) {
        for (const Link of Switcher.Sky) {
          const Sky = Environment.Skies[Link.Ref];
          if (Sky && !Shown.has(Link.Ref)) { Shown.add(Link.Ref); Panel.appendChild(SkyCard(Sky, 'EnvOtherSky', false)); }
        }
      }
    }
    if (Environment.Volumes.length) {
      Panel.appendChild(MakeElement('div', 'EnvSub', Text('EnvVolumes', { Count: Environment.Volumes.length })));
      const List = MakeElement('div', 'EnvList');
      const Limit = 6;
      Environment.Volumes.forEach((Volume, Index) => {
        const Row = MakeElement('div', 'EnvRow');
        if (Index >= Limit) Row.hidden = true;
        const Swatch = MakeElement('span', 'Swatch');
        if (Volume.Colour) { Swatch.style.background = Volume.Colour; Swatch.title = Volume.Colour; } else Swatch.style.visibility = 'hidden';
        const Go = MakeElement('button', 'Small', Text('EnvGo'));
        Go.addEventListener('click', () => GoToInstance(Volume.Id, Volume.Position));
        Row.append(Swatch, MakeElement('span', null, Text('EnvVolumeRow', Volume)), Go);
        List.appendChild(Row);
      });
      Panel.appendChild(List);
      if (Environment.Volumes.length > Limit) {
        const More = MakeElement('button', 'Small', Text('EnvShowAll', { Count: Environment.Volumes.length }));
        More.addEventListener('click', () => { List.querySelectorAll('.EnvRow').forEach(Row => { Row.hidden = false; }); More.remove(); });
        Panel.appendChild(More);
      }
    }
    Panel.appendChild(MakeElement('p', 'Note', Text('EnvEditNote')));
  }

  function MakeElement(Tag, ClassName, TextValue) {
    const Item = document.createElement(Tag);
    if (ClassName) Item.className = ClassName;
    if (TextValue !== undefined && TextValue !== null) Item.textContent = TextValue;
    return Item;
  }

  function RenderProperties(Details) {
    const Panel = $('PropertiesPanel');
    Panel.innerHTML = '';
    const Header = MakeElement('div', 'PropHeader');
    Header.appendChild(MakeElement('b', null, Details.CopyOf ? `${Details.Class} · ${Text('PropNewCopy', { Id: Details.CopyOf })}` : `${Details.Class} · #${Details.Id}`));
    Header.appendChild(MakeElement('div', null, `${Text('PropTemplate')} ${Details.Template} · ${Text('PropModel')} ${Details.Model} · ${Details.ClassId || ''}`));
    Header.appendChild(MakeElement('div', null, `${Text('PropBaked')} ${Details.BakedLight} · ${Text('PropLinks')} ${Details.Links.length}`));
    Panel.appendChild(Header);

    Panel.appendChild(MakeElement('div', 'PropGroupTitle', Text('PropTransform')));
    const Grid = MakeElement('div', 'TransformGrid');
    const Row = (Label, Values, Digits, Kind) => {
      Grid.appendChild(MakeElement('span', null, Label));
      for (const [Axis, Value] of Values.entries()) {
        const Input = document.createElement('input');
        Input.readOnly = true;
        Input.dataset.kind = Kind;
        Input.dataset.axis = Axis;
        Input.value = Digits === undefined ? String(Value) : Number(Value).toFixed(Digits);
        Input.title = Input.value;
        Grid.appendChild(Input);
      }
    };
    Row(Text('PropPosition'), Details.Position, 3, 'Position');
    Row(Text('PropRotation'), Details.Rotation.map(Value => Value + '°'), undefined, 'Rotation');
    Row(Text('PropScale'), Details.Scale, 3, 'Scale');
    Panel.appendChild(Grid);
    if (Details.Class === 'Point Light' && LevelView.LightOf(Details.Id)) RenderLightEditor(Panel, Details);
    const InstanceNumber = LevelView.Scene ? LevelView.Scene.Instances.findIndex(Instance => Instance[6] === Details.Id) : -1;
    if (InstanceNumber >= 0 && Gizmo.Modified.has(InstanceNumber)) UpdateTransformFields(InstanceNumber, LevelView.Scene.Instances[InstanceNumber]);

    Panel.appendChild(MakeElement('div', 'PropGroupTitle', `${Text('PropFlags')} · ${Details.Flags}`));
    const Flags = MakeElement('div', 'FlagList');
    const Editable = InstanceNumber >= 0 && LevelView.Scene.Instances[InstanceNumber][0] !== 'terrain';
    const Current = CurrentFlags(InstanceNumber, Details);
    // PT: 0x10, 0x100 e 0x8000 mudam o tamanho do registro: ficam travadas / EN: layout bits stay locked
    const Locked = 0x10 | 0x100 | 0x8000;
    for (const Flag of Details.FlagList) {
      const Label = MakeElement('label', Flag.Confirmed ? '' : 'Unconfirmed');
      const Box = document.createElement('input');
      Box.type = 'checkbox'; Box.checked = Boolean(Current & Flag.Bit); Box.disabled = !Editable || Boolean(Flag.Bit & Locked);
      if (!Box.disabled) Box.addEventListener('change', () => SetFlags(InstanceNumber, Details, Box.checked ? Current | Flag.Bit : Current & ~Flag.Bit));
      if (Boolean(Current & Flag.Bit) !== Flag.On) Label.classList.add('Changed');
      Label.append(Box, MakeElement('span', 'Name', RiotLanguage === 'pt' ? Flag.Pt : Flag.En), MakeElement('code', null, '0x' + Flag.Bit.toString(16).toUpperCase()));
      Flags.appendChild(Label);
    }
    Panel.appendChild(Flags);
    if (Editable) {
      // PT: sombra dinâmica efetiva (0x1000 ? 0x400 : bit 0 do template) / EN: effective dynamic shadow
      const Code = LevelView.Scene.Instances[InstanceNumber][8] || 0;
      const Toggle = MakeElement('label', 'ShadowToggle');
      const Box = document.createElement('input');
      Box.type = 'checkbox';
      Box.checked = LevelView.Shadows.Casts(InstanceNumber);
      const Source = Current & 0x1000 ? Text('ShadowFromInstance') : Text('ShadowFromTemplate');
      Box.addEventListener('change', () => SetFlags(InstanceNumber, Details, (Current | 0x1000 | (Box.checked ? 0x400 : 0)) & ~(Box.checked ? 0 : 0x400)));
      Toggle.append(Box, MakeElement('span', null, Text('ShadowToggle')), MakeElement('small', null, '· ' + Source + (Code & 4 ? ' · ' + Text('ShadowTemplateOn') : ' · ' + Text('ShadowTemplateOff'))));
      Panel.appendChild(Toggle);
    }
    if (Details.UnknownFlags) Panel.appendChild(MakeElement('p', 'Note', Text('PropUnknownFlags', { Bits: Details.UnknownFlags })));
    Panel.appendChild(MakeElement('p', 'Note', Text('PropUnconfirmed')));

    Panel.appendChild(MakeElement('div', 'PropGroupTitle', `${Text('PropProperties')} · ${Details.OverrideCount}/${Details.Properties.length}`));
    const Filter = MakeElement('label', 'PropFilter');
    const OnlyBox = document.createElement('input');
    OnlyBox.type = 'checkbox'; OnlyBox.checked = !!Ui.OnlyOverridden;
    OnlyBox.addEventListener('change', () => { Ui.OnlyOverridden = OnlyBox.checked; RenderProperties(Details); });
    Filter.append(OnlyBox, MakeElement('span', null, Text('PropOnlyOverridden')));
    Panel.appendChild(Filter);
    const Table = MakeElement('table', 'PropTable');
    const Head = MakeElement('tr');
    for (const Key of ['PropIndex', 'PropType', 'PropValue']) Head.appendChild(MakeElement('th', null, Text(Key)));
    const HeadSection = document.createElement('thead'); HeadSection.appendChild(Head); Table.appendChild(HeadSection);
    const Body = document.createElement('tbody');
    for (const Property of Details.Properties) {
      if (Ui.OnlyOverridden && !Property.Overridden) continue;
      const Line = MakeElement('tr', Property.Overridden ? 'Overridden' : '');
      Line.appendChild(MakeElement('td', 'Index', String(Property.Index)));
      Line.appendChild(MakeElement('td', 'Type', Property.TypeName));
      const Cell = MakeElement('td', 'Value');
      const Name = RiotLanguage === 'pt' ? Property.Pt : Property.En;
      if (Property.Slot) {
        const Badge = MakeElement('span', 'SlotBadge ' + (Property.Slot === 'in' ? 'In' : 'Out'), Property.Slot === 'in' ? '⟵ ' + Text('SlotIn') : Text('SlotOut') + ' ⟶');
        Badge.title = Text(Property.Slot === 'in' ? 'SlotInTitle' : 'SlotOutTitle');
        Cell.appendChild(Badge);
      }
      if (Name) Cell.appendChild(MakeElement('span', 'PropName', Name));
      const Editor = PropertyEditor(Details, Property);
      if (Editor) {
        Cell.appendChild(Editor);
        const Edited = LightEdits.get(Details.Id);
        if (Edited && Edited.Properties[Property.Index] !== undefined) Line.classList.add('Edited');
      } else Cell.appendChild(document.createTextNode(Property.Overridden ? Property.Value : (Property.Default ?? '—')));
      if (Property.Overridden) Cell.appendChild(MakeElement('small', null, Text('PropDefault', { Value: Property.Default ?? '—' })));
      Line.appendChild(Cell);
      Body.appendChild(Line);
    }
    Table.appendChild(Body);
    Panel.appendChild(Table);
    Panel.appendChild(MakeElement('p', 'Note', Text('PropReadOnly')));
    RenderLinks(Panel, Details);
  }

  /**
   * PT: Lógica da fase: o que esta instância manda pelos links e quem manda para ela. Cada saída manda a mensagem da
   *     propriedade para TODOS os links; o alvo reage se uma entrada dele tiver a mesma mensagem.
   * EN: Level logic: what this instance sends along its links and who sends to it.
   */
  function RenderLinks(Panel, Details) {
    if (!Details.LinkOut) return;
    Panel.appendChild(MakeElement('div', 'PropGroupTitle', `${Text('LinksTitle')} · ${Details.LinkOut.length} ⟶ · ⟵ ${Details.LinkIn.length}`));
    if (Details.Outputs && Details.Outputs.length)
      Panel.appendChild(MakeElement('p', 'LinkSends', Text('LinksSends', { List: Details.Outputs.map(Output => `p${Output.Property} = ${Output.Message}${Output.Name ? ' ' + Output.Name : ''}`).join(' · ') })));
    if (Details.FixedInputs && Details.FixedInputs.length)
      Panel.appendChild(MakeElement('p', 'LinkSends', Text('LinksFixed', { List: Details.FixedInputs.join(' · ') })));
    const Table = (Rows, Direction) => {
      const Element = MakeElement('table', 'PropTable LinkTable');
      for (const Row of Rows) {
        const Line = MakeElement('tr', Row.Missing ? 'Missing' : 'Link');
        const Heard = (Row.Heard || []).map(Item => `${Item.Message}${Item.Name ? ' ' + Item.Name : ''}${Item.Property !== null && Item.Property !== undefined ? ' → p' + Item.Property : ''}`).join(', ');
        Line.append(MakeElement('td', 'Index', (Direction === 'out' ? '⟶ #' : '⟵ #') + Row.Id), MakeElement('td', 'Type', Row.Class || Text('LinksMissing')),
          MakeElement('td', 'Value', Heard || Text('LinksNothingHeard')));
        if (!Row.Missing) Line.addEventListener('click', () => SelectInstanceById(Row.Id, Row.Position));
        Element.appendChild(Line);
      }
      return Element;
    };
    if (Details.LinkOut.length) Panel.appendChild(Table(Details.LinkOut, 'out'));
    if (Details.LinkIn.length) Panel.appendChild(Table(Details.LinkIn, 'in'));
    Panel.appendChild(MakeElement('p', 'Note', Text('LinksNote')));
    LevelView.ShowLinks(Details);
  }

  function SelectInstanceById(Id, Position) {
    const Scene = LevelView.Scene;
    const Number = Scene ? Scene.Instances.findIndex(Instance => Instance[6] === Id) : -1;
    const Slots = Number >= 0 ? LevelView.InstanceSlots.get(Number) : null;
    if (Slots && Slots.length) { LevelView.Select({ Mesh: Slots[0][0], Slot: Slots[0][1], Point: null }); LevelView.FocusSelection(); return; }
    // PT: objeto lógico sem modelo (Detector, Relay…): mostra as propriedades e leva a câmera / EN: model-less logic object
    GoToInstance(Id, Position || [0, 0, 0]);
    Ui.ShowProperties(Scene.Key, Id);
    LevelView.Viewport.SetHighlight(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...(Position || [0, 0, 0])), new THREE.Vector3(0.6, 0.6, 0.6)));
  }


  /** PT: Atualiza os campos de transformação do painel durante a edição. EN: Updates the panel transform fields while editing. */
  function UpdateTransformFields(Number, Instance) {
    const Details = Ui.LastProperties;
    if (!Details || Details.Id !== Instance[6]) return;
    const Original = Gizmo.Modified.get(Number);
    for (const Input of document.querySelectorAll('.TransformGrid input')) {
      const Kind = Input.dataset.kind, Axis = +Input.dataset.axis;
      const Value = Kind === 'Position' ? Instance[1][Axis] : Kind === 'Rotation' ? Instance[2][Axis] : Instance[3][Axis];
      Input.value = Kind === 'Rotation' ? Value + '°' : Number_(Value).toFixed(3);
      const Before = Original ? (Kind === 'Position' ? Original.Position[Axis] : Kind === 'Rotation' ? Original.Rotation[Axis] : Original.Scale[Axis]) : Value;
      Input.classList.toggle('Changed', Math.abs(Value - Before) > 1e-6);
      Input.title = Input.classList.contains('Changed') ? Text('PropChanged') : Input.value;
    }
  }
  const Number_ = Value => Number(Value);

  function SyncGizmoToolbar() {
    for (const Button of document.querySelectorAll('[data-gizmo]')) Button.setAttribute('aria-pressed', String(Button.dataset.gizmo === Gizmo.Mode));
    $('GizmoSpace').textContent = Text(Gizmo.Space === 'world' ? 'SpaceWorld' : 'SpaceLocal');
  }

  function FillClasses() {
    const List = $('ClassList');
    List.innerHTML = '';
    LevelView.ClassSummary().forEach((Item, Number) => {
      const Label = document.createElement('label');
      const Box = document.createElement('input');
      Box.type = 'checkbox'; Box.checked = Item.Visible; Box.id = 'Class' + Number;
      Box.addEventListener('change', () => LevelView.SetClassVisible(Item.Name, Box.checked));
      const Name = document.createElement('span'); Name.className = 'Name'; Name.textContent = Item.Name; Name.title = Item.Name;
      const Count = document.createElement('span'); Count.className = 'Count'; Count.textContent = NumberText(Item.Count);
      Label.append(Box, Name, Count);
      Label.dataset.name = Item.Name.toLowerCase();
      List.appendChild(Label);
      if (!Item.Visible) LevelView.SetClassVisible(Item.Name, false);
    });
    FilterClasses();
  }

  function FilterClasses() {
    const Query = $('ClassFilter').value.trim().toLowerCase();
    for (const Label of $('ClassList').children) Label.hidden = Query && !Label.dataset.name.includes(Query);
  }

  function SetAllClasses(Visible) {
    for (const Label of $('ClassList').children) {
      if (Label.hidden) continue;
      const Box = Label.querySelector('input');
      if (Box.checked !== Visible) { Box.checked = Visible; Box.dispatchEvent(new Event('change')); }
    }
  }

  function SyncLighting() {
    const Gain = +$('LightGain').value, Ambient = +$('LightAmbient').value;
    LevelView.SetLighting($('LightBaked').checked, $('LightPoint').checked, Gain, Ambient);
    $('LightGainValue').textContent = NumberText(Gain, 2) + '×';
    $('LightAmbientValue').textContent = NumberText(Ambient, 2);
  }

  function SyncShadows() {
    const Shadows = LevelView.Shadows;
    Shadows.Enabled = $('ShadowOn').checked;
    LevelView.Uniforms.ShadowDebug.value = $('ShadowDebug').checked ? 1 : 0;
    Shadows.FadeStart = Math.max(0, +$('ShadowFadeStart').value || 0);
    Shadows.FadeEnd = Math.max(Shadows.FadeStart + 0.1, +$('ShadowFadeEnd').value || 0);
    if (Shadows.Highlight !== $('ShadowMarkers').checked) { Shadows.Highlight = $('ShadowMarkers').checked; Shadows.UpdateMarker(); }
    else if (Shadows.Highlight) Shadows.UpdateMarker();
    ShowShadowStatus();
  }

  function ShowShadowStatus() {
    const Shadows = LevelView.Shadows;
    if (!LevelView.Scene) { $('ShadowStatus').textContent = ''; return; }
    const NoLight = Shadows.Casters.filter(Caster => !Caster.HasLight).length;
    let Message = Text('ShadowStatus', { Casters: Shadows.Casters.length, Active: Shadows.Enabled ? Shadows.Active.length : 0,
      NoLight: NoLight ? Text('ShadowNoLight', { Count: NoLight }) : '' });
    if (!LevelView.Scene.ShadowFade) Message += ' ' + Text('ShadowFadeTTB');
    $('ShadowStatus').textContent = Message;
  }

  function SyncRenderMode() {
    Viewport.RenderMode.Textured = document.querySelector('input[name=RenderMode]:checked').value === 'Textured';
    Viewport.RenderMode.Wireframe = $('RenderWireframe').checked;
    Viewport.ApplyRenderMode();
    LevelView.ShowNormals($('RenderNormals').checked);
  }

  function SelectTab(Name) {
    CurrentTab = Name;
    for (const Tab of document.querySelectorAll('.Tab')) Tab.setAttribute('aria-selected', String(Tab.dataset.tab === Name));
    const IsLevel = Name === 'Level', IsAsset = RiotAssetTabs.Has(Name);
    $('Workspace').classList.toggle('AssetMode', IsAsset);
    $('Placeholder').hidden = IsLevel || IsAsset;
    $('SidePanel').style.visibility = IsLevel ? 'visible' : 'hidden';
    if (Viewport) Viewport.Active = !IsAsset;
    RiotAssetTabs.Show(IsAsset ? Name : null);
    if (IsLevel) $('StatusText').textContent = Ui.LevelStatus || '';
    if (!IsLevel && !IsAsset) {
      const Tab = document.querySelector(`.Tab[data-tab="${Name}"]`);
      $('PlaceholderTitle').textContent = Tab ? Tab.textContent : Name;
    }
    try { localStorage.setItem('SurrealEdTab', Name); } catch (Error) { /* ignora */ }
  }

  function CloseMenus() {
    for (const List of document.querySelectorAll('.MenuList')) List.hidden = true;
    for (const Button of document.querySelectorAll('.MenuButton')) Button.setAttribute('aria-expanded', 'false');
  }

  // ------------------------------------------------------------------ luzes / lights
  const LightEdits = new Map();     // PT: id da instância -> {Number, Original, Properties} / EN: instance id -> edit
  let LightPicker = null, RelightPending = null;

  /** PT: Índices das propriedades da Point Light (TS1 / TTB). EN: Point Light property indexes. */
  function LightProps() { return LevelView.Scene.Game === 'TTB' ? { Color: 0, Enabled: 7, Intensity: 9 } : { Color: 0, Enabled: 6, Intensity: 8 }; }

  function FloatBits(Value) { const View = new DataView(new ArrayBuffer(4)); View.setFloat32(0, Value, true); return View.getUint32(0, true); }

  /** PT: Reacende no próximo quadro (junta várias mudanças seguidas). EN: Relights on the next frame. */
  function QueueLight(Id, Changes) {
    RelightPending = RelightPending || new Map();
    RelightPending.set(Id, Object.assign(RelightPending.get(Id) || {}, Changes));
    requestAnimationFrame(() => {
      if (!RelightPending) return;
      for (const [LightId, Pending] of RelightPending) LevelView.UpdateLight(LightId, Pending);
      RelightPending = null;
    });
  }

  /** PT: Entrada de edição de uma instância (propriedades sobrescritas). EN: Edit entry of one instance. */
  function EditOf(Details) {
    let Edit = LightEdits.get(Details.Id);
    if (!Edit) {
      const Number = LevelView.Scene.Instances.findIndex(Instance => Instance[6] === Details.Id);
      Edit = { Number, Id: Details.Id, Properties: {}, Originals: {} };
      const Light = LevelView.LightOf(Details.Id);
      if (Light) {
        const ColorRow = Details.Properties.find(Property => Property.Index === LightProps().Color);
        Edit.Alpha = ColorRow ? (ColorRow.Raw >>> 24) : 0;
        Edit.Original = { Color: Light.slice(3, 6), Intensity: Light[6], Enabled: Light[8] !== 0 };
      }
      LightEdits.set(Details.Id, Edit);
    }
    return Edit;
  }

  function RawOf(Details, Property) {
    const Edit = LightEdits.get(Details.Id);
    return Edit && Edit.Properties[Property.Index] !== undefined ? Edit.Properties[Property.Index] : Property.Raw;
  }

  function BitsFloat(Raw) { const View = new DataView(new ArrayBuffer(4)); View.setUint32(0, Raw >>> 0, true); return View.getFloat32(0, true); }

  /**
   * PT: Grava (na memória) um valor bruto de propriedade. Se for cor/intensidade/liga de uma Point Light, acende na hora.
   * EN: Records a raw property value; Point Light colour/intensity/on-off relight live.
   */
  function SetProperty(Details, Property, Raw) {
    const Edit = EditOf(Details);
    Raw >>>= 0;
    if (Raw === (Property.Raw >>> 0) && !Property.Overridden) delete Edit.Properties[Property.Index];
    else Edit.Properties[Property.Index] = Raw;
    if (Edit.Original) {
      const Props = LightProps();
      if (Property.Index === Props.Color) QueueLight(Details.Id, { Color: [(Raw >> 16 & 255) / 255, (Raw >> 8 & 255) / 255, (Raw & 255) / 255] });
      if (Property.Index === Props.Intensity) QueueLight(Details.Id, { Intensity: BitsFloat(Raw) });
      if (Property.Index === Props.Enabled) QueueLight(Details.Id, { Enabled: Raw !== 0 });
    }
    Ui.TransformChanged(Edit.Number, LevelView.Scene.Instances[Edit.Number]);
  }

  /**
   * PT: Campo de edição de uma propriedade conforme o tipo (listas continuam só leitura):
   *       float → número · int/bool/enum → inteiro · cor → amostra que abre a roda de cor · mensagem (entrada/saída) →
   *       menu com os nomes · referência → "pacote_índice" · link de objeto (0x13) → uid.
   * EN: Type-based editor for a property (lists stay read-only).
   */
  function PropertyEditor(Details, Property) {
    const Type = Property.Type, Base = Type & 0xFF;
    if (Type & 0x1000 || Property.Raw === null || Property.Raw === undefined) return null;
    const Raw = RawOf(Details, Property) >>> 0;
    const Input = document.createElement('input');
    Input.className = 'PropInput';
    if (Type === 0x0002 || Type === 0x0015 || Type === 0x0016) {
      const Set = Wanted => SetProperty(Details, Property, FloatBits(Wanted));
      return NumberSlider(BitsFloat(Raw), true, Set, Set);
    }
    // PT: liga/desliga: tipo 0x07 com 0/1, ou int com nome de chave (Enabled, Loop, Starts on…) / EN: on/off switches
    const Named = /enabl|^on\b|active|visible|start|loop|^is |^has |locked|open|solid|hidden|^use |ligad|ativ|vis[ií]vel|aberto|trancad/i.test([Property.Name, Property.En, Property.Pt].filter(Boolean).join(' '));
    if ((Raw === 0 || Raw === 1) && (Type === 0x0007 || (Type === 0x0001 && Named))) return CheckBox(Raw === 1, Checked => SetProperty(Details, Property, Checked ? 1 : 0));
    if (Type === 0x000F) {
      const Hex = Value => (Value & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0');
      const Swatch = MakeElement('button', 'PropSwatch', '#' + Hex(Raw));
      Swatch.type = 'button';
      Swatch.style.setProperty('--Swatch', '#' + Hex(Raw));
      Swatch.addEventListener('click', () => OpenColorPopup(Swatch, [(Raw >> 16 & 255) / 255, (Raw >> 8 & 255) / 255, (Raw & 255) / 255], (Rgb, Final) => {
        const [R, G, B] = Rgb.map(Value => Math.round(Value * 255));
        const Value = ((Raw & 0xFF000000) | (R << 16) | (G << 8) | B) >>> 0;
        Swatch.textContent = '#' + Hex(Value);
        Swatch.style.setProperty('--Swatch', '#' + Hex(Value));
        if (Final || LevelView.LightOf(Details.Id)) SetProperty(Details, Property, Value);
      }));
      return Swatch;
    }
    if (Type === 0x0011 && Property.Slot) {
      const Select = document.createElement('select');
      Select.className = 'PropInput';
      const Names = Object.entries((Game && Game.MessageNames) || {});
      if (!Names.some(([Id]) => +Id === Raw)) Names.unshift([String(Raw), '?']);
      for (const [Id, Label] of Names) { const Option = MakeElement('option', null, `${Id} · ${Label}`); Option.value = Id; Select.appendChild(Option); }
      Select.value = String(Raw);
      Select.addEventListener('change', () => SetProperty(Details, Property, +Select.value));
      return Select;
    }
    const IsRef = (Type & 0x6000) || [0x03, 0x04, 0x05, 0x09, 0x0A, 0x0B, 0x0E, 0x10, 0x12, 0x14].includes(Base);
    if (IsRef) {
      Input.type = 'text'; Input.spellcheck = false;
      Input.value = Raw ? `${Raw >>> 16}_${(Raw & 0xFFFF).toString(16).padStart(4, '0')}` : '—';
      Input.addEventListener('change', () => {
        const Match = /^(\d+)_([0-9a-f]{1,4})$/i.exec(Input.value.trim());
        if (Match) SetProperty(Details, Property, ((+Match[1] << 16) | parseInt(Match[2], 16)) >>> 0);
        else if (/^(—|-|0|)$/.test(Input.value.trim())) SetProperty(Details, Property, 0);
      });
      return Input;
    }
    if ([0x01, 0x07, 0x08].includes(Base)) {
      const Signed = Base === 0x08 || Raw >= 0x80000000;
      const Set = Wanted => SetProperty(Details, Property, Wanted >>> 0);
      return NumberSlider(Signed ? (Raw | 0) : Raw, false, Set, Set);
    }
    if ([0x11, 0x13].includes(Base) || Type === 0) {
      Input.type = 'number'; Input.step = '1';
      Input.value = Base === 0x08 || Raw >= 0x80000000 ? (Raw | 0) : Raw;
      Input.addEventListener('change', () => SetProperty(Details, Property, Math.round(+Input.value || 0)));
      return Input;
    }
    return null;
  }

  /** PT: Roda de cor flutuante perto de um elemento. EN: Floating colour wheel next to an element. */
  function OpenColorPopup(Anchor, Rgb, OnChange) {
    document.querySelectorAll('.ColorPopup').forEach(Popup => Popup.remove());
    const Popup = MakeElement('div', 'ColorPopup');
    const Close = MakeElement('button', 'ColorPopupClose', '×');
    Close.type = 'button';
    Close.addEventListener('click', () => Popup.remove());
    Popup.appendChild(Close);
    new RiotColorPicker(Popup, { Color: Rgb, OnChange, Labels: { Old: Text('ColorOld'), New: Text('ColorNew'), Restore: Text('ColorRestore') } });
    document.body.appendChild(Popup);
    const Box = Anchor.getBoundingClientRect();
    Popup.style.left = Math.max(8, Math.min(window.innerWidth - 300, Box.left - 300)) + 'px';
    Popup.style.top = Math.max(8, Math.min(window.innerHeight - 420, Box.top - 40)) + 'px';
  }

  function RecordLight(Details, Changes) {
    const Props = LightProps(), Edit = EditOf(Details), Number = Edit.Number;
    if (Changes.Color) {
      const [R, G, B] = Changes.Color.map(Value => Math.round(Math.max(0, Math.min(1, Value)) * 255));
      Edit.Properties[Props.Color] = ((Edit.Alpha << 24) | (R << 16) | (G << 8) | B) >>> 0;
    }
    if (Changes.Intensity !== undefined) Edit.Properties[Props.Intensity] = FloatBits(Changes.Intensity);
    if (Changes.Enabled !== undefined) Edit.Properties[Props.Enabled] = Changes.Enabled ? 1 : 0;
    Ui.TransformChanged(Number, LevelView.Scene.Instances[Number]);
  }

  /**
   * PT: Editor da Point Light: roda de cor (estilo UMG), intensidade e liga/desliga. As mudanças acendem o mundo na hora
   *     (Point Lights por vértice, aproximação) e são gravadas no .lvl com Ctrl+S.
   * EN: Point Light editor: colour wheel, intensity and on/off; changes relight the world live and save with Ctrl+S.
   */
  function RenderLightEditor(Panel, Details) {
    const Light = LevelView.LightOf(Details.Id);
    Panel.appendChild(MakeElement('div', 'PropGroupTitle', Text('LightEditTitle')));
    const Box = MakeElement('div', 'LightEditor');
    LightPicker = new RiotColorPicker(Box, {
      Color: Light.slice(3, 6), Labels: { Old: Text('ColorOld'), New: Text('ColorNew'), Restore: Text('ColorRestore') },
      OnChange: (Rgb, Final) => { QueueLight(Details.Id, { Color: Rgb }); if (Final) RecordLight(Details, { Color: Rgb }); },
    });
    const Row = MakeElement('div', 'LightRow');
    const Enabled = document.createElement('input');
    Enabled.type = 'checkbox'; Enabled.checked = Light[8] !== 0;
    Enabled.addEventListener('change', () => { QueueLight(Details.Id, { Enabled: Enabled.checked }); RecordLight(Details, { Enabled: Enabled.checked }); });
    const EnabledLabel = MakeElement('label', 'Check');
    EnabledLabel.append(Enabled, MakeElement('span', null, Text('LightEnabled')));
    // PT: intensidade = p8 (TS1) / p9 (TTB); nível no shader = intensidade / d² (em metros) / EN: level = intensity / d²
    const Range = document.createElement('input'), Number_ = document.createElement('input');
    Range.type = 'range'; Range.min = '0'; Range.max = '1'; Range.step = '0.001';
    Number_.type = 'number'; Number_.min = '0'; Number_.step = '0.1'; Number_.className = 'LightNumber';
    const ToSlider = Value => Math.log10(1 + Value) / Math.log10(1001), FromSlider = Value => Math.pow(1001, Value) - 1;
    Range.value = ToSlider(Light[6]); Number_.value = Light[6].toFixed(2);
    Range.addEventListener('input', () => { const Value = +FromSlider(+Range.value).toFixed(2); Number_.value = Value; QueueLight(Details.Id, { Intensity: Value }); });
    Range.addEventListener('change', () => RecordLight(Details, { Intensity: +Number_.value }));
    Number_.addEventListener('change', () => { const Value = Math.max(0, +Number_.value || 0); Range.value = ToSlider(Value); QueueLight(Details.Id, { Intensity: Value }); RecordLight(Details, { Intensity: Value }); });
    const IntensityLabel = MakeElement('label', 'LightIntensity');
    IntensityLabel.append(MakeElement('span', null, Text('LightIntensity')), Range, Number_);
    Row.append(EnabledLabel, IntensityLabel);
    Box.appendChild(Row);
    Box.appendChild(MakeElement('p', 'Note', Text('LightEditNote', { Radius: NumberText(LevelView.LightCut(Light), 1) })));
    Panel.appendChild(Box);
  }

  // ------------------------------------------------------------------ edição e gravação / editing and saving
  const FlagEdits = new Map();      // PT: instância -> {Original, Flags} / EN: instance -> {Original, Flags}

  function CurrentFlags(Number, Details) {
    const Edit = FlagEdits.get(Number);
    return Edit ? Edit.Flags : parseInt(Details.Flags, 16) >>> 0;
  }

  function SetFlags(Number, Details, Flags) {
    Flags >>>= 0;
    const Original = FlagEdits.has(Number) ? FlagEdits.get(Number).Original : parseInt(Details.Flags, 16) >>> 0;
    if (Flags === Original) FlagEdits.delete(Number); else FlagEdits.set(Number, { Original, Flags, Id: Details.Id });
    ApplyShadowFlag(Number, Flags);
    RenderProperties(Details);
    Ui.TransformChanged(Number, LevelView.Scene.Instances[Number]);
  }

  /** PT: Atualiza a prévia de sombra de uma instância pelas flags. EN: Updates the shadow preview from the flags. */
  function ApplyShadowFlag(Number, Flags) {
    const Code = LevelView.Scene.Instances[Number][8] || 0;
    const Casts = Flags & 0x1000 ? Boolean(Flags & 0x400) : Boolean(Code & 4);
    LevelView.Shadows.SetOverride(Number, Casts);
    SyncShadows();
  }

  function DirtyCount() {
    const Dirty = new Set();
    if (Gizmo) for (const [Number, Original] of Gizmo.Modified) if (JSON.stringify(Gizmo.Values(Number)) !== JSON.stringify(Original)) Dirty.add(Number);
    for (const [Number] of FlagEdits) Dirty.add(Number);
    for (const Edit of LightEdits.values()) if (Object.keys(Edit.Properties).length) Dirty.add(Edit.Number >= 0 ? Edit.Number : 'id' + Edit.Id);
    for (const Number of Structure.Added.keys()) Dirty.add(Number);
    for (const Number of Structure.Removed) if (Structure.Added.has(Number)) Dirty.delete(Number); else Dirty.add(Number);
    return Dirty.size;
  }

  // ------------------------------------------------------------------ atalhos das abas de recursos / asset tab shortcuts
  // PT: W/S (ou setas) andam na lista; espaço toca/para (Animação, Áudio, STOMP, Vídeo). EN: W/S walk the list; space plays/stops.
  const AssetLists = { Models: ['ModelList', null], Animation: ['AnimList', 'AnimPlay'], Audio: ['AudioList', 'AudioPlay'], STOMP: ['StompList', 'StompPlay'], Video: ['VideoList', 'VideoPlayer'] };

  let MouseButtons = 0;   // PT: com botão apertado, WASD é voo da câmera / EN: with a button held, WASD flies the camera
  window.addEventListener('mousedown', Event => { MouseButtons = Event.buttons; });
  window.addEventListener('mouseup', Event => { MouseButtons = Event.buttons; });
  window.addEventListener('blur', () => { MouseButtons = 0; });

  function AssetShortcut(Event) {
    const Entry = AssetLists[CurrentTab];
    if (!Entry || Event.ctrlKey || Event.metaKey || Event.altKey || MouseButtons) return false;
    const [ListId, PlayId] = Entry, Key = Event.key.toLowerCase();
    if (Key === 'w' || Key === 's' || Key === 'arrowup' || Key === 'arrowdown') {
      const Rows = [...document.querySelectorAll(`#${ListId} .AssetRow`)];
      if (!Rows.length) return true;
      const Current = Rows.findIndex(Row => Row.getAttribute('aria-selected') === 'true');
      const Step = Key === 's' || Key === 'arrowdown' ? 1 : -1;
      const Next = Current < 0 ? 0 : Math.max(0, Math.min(Rows.length - 1, Current + Step));
      Event.preventDefault();
      if (Next !== Current) { Rows[Next].click(); Rows[Next].scrollIntoView({ block: 'nearest' }); }
      return true;
    }
    if (Event.key === ' ' && PlayId) {
      Event.preventDefault();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      const Target = $(PlayId);
      if (Target.tagName === 'VIDEO') { if (!Target.hidden) { if (Target.paused) Target.play().catch(() => {}); else Target.pause(); } }
      else if (!Target.disabled) Target.click();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ STOMP na fase / STOMP in the level
  function SyncStompBar() {
    const Player = LevelView.Stomp;
    $('ViewportArea').classList.toggle('StompMode', Player.Active);
    if (!Player.Active) { $('StompBar').hidden = true; $('StompSubtitle').hidden = true; return; }
    const Duration = Math.max(Player.Sequence.Duration, 0.001);
    $('StompBarPlay').textContent = Text(Player.Playing ? 'AnimPause' : 'AnimPlay');
    if (document.activeElement !== $('StompBarTime')) $('StompBarTime').value = String(Player.Time);
    $('StompBarLabel').textContent = `${NumberText(Player.Time, 2)} / ${NumberText(Duration, 2)} s`;
    const Log = Player.Log.slice(-4).join('\n');
    if ($('StompBarLog').textContent !== Log) { $('StompBarLog').textContent = Log; $('StompBarLog').scrollTop = 1e6; }
  }

  function SetupStompBar() {
    const Player = LevelView.Stomp;
    Player.OnChange = SyncStompBar;
    Player.OnSound = Event => {
      const [Package, Index] = Event.Sound.split('_');
      const Voice = new Audio(`/api/Sound/${Package}/${parseInt(Index, 16)}`);
      let Volume = 0.8;
      try { Volume = Number(localStorage.getItem('SurrealEdAudioVolume') || 0.8); } catch (Error) { /* PT: sem armazenamento / EN: no storage */ }
      Voice.volume = Math.max(0, Math.min(1, Volume * (Event.Volume || 1)));
      Voice.play().catch(() => {});
      return Voice;
    };
    Player.OnSubtitle = Line => { $('StompSubtitle').hidden = !Line; $('StompSubtitle').textContent = Line || ''; };
    $('StompBarPlay').addEventListener('click', () => Player.SetPlaying(!Player.Playing));
    $('StompBarClose').addEventListener('click', () => Player.Stop());
    $('StompBarTime').addEventListener('input', () => { Player.SetPlaying(false); Player.SetTime(Number($('StompBarTime').value)); });
    $('StompBarCamera').addEventListener('change', () => {
      Player.SceneCamera = $('StompBarCamera').checked;
      if (!Player.SceneCamera) {
        // PT: solta a câmera onde ela está / EN: release the camera where it is
        const Camera = Viewport.Camera, Forward = new THREE.Vector3();
        Camera.getWorldDirection(Forward);
        Viewport.SetView(Camera.position.clone(), Camera.position.clone().add(Forward.multiplyScalar(5)));
      }
    });
    $('StompBarSound').addEventListener('change', () => { Player.Sound = $('StompBarSound').checked; });
  }

  // ------------------------------------------------------------------ copiar / colar / apagar · copy / paste / delete
  // PT: Cópias ganham um id temporário negativo até gravar; o servidor dá o id de verdade, pendura a cópia na
  //     árvore de células e no histórico (RiotLevelEdit.py). Apagar só grava se ninguém mais referencia o objeto.
  // EN: Copies get a negative temporary id until saved; deletions are refused by the server while referenced.
  const Structure = { Added: new Map(), Removed: new Set() };   // PT: nº -> {Temp, Source} · nºs apagados
  let Clipboard = null, NextTemp = -1;

  function ClearStructure() { Structure.Added.clear(); Structure.Removed.clear(); Clipboard = null; }

  function CopySelection() {
    const Number = LevelView.SelectedNumber();
    if (Number === null || Structure.Removed.has(Number)) { Ui.SetStatus(Text('CopyNothing')); return; }
    const Instance = LevelView.Scene.Instances[Number];
    Clipboard = { Number, Key: LevelView.Scene.Key };
    Ui.SetStatus(Text('Copied', { Class: Instance[4], Id: Instance[6] }));
  }

  function PasteCopy(SourceNumber) {
    const Scene = LevelView.Scene;
    if (SourceNumber === undefined) {
      if (!Clipboard || !Scene || Clipboard.Key !== Scene.Key || Structure.Removed.has(Clipboard.Number)) { Ui.SetStatus(Text('PasteNothing')); return; }
      SourceNumber = Clipboard.Number;
    }
    const Source = Scene.Instances[SourceNumber];
    const Temp = NextTemp--;
    const RealSource = Structure.Added.has(SourceNumber) ? Structure.Added.get(SourceNumber).Source : Source[6];
    const Step = Gizmo.TranslationSnap || 1;
    const Number = LevelView.AddCopy(SourceNumber, Temp, [Step, 0, 0]);
    Structure.Added.set(Number, { Temp, Source: RealSource });
    // PT: a cópia leva as edições ainda não gravadas do original / EN: the copy carries the source's unsaved edits
    const Flags = FlagEdits.get(SourceNumber);
    if (Flags) FlagEdits.set(Number, { Original: Flags.Original, Flags: Flags.Flags, Id: Temp });
    const Properties = LightEdits.get(Source[6]);
    if (Properties && Object.keys(Properties.Properties).length) {
      const Light = LevelView.LightOf(Temp);
      LightEdits.set(Temp, { Number, Id: Temp, Properties: { ...Properties.Properties }, Originals: {}, Alpha: Properties.Alpha,
        Original: Light ? { Color: Light.slice(3, 6), Intensity: Light[6], Enabled: Light[8] !== 0 } : undefined });
    }
    Gizmo.PushStep({ Kind: 'add', Number });
    SelectNumber(Number);
    Ui.SetStatus(Text('Pasted', { Class: Source[4] }));
    Ui.TransformChanged(Number, Scene.Instances[Number]);
  }

  function DeleteSelection() {
    const Number = LevelView.SelectedNumber();
    if (Number === null) return;
    const Instance = LevelView.Scene.Instances[Number];
    Structure.Removed.add(Number);
    LevelView.SetHidden(Number, true);
    Gizmo.Attach(null);
    Gizmo.PushStep({ Kind: 'remove', Number });
    Ui.SetStatus(Text('Deleted', { Class: Instance[4], Id: Instance[6] }));
    Ui.TransformChanged(null, null);
  }

  function ApplyStructureStep(Step, Undo) {
    // PT: desfazer "colar" = apagar; desfazer "apagar" = mostrar de novo / EN: undo paste = hide, undo delete = show
    const Hide = Step.Kind === 'add' ? Undo : !Undo;
    if (Hide) Structure.Removed.add(Step.Number); else Structure.Removed.delete(Step.Number);
    LevelView.SetHidden(Step.Number, Hide);
    if (!Hide) SelectNumber(Step.Number);
    Ui.TransformChanged(null, null);
  }

  function SelectNumber(Number) {
    const Slots = LevelView.InstanceSlots.get(Number);
    if (Slots && Slots.length) LevelView.Select({ Mesh: Slots[0][0], Slot: Slots[0][1], Point: null });
  }

  function PendingChanges() {
    const Changes = new Map();
    const Scene = LevelView.Scene;
    for (const [Number, Original] of Gizmo.Modified) {
      if (Structure.Added.has(Number) || Structure.Removed.has(Number)) continue;
      const Now = Gizmo.Values(Number);
      if (JSON.stringify(Now) === JSON.stringify(Original)) continue;
      const Change = { Id: Scene.Instances[Number][6] };
      if (JSON.stringify(Now.Position) !== JSON.stringify(Original.Position)) Change.Position = Now.Position;
      if (JSON.stringify(Now.Rotation) !== JSON.stringify(Original.Rotation)) Change.Rotation = Now.Rotation.map(Value => Math.round(Value));
      if (JSON.stringify(Now.Scale) !== JSON.stringify(Original.Scale)) Change.Scale = Now.Scale;
      Changes.set(Number, Change);
    }
    for (const [Number, Edit] of FlagEdits) {
      if (Structure.Added.has(Number) || Structure.Removed.has(Number)) continue;
      const Change = Changes.get(Number) || { Id: Edit.Id };
      Change.Flags = Edit.Flags;
      Changes.set(Number, Change);
    }
    for (const Edit of LightEdits.values()) {
      if (!Object.keys(Edit.Properties).length || Edit.Id < 0 || Structure.Removed.has(Edit.Number)) continue;
      const Key = Edit.Number >= 0 ? Edit.Number : 'id' + Edit.Id;
      const Change = Changes.get(Key) || { Id: Edit.Id };
      Change.Properties = Edit.Properties;
      Changes.set(Key, Change);
    }
    return [...Changes.values()];
  }

  /** PT: Cópias novas e objetos apagados para o servidor. EN: New copies and deleted objects for the server. */
  function PendingStructure() {
    const Scene = LevelView.Scene;
    const Added = [];
    for (const [Number, Item] of Structure.Added) {
      if (Structure.Removed.has(Number)) continue;
      const Instance = Scene.Instances[Number];
      const Add = { Temp: Item.Temp, Source: Item.Source, Position: Instance[1].slice(), Rotation: Instance[2].map(Value => Math.round(Value)), Scale: Instance[3].slice() };
      if (FlagEdits.has(Number)) Add.Flags = FlagEdits.get(Number).Flags;
      const Edit = LightEdits.get(Item.Temp);
      if (Edit && Object.keys(Edit.Properties).length) Add.Properties = Edit.Properties;
      Added.push(Add);
    }
    const Removed = [...Structure.Removed].filter(Number => !Structure.Added.has(Number)).map(Number => Scene.Instances[Number][6]);
    return { Added, Removed };
  }

  async function SaveLevel() {
    const Scene = LevelView.Scene;
    if (!Scene) return;
    const Changes = PendingChanges();
    const { Added, Removed } = PendingStructure();
    if (!Changes.length && !Added.length && !Removed.length) { Ui.SetStatus(Text('SaveNothing')); return; }
    Ui.SetStatus(Text('Saving', { File: Scene.File }));
    let Result;
    try {
      const Response = await fetch('/api/SaveLevel/' + encodeURIComponent(Scene.Key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Changes, Added, Removed }) });
      Result = await Response.json();
    } catch (Error) { Result = { Error: String(Error) }; }
    if (Result.Error) { Ui.SetStatus(Text('SaveFailed', { Error: Result.Error })); $('StatusText').classList.add('Dirty'); return; }
    if (Added.length || Removed.length) {
      // PT: objetos novos/apagados: recarrega a fase (ids e células de verdade), mantendo a câmera
      // EN: structural change: reload the level (real ids and cells), keeping the camera
      const Camera = Viewport.Camera, Forward = new THREE.Vector3();
      Camera.getWorldDirection(Forward);
      const View = [Camera.position.clone(), Camera.position.clone().add(Forward.multiplyScalar(5))];
      const NewIds = Object.values(Result.Added || {});
      FlagEdits.clear(); LightEdits.clear(); ClearStructure();
      await LevelView.Load(Scene.Key, { View });
      const Last = NewIds.length ? LevelView.Scene.Instances.findIndex(Instance => Instance[6] === NewIds[NewIds.length - 1]) : -1;
      if (Last >= 0) SelectNumber(Last);
      Ui.SetStatus(Text('SavedStructure', { Added: Added.length, Removed: Removed.length, File: Result.File, Backup: Result.Backup }));
      return;
    }
    // PT: o que foi gravado vira o novo "original" / EN: what was saved becomes the new baseline
    for (const [Number, Edit] of FlagEdits) {
      const Code = Scene.Instances[Number][8] || 0;
      const Casts = Edit.Flags & 0x1000 ? Boolean(Edit.Flags & 0x400) : Boolean(Code & 4);
      Scene.Instances[Number][8] = (Casts ? 1 : 0) | (Edit.Flags & 0x1000 ? 2 : 0) | (Code & 4);
      LevelView.Shadows.Overrides.delete(Number);
    }
    FlagEdits.clear();
    LightEdits.clear();
    const Selected = LevelView.SelectedNumber();
    Gizmo.Reset();
    if (Selected !== null) Gizmo.Attach(Selected);
    LevelView.Shadows.Build();
    Ui.SetStatus(Text('Saved', { Count: Result.Saved, File: Result.File, Backup: Result.Backup }));
    if (LevelView.Selected) LevelView.Select(LevelView.Selected, false, true);
  }

  async function RestoreLevel() {
    const Scene = LevelView.Scene;
    if (!Scene) return;
    const Status = await Ui.FetchJson('/api/FileStatus/' + encodeURIComponent(Scene.Key));
    if (!Status.HasBackup) { Ui.SetStatus(Text('RestoreNone', { File: Scene.File })); return; }
    if (!window.confirm(Text('RestoreConfirm', { File: Scene.File }))) return;
    const Response = await fetch('/api/RestoreLevel/' + encodeURIComponent(Scene.Key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const Result = await Response.json();
    FlagEdits.clear();
    await LevelView.Load(Scene.Key);
    Ui.SetStatus(Text(Result.Restored ? 'Restored' : 'RestoreNone', { File: Scene.File }));
  }

  function RunAction(Action) {
    CloseMenus();
    if (Action === 'ChooseLevel') { SelectTab('Level'); $('LevelSelect').focus(); }
    else if (Action === 'ReloadLevel') LevelView.Load($('LevelSelect').value);
    else if (Action === 'FocusSelection') LevelView.FocusSelection();
    else if (Action === 'ClearSelection') LevelView.Select(null);
    else if (Action === 'CameraOverview') LevelView.Overview();
    else if (Action === 'CameraStart') LevelView.StartView();
    else if (Action === 'LanguagePT' || Action === 'LanguageEN') { ApplyLanguage(Action === 'LanguagePT' ? 'pt' : 'en'); SyncLighting(); window.SurrealEdShowSpeed(); SyncGizmoToolbar(); if (LevelView.Scene) Ui.LevelLoaded(LevelView.Scene); if (Ui.LastProperties) RenderProperties(Ui.LastProperties); RiotAssetTabs.Relabel(); }
    else if (Action === 'About') $('AboutDialog').showModal();
    else if (Action === 'Undo') Gizmo.Undo();
    else if (Action === 'Redo') Gizmo.Redo();
    else if (Action === 'RevertSelection') { const Number = Gizmo.Number; if (Number !== null && Gizmo.Modified.has(Number)) { Gizmo.SetValues(Number, Gizmo.Modified.get(Number)); } }
    else if (Action === 'Copy') CopySelection();
    else if (Action === 'Paste') PasteCopy();
    else if (Action === 'Duplicate') { const Number = LevelView.SelectedNumber(); if (Number !== null) PasteCopy(Number); }
    else if (Action === 'Delete') DeleteSelection();
    else if (Action === 'RevertAll') {
      for (const Number of Structure.Added.keys()) LevelView.SetHidden(Number, true);
      for (const Number of Structure.Removed) if (!Structure.Added.has(Number)) LevelView.SetHidden(Number, false);
      for (const Number of Structure.Added.keys()) { Gizmo.Modified.delete(Number); FlagEdits.delete(Number); }
      Structure.Added.clear(); Structure.Removed.clear();
      for (const [Number, Original] of Gizmo.Modified) Gizmo.SetValues(Number, Original);
      Gizmo.UndoStack = []; Gizmo.RedoStack = [];
      for (const [Number, Edit] of [...FlagEdits]) { FlagEdits.delete(Number); ApplyShadowFlag(Number, Edit.Original); }
      for (const Edit of LightEdits.values()) if (Edit.Original) LevelView.UpdateLight(Edit.Id, Edit.Original);
      LightEdits.clear();
      if (Ui.LastProperties) RenderProperties(Ui.LastProperties);
      Ui.TransformChanged(Gizmo.Number, Gizmo.Number !== null ? LevelView.Scene.Instances[Gizmo.Number] : null);
    }
    else if (Action === 'SaveLevel') SaveLevel();
    else if (Action === 'RestoreLevel') RestoreLevel();
  }

  function BindUi() {
    for (const Button of document.querySelectorAll('.MenuButton[data-menu]')) {
      Button.setAttribute('aria-haspopup', 'true');
      Button.setAttribute('aria-expanded', 'false');
      Button.addEventListener('click', Event => {
        const List = $(Button.dataset.menu), WasOpen = !List.hidden;
        CloseMenus();
        if (!WasOpen) { List.hidden = false; Button.setAttribute('aria-expanded', 'true'); }
        Event.stopPropagation();
      });
    }
    document.addEventListener('click', CloseMenus);
    document.addEventListener('keydown', Event => {
      if (Event.key === 'Escape') CloseMenus();
      if (CurrentTab === 'Level' && (Event.ctrlKey || Event.metaKey) && (Event.key === 's' || Event.key === 'S')) { Event.preventDefault(); SaveLevel(); return; }
      if (/INPUT|SELECT|TEXTAREA/.test(Event.target.tagName)) return;
      if (AssetShortcut(Event)) return;
      if (CurrentTab !== 'Level') return;   // PT: atalhos da fase só na aba Fase / EN: level shortcuts only on the Level tab
      if (Event.key === 'f' || Event.key === 'F') LevelView.FocusSelection();
      if ((Event.ctrlKey || Event.metaKey) && (Event.key === 'z' || Event.key === 'Z')) { Event.preventDefault(); if (Event.shiftKey) Gizmo.Redo(); else Gizmo.Undo(); return; }
      if ((Event.ctrlKey || Event.metaKey) && (Event.key === 'y' || Event.key === 'Y')) { Event.preventDefault(); Gizmo.Redo(); return; }
      if (CurrentTab === 'Level' && LevelView.Scene && (Event.ctrlKey || Event.metaKey) && !Event.altKey) {
        const Letter = Event.key.toLowerCase();
        if (Letter === 'c') { Event.preventDefault(); CopySelection(); return; }
        if (Letter === 'v') { Event.preventDefault(); PasteCopy(); return; }
        if (Letter === 'd') { Event.preventDefault(); const Number = LevelView.SelectedNumber(); if (Number !== null) PasteCopy(Number); return; }
      }
      if (CurrentTab === 'Level' && LevelView.Scene && Event.key === 'Delete') { Event.preventDefault(); DeleteSelection(); return; }
      if (Event.ctrlKey || Event.metaKey || Event.altKey || (Viewport.Controls.Buttons & 2)) return;   // PT: com o direito apertado, WASD/QE são voo / EN: right button held = flying
      const Modes = { q: 'select', w: 'translate', e: 'rotate', r: 'scale' };
      const Key = Event.key.toLowerCase();
      if (Modes[Key]) { Gizmo.SetMode(Modes[Key]); return; }
      if (Event.key === ' ') { Event.preventDefault(); Gizmo.CycleMode(); return; }
      if (Event.key === '`') { Gizmo.ToggleSpace(); return; }
    });
    for (const Button of document.querySelectorAll('[data-gizmo]')) Button.addEventListener('click', () => Gizmo.SetMode(Button.dataset.gizmo));
    $('GizmoSpace').addEventListener('click', () => Gizmo.ToggleSpace());
    $('SnapMove').addEventListener('change', () => { Gizmo.TranslationSnap = +$('SnapMove').value; Gizmo.ApplySettings(); });
    $('SnapRotate').addEventListener('change', () => { Gizmo.RotationSnap = +$('SnapRotate').value; Gizmo.ApplySettings(); });
    $('SnapScale').addEventListener('change', () => { Gizmo.ScaleSnap = +$('SnapScale').value; Gizmo.ApplySettings(); });
    for (const Element of document.querySelectorAll('[data-action]')) Element.addEventListener('click', Event => { Event.stopPropagation(); RunAction(Element.dataset.action); });
    for (const Tab of document.querySelectorAll('.Tab')) Tab.addEventListener('click', () => SelectTab(Tab.dataset.tab));
    $('LevelSelect').addEventListener('change', () => LevelView.Load($('LevelSelect').value));
    $('ClassFilter').addEventListener('input', FilterClasses);
    $('ClassAll').addEventListener('click', () => SetAllClasses(true));
    $('ClassNone').addEventListener('click', () => SetAllClasses(false));
    for (const Id of ['LightBaked', 'LightPoint', 'LightGain', 'LightAmbient']) $(Id).addEventListener('input', SyncLighting);
    $('RenderFog').addEventListener('change', ApplyFog);
    $('RenderSky').addEventListener('change', () => LevelView.SetSkyOn($('RenderSky').checked));
    $('RenderParticles').addEventListener('change', () => LevelView.Particles.SetOn($('RenderParticles').checked));
    $('RenderParticlesOff').addEventListener('change', () => LevelView.Particles.SetShowOff($('RenderParticlesOff').checked));
    $('RenderAnimate').addEventListener('change', () => { LevelView.AnimateOn = $('RenderAnimate').checked; });
    $('RenderLightIcons').addEventListener('change', () => { LevelView.LightIcons.visible = $('RenderLightIcons').checked; });
    // PT: tamanho dos ícones e desempenho / EN: icon size and performance
    $('IconSize').value = LevelView.IconSize;
    $('IconSize').addEventListener('input', () => LevelView.SetIconSize(Number($('IconSize').value)));
    $('Resolution').value = String(Viewport.ResolutionScale);
    $('Resolution').addEventListener('change', () => Viewport.SetResolution(Number($('Resolution').value)));
    const ShowGpu = () => {
      const Name = Viewport.GpuName();
      $('PerfGpu').textContent = Text(Viewport.IsSoftware() ? 'PerfSoftware' : 'PerfGpu', { Name });
      $('PerfGpu').classList.toggle('Warn', Viewport.IsSoftware());
    };
    ShowGpu();
    Viewport.OnStats = Stats => {
      $('PerfStats').textContent = Text('PerfStats', { Fps: Stats.Fps.toFixed(0), Logic: Stats.LogicMs.toFixed(1), Draw: Stats.DrawMs.toFixed(1), Calls: Stats.Calls });
    };
    $('RenderDormant').addEventListener('change', () => LevelView.SetShowDormant($('RenderDormant').checked));
    $('RenderDormant').parentElement.title = Text('RenderDormantTip');
    $('LightWorld').addEventListener('change', () => { LevelView.WorldOn = $('LightWorld').checked; LevelView.RelightAll(); });
    for (const Id of ['ShadowOn', 'ShadowMarkers', 'ShadowDebug', 'ShadowFadeStart', 'ShadowFadeEnd']) $(Id).addEventListener(Id.startsWith('ShadowFade') ? 'input' : 'change', SyncShadows);
    SetupStompBar();
    setInterval(() => { if (CurrentTab === 'Level' && LevelView.Shadows.Enabled) ShowShadowStatus(); }, 700);
    $('SplatFade').addEventListener('change', () => { LevelView.Uniforms.SplatFadeOn.value = $('SplatFade').checked ? 1 : 0; });
    for (const Element of document.querySelectorAll('input[name=RenderMode], #RenderWireframe, #RenderNormals')) Element.addEventListener('change', SyncRenderMode);
    $('CellShow').addEventListener('change', () => LevelView.ShowCells($('CellShow').checked));
    $('CellSelect').addEventListener('change', () => LevelView.DrawCells());
    $('CellGo').addEventListener('click', () => LevelView.GoToCell($('CellSelect').value));
  }

  async function Start() {
    ApplyLanguage();
    Viewport = new RiotViewport($('Viewport'));
    LevelView = new RiotLevelView(Viewport, Ui);
    window.SurrealEdDebug = { Viewport, Ui, get LevelView() { return LevelView; } };   // PT: para o console / EN: for the console
    RiotAssetTabs.Init(Ui);
    Gizmo = new RiotGizmo(Viewport, LevelView, Ui);
    Viewport.OnPick = Hit => { LevelView.Pick(Hit); if (Hit) ShowPane('Details'); };
    SetupPanes();
    const ShowSpeed = () => { $('SpeedLabel').textContent = Text('CameraSpeed', { Level: Viewport.Controls.SpeedIndex + 1 }); };
    Viewport.Controls.OnSpeedChange = ShowSpeed;
    ShowSpeed();
    window.SurrealEdShowSpeed = ShowSpeed;
    BindUi();
    SyncLighting();
    SyncGizmoToolbar();
    try {
      Game = await Ui.FetchJson('/api/Game');
    } catch (Error) {
      Ui.ShowLoading(Text('ServerError'), true);
      return;
    }
    $('VersionLabel').textContent = Game.Version;
    $('AboutVersion').textContent = Game.Version;
    $('GameLabel').textContent = Game.Title;
    $('StatusRight').textContent = Game.Root;
    $('StatusText').textContent = Text('StatusReady', { Title: Game.Title, Root: Game.Root });
    const Select = $('LevelSelect');
    for (const Level of Game.Levels) {
      const Option = document.createElement('option');
      Option.value = Level.Key;
      Option.textContent = Level.File === Level.Name ? Level.File : `${Level.File} — ${Level.Name}`;
      Select.appendChild(Option);
    }
    const Wanted = decodeURIComponent((location.hash || '').slice(1));
    const First = Game.Levels.find(Level => Level.Key === Wanted) || Game.Levels.find(Level => /^1a|^06/.test(Level.Key)) || Game.Levels[0];
    if (First) { Select.value = First.Key; LevelView.Load(First.Key); }
    window.SurrealEd = { Viewport, LevelView, Ui, Gizmo };
  }

  return { Start };
})();

RiotEditor.Start();
