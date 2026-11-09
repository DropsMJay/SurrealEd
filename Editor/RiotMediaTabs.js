/*
 * RiotMediaTabs — abas Áudio, STOMP e Vídeo / Audio, STOMP and Video tabs
 *
 * PT: Servidas por Riot/RiotMedia.py:
 *       Áudio  lista do .sdu, forma de onda (WebAudio), curva da boca (0x0305), legenda, volume/distâncias, salvar WAV
 *       STOMP  sequências do .qdu: trilhas por objeto da fase, marcadores por tipo de evento, vista de cima das chaves
 *              de transformação; a reprodução toca os sons dos eventos de som
 *       Vídeo  .vdu reconstruído como .wmv; pré-visualização em MP4 quando o ffmpeg está instalado
 * EN: Backed by Riot/RiotMedia.py. Registers itself into RiotAssetTabs (same pane/tab plumbing).
 */
(() => {
  const $ = Id => document.getElementById(Id);
  const { Make, InfoGrid, Table, SplitRef, LoadPackages, FillPackageSelect, Remember } = RiotAssetTabs.Shared;
  const Ui = () => RiotAssetTabs.Shared.Ui();
  const EventColors = { 0: '#7fb2e5', 1: '#8fd18a', 2: '#b7a6e8', 3: '#e0a33c', 4: '#d98bb8', 5: '#c9c46a', 6: '#6ec9c0', 7: '#e07a5f', 8: '#a0a39a', 9: '#f2d06b', 10: '#9db0c4' };
  const RefUrl = (Kind, Ref) => { const [Package, Index] = SplitRef(Ref); return `/api/${Kind}/${Package}/${Index}`; };
  let Context = null;
  function AudioContextOnce() { if (!Context) Context = new (window.AudioContext || window.webkitAudioContext)(); return Context; }

  /** PT: Lista com filtro, linhas e seleção (mesmo visual das outras abas). EN: Filterable row list. */
  function RenderRows(Options) {
    const { ListId, CountId, Items, Match, Fill, Selected, OnSelect } = Options;
    const Rows = $(ListId);
    Rows.innerHTML = '';
    const Shown = Items.filter(Match);
    $(CountId).textContent = Text('AssetCount', { Shown: NumberText(Shown.length), Total: NumberText(Items.length) });
    for (const Item of Shown.slice(0, 3000)) {
      const Row = Make('div', 'AssetRow');
      Row.setAttribute('role', 'option');
      Row.tabIndex = 0;
      Row.dataset.ref = Item.Ref;
      Row.setAttribute('aria-selected', String(Boolean(Selected && Selected.Ref === Item.Ref)));
      Fill(Row, Item);
      Row.addEventListener('click', () => OnSelect(Item));
      Row.addEventListener('keydown', Event => {
        if (Event.key === 'Enter') OnSelect(Item);
        else if (Event.key === 'ArrowDown' && Row.nextSibling) { Event.preventDefault(); Row.nextSibling.focus(); OnSelect(Shown[Shown.indexOf(Item) + 1]); }
        else if (Event.key === 'ArrowUp' && Row.previousSibling) { Event.preventDefault(); Row.previousSibling.focus(); OnSelect(Shown[Shown.indexOf(Item) - 1]); }
      });
      Rows.appendChild(Row);
    }
  }

  function MarkSelected(ListId, Ref) {
    for (const Row of document.querySelectorAll(`#${ListId} .AssetRow`)) Row.setAttribute('aria-selected', String(Row.dataset.ref === Ref));
  }

  function DownloadLink(Href, Label, Name) {
    const Link = Make('a', 'ToolButton DownloadLink', Label);
    Link.href = Href;
    Link.download = Name;
    return Link;
  }

  function SizeCanvas(Canvas) {
    const Ratio = window.devicePixelRatio || 1;
    const Width = Math.max(1, Math.round(Canvas.clientWidth * Ratio)), Height = Math.max(1, Math.round(Canvas.clientHeight * Ratio));
    if (Canvas.width !== Width || Canvas.height !== Height) { Canvas.width = Width; Canvas.height = Height; }
    return Ratio;
  }

  // ================================================================== Áudio / Audio
  const AudioTab = {
    List: [], Selected: null, Info: null, Buffer: null, Peaks: null, Source: null, Gain: null, StartedAt: 0, Offset: 0, Playing: false, Request: 0,

    Open() { if (!this.Opening) this.Opening = this.OpenOnce(); return this.Opening; },

    async OpenOnce() {
      const Packages = await LoadPackages();
      if (!Packages.some(Package => Package.Sounds > 0)) { $('AudioCount').textContent = Text('MediaNone'); return; }
      FillPackageSelect($('AudioPackage'), 'Sounds', 'Dialog');
      $('AudioPackage').addEventListener('change', () => { Remember('PackageSounds', $('AudioPackage').value); this.LoadPackage(); });
      $('AudioFilter').addEventListener('input', () => this.RenderList());
      $('AudioSpokenOnly').addEventListener('change', () => this.RenderList());
      $('AudioPlay').addEventListener('click', () => (this.Playing ? this.Pause() : this.Play()));
      $('AudioStop').addEventListener('click', () => { this.Pause(); this.Offset = 0; this.Draw(); });
      $('AudioLoop').addEventListener('change', () => { if (this.Source) this.Source.loop = $('AudioLoop').checked; });
      $('AudioLips').addEventListener('change', () => this.Draw());
      $('AudioVolume').addEventListener('input', () => { if (this.Gain) this.Gain.gain.value = Number($('AudioVolume').value); Remember('AudioVolume', $('AudioVolume').value); });
      const Saved = Remember('AudioVolume');
      if (Saved !== null) $('AudioVolume').value = Saved;
      $('AudioWave').addEventListener('click', Event => {
        if (!this.Buffer) return;
        const Box = $('AudioWave').getBoundingClientRect();
        this.Seek(Math.max(0, Math.min(1, (Event.clientX - Box.left) / Box.width)) * this.Buffer.duration);
      });
      new ResizeObserver(() => { this.Peaks = null; this.Draw(); }).observe($('AudioWave'));
      await this.LoadPackage();
    },

    async LoadPackage() {
      $('AudioCount').textContent = Text('AssetLoading');
      this.List = await Ui().FetchJson('/api/Sounds/' + $('AudioPackage').value);
      if (this.List.Error) this.List = [];
      this.RenderList();
    },

    RenderList() {
      const Query = $('AudioFilter').value.trim().toLowerCase(), Spoken = $('AudioSpokenOnly').checked;
      RenderRows({
        ListId: 'AudioList', CountId: 'AudioCount', Items: this.List, Selected: this.Selected,
        Match: Item => (!Spoken || Item.Text) && (!Query || `${Item.Ref} ${Item.Text || ''}`.toLowerCase().includes(Query)),
        Fill: (Row, Item) => Row.append(Make('span', 'Ref', Item.Ref), Make('span', 'Name', Item.Text || `${Item.Channels === 2 ? 'stereo' : 'mono'} · ${Item.Bits}-bit${Item.Loop ? ' · loop' : ''}`),
          Make('span', 'Meta', NumberText(Item.Duration, 2) + ' s'), Make('span', 'Sub', `${NumberText(Item.Rate)} Hz${Item.LipSync ? ' · lip-sync' : ''}`)),
        OnSelect: Item => this.Select(Item),
      });
    },

    async Select(Item) {
      if (!Item) return;
      this.Selected = Item;
      MarkSelected('AudioList', Item.Ref);
      this.Pause();
      const Request = ++this.Request;
      const [Info, Bytes] = await Promise.all([Ui().FetchJson(RefUrl('SoundInfo', Item.Ref)), Ui().FetchBuffer(RefUrl('Sound', Item.Ref)).catch(() => null)]);
      if (Request !== this.Request) return;
      this.Info = Info.Error ? null : Info;
      this.Buffer = null;
      this.Peaks = null;
      this.Offset = 0;
      $('AudioEmpty').hidden = true;
      if (Bytes) {
        try { this.Buffer = await AudioContextOnce().decodeAudioData(Bytes); } catch (Error) { this.Buffer = null; }
      }
      if (Request !== this.Request) return;
      if (!this.Buffer) { $('AudioEmpty').hidden = false; $('AudioEmpty').textContent = Text('AudioDecodeError'); }
      $('AudioLoop').checked = Boolean(this.Info && this.Info.Loop);
      this.RenderInfo();
      this.Draw();
      if (this.Info) Ui().SetStatus(Text('AudioStatus', { Ref: Item.Ref, Duration: NumberText(this.Info.Duration, 2), Rate: NumberText(this.Info.Rate) }));
    },

    Time() {
      if (!this.Buffer) return 0;
      if (!this.Playing) return this.Offset;
      const Elapsed = AudioContextOnce().currentTime - this.StartedAt + this.Offset;
      return $('AudioLoop').checked ? Elapsed % this.Buffer.duration : Math.min(Elapsed, this.Buffer.duration);
    },

    Play() {
      if (!this.Buffer) return;
      const Audio = AudioContextOnce();
      if (Audio.state === 'suspended') Audio.resume();
      if (this.Offset >= this.Buffer.duration - 0.01) this.Offset = 0;
      this.Gain = Audio.createGain();
      this.Gain.gain.value = Number($('AudioVolume').value);
      this.Gain.connect(Audio.destination);
      const Source = Audio.createBufferSource();
      Source.buffer = this.Buffer;
      Source.loop = $('AudioLoop').checked;
      Source.connect(this.Gain);
      Source.onended = () => { if (this.Source === Source) { this.Playing = false; this.Source = null; this.Offset = this.Buffer.duration; this.SyncButton(); this.Draw(); } };
      Source.start(0, this.Offset);
      this.Source = Source;
      this.StartedAt = Audio.currentTime;
      this.Playing = true;
      this.SyncButton();
      const Tick = () => { if (!this.Playing) return; this.Draw(); requestAnimationFrame(Tick); };
      requestAnimationFrame(Tick);
    },

    Pause() {
      if (this.Playing) this.Offset = this.Time();
      this.Playing = false;
      if (this.Source) { const Source = this.Source; this.Source = null; try { Source.stop(); } catch (Error) { /* já parou / already stopped */ } }
      this.SyncButton();
    },

    Seek(Time) {
      const WasPlaying = this.Playing;
      this.Pause();
      this.Offset = Time;
      if (WasPlaying) this.Play(); else this.Draw();
    },

    SyncButton() { $('AudioPlay').textContent = Text(this.Playing ? 'AnimPause' : 'AnimPlay'); },

    Draw() {
      const Canvas = $('AudioWave');
      if (!Canvas.clientWidth) return;
      const Ratio = SizeCanvas(Canvas), Width = Canvas.width, Height = Canvas.height;
      const Paint = Canvas.getContext('2d');
      Paint.clearRect(0, 0, Width, Height);
      $('AudioTime').textContent = `${NumberText(this.Time(), 2)} / ${NumberText(this.Buffer ? this.Buffer.duration : 0, 2)} s`;
      if (!this.Buffer) return;
      const Channels = this.Buffer.numberOfChannels, Lane = Height / Channels;
      if (!this.Peaks || this.Peaks.Width !== Width) {
        this.Peaks = { Width, Lanes: [] };
        for (let Channel = 0; Channel < Channels; Channel++) {
          const Data = this.Buffer.getChannelData(Channel), Step = Data.length / Width, Peaks = new Float32Array(Width * 2);
          for (let X = 0; X < Width; X++) {
            let Low = 0, High = 0;
            const Start = Math.floor(X * Step), End = Math.max(Start + 1, Math.floor((X + 1) * Step));
            for (let Sample = Start; Sample < End && Sample < Data.length; Sample++) { const Value = Data[Sample]; if (Value < Low) Low = Value; if (Value > High) High = Value; }
            Peaks[X * 2] = Low; Peaks[X * 2 + 1] = High;
          }
          this.Peaks.Lanes.push(Peaks);
        }
      }
      const Played = this.Time() / this.Buffer.duration * Width;
      for (let Channel = 0; Channel < Channels; Channel++) {
        const Peaks = this.Peaks.Lanes[Channel], Middle = Lane * Channel + Lane / 2, Scale = Lane * 0.45;
        Paint.fillStyle = '#ffffff10';
        Paint.fillRect(0, Middle, Width, Ratio);
        for (let X = 0; X < Width; X++) {
          Paint.fillStyle = X < Played ? '#e0a33c' : '#7d8077';
          const Top = Middle - Peaks[X * 2 + 1] * Scale, Bottom = Middle - Peaks[X * 2] * Scale;
          Paint.fillRect(X, Top, 1, Math.max(Ratio, Bottom - Top));
        }
      }
      const Lips = this.Info && this.Info.LipSync;
      if (Lips && Lips.Values.length && $('AudioLips').checked) {
        const Max = Math.max(1, ...Lips.Values.map(Math.abs)), Seconds = this.Buffer.duration;
        Paint.strokeStyle = '#7fb2e5';
        Paint.lineWidth = 1.5 * Ratio;
        Paint.beginPath();
        Lips.Values.forEach((Value, Number) => {
          const X = (Number / Lips.PerSecond) / Seconds * Width, Y = Height - 6 * Ratio - Math.abs(Value) / Max * (Height * 0.35);
          if (Number) Paint.lineTo(X, Y); else Paint.moveTo(X, Y);
        });
        Paint.stroke();
      }
      Paint.fillStyle = '#e4e2dc';
      Paint.fillRect(Math.min(Width - Ratio, Played), 0, Ratio, Height);
    },

    RenderInfo() {
      const Panel = $('AudioInfo');
      Panel.innerHTML = '';
      const Info = this.Info;
      if (!Info) return;
      Panel.appendChild(Make('h3', null, Info.Ref));
      if (Info.Text) Panel.appendChild(Make('p', 'Spoken', Info.Text));
      Panel.appendChild(InfoGrid([
        [Text('AudioDuration'), NumberText(Info.Duration, 3) + ' s'],
        [Text('AudioCategory'), Info.Category],
        [Text('AudioPitch'), Info.PitchVariation ? '±' + NumberText(Info.PitchVariation, 1) + ' %' : null],
        [Text('AudioRate'), NumberText(Info.Rate) + ' Hz'],
        [Text('AudioChannels'), Info.Channels],
        [Text('AudioBits'), Info.Bits],
        [Text('AudioGameVolume'), NumberText(Info.Volume / 100, 0) + ' %'],
        [Text('AudioLoop'), Text(Info.Loop ? 'Yes' : 'No')],
        [Text('AudioFlags'), Info.Flags],
        [Text('AudioPriority'), Info.Priority],
        [Text('AudioMinDistance'), NumberText(Info.MinDistance, 2)],
        [Text('AudioMaxDistance'), NumberText(Info.MaxDistance, 2)],
        [Text('AudioLipSync'), Info.LipSync ? Text('AudioLipValues', { Count: Info.LipSync.Values.length, Rate: NumberText(Info.LipSync.PerSecond, 1) }) : null],
        ['Bytes', NumberText(Info.Bytes)],
      ]));
      Panel.appendChild(DownloadLink(RefUrl('Sound', Info.Ref), Text('AudioSaveWav'), Info.Ref + '.wav'));
    },

    Relabel() { this.SyncButton(); if (this.Info) this.RenderInfo(); if (this.Opening) this.RenderList(); },
    Show(Active) { if (Active) this.Open(); else this.Pause(); },
  };

  // ================================================================== STOMP
  // PT: A aba STOMP agora é um visor da cena: escolhe-se a fase (o cenário), a lista mostra as sequências dos .qdu
  //     da pasta dessa fase que usam objetos dela, e a sequência toca no próprio visor 3D da fase (que é levado para
  //     dentro da aba enquanto ela está aberta), com as trilhas e chaves embaixo.
  // PT: Edição (RiotStompEdit.js): arrastar chaves, criar/apagar/duplicar, editar valores, chave de pose, desfazer, gravar
  //     só a sequência no .qdu (o servidor refaz a partir do original). Cada mudança é decodificada pelo servidor e o
  //     tocador troca a sequência sem recomeçar.
  // EN: The STOMP tab is now a scene viewer: pick the level (the set), the list shows the sequences of that level's
  //     folder that use its objects, and the sequence plays in the level's own 3D viewport (moved into the tab while
  //     it is open), with tracks and keys below.
  const StompTab = {
    List: [], Selected: null, Sequence: null, Request: 0, Event: null, Track: null, LevelKey: null, Edit: null, PreviewRequest: 0,

    Stage() { return Ui().Stage(); },
    get Player() { return this.Stage().LevelView.Stomp; },

    Open() { if (!this.Opening) this.Opening = this.OpenOnce(); return this.Opening; },

    async OpenOnce() {
      const Select = $('StompLevel');
      for (const Level of Ui().Levels()) {
        const Option = document.createElement('option');
        Option.value = Level.Key;
        Option.textContent = Level.File === Level.Name ? Level.File : `${Level.File} — ${Level.Name}`;
        Select.appendChild(Option);
      }
      Select.addEventListener('change', () => this.LoadLevel(Select.value));
      $('StompFilter').addEventListener('input', () => this.RenderList());
      $('StompPlay').addEventListener('click', () => { if (this.Player.Active) this.Player.SetPlaying(!this.Player.Playing); });
      $('StompTime').addEventListener('input', () => { if (!this.Player.Active) return; this.Player.SetPlaying(false); this.Player.SetTime(Number($('StompTime').value)); });
      $('StompSound').addEventListener('change', () => { this.Player.Sound = $('StompSound').checked; $('StompBarSound').checked = this.Player.Sound; });
      $('StompCamera').addEventListener('change', () => { this.Player.SceneCamera = $('StompCamera').checked; $('StompBarCamera').checked = this.Player.SceneCamera; });
      $('StompExit').addEventListener('click', () => this.Exit());
      $('StompExport').addEventListener('click', () => this.Export());
      $('StompImport').addEventListener('click', () => $('StompFile').click());
      $('StompFile').addEventListener('change', () => this.Import($('StompFile').files[0]));
      $('StompAddKey').addEventListener('click', () => this.AddKey());
      $('StompKeyPose').addEventListener('click', () => this.KeyPose());
      $('StompDuplicate').addEventListener('click', () => this.DuplicateKey());
      $('StompDelete').addEventListener('click', () => this.DeleteKey());
      $('StompUndo').addEventListener('click', () => this.History(false));
      $('StompRedo').addEventListener('click', () => this.History(true));
      $('StompDiscard').addEventListener('click', () => this.Discard());
      $('StompSave').addEventListener('click', () => this.Save());
      this.FillTypes();
      document.addEventListener('keydown', Event => this.Shortcut(Event));
      window.addEventListener('beforeunload', Event => { if (this.Edit && this.Edit.Dirty) { Event.preventDefault(); Event.returnValue = ''; } });
      const Current = this.Stage().LevelView.Scene;
      Select.value = Current ? Current.Key : (Remember('StompLevel') || Select.value);
      await this.LoadLevel(Select.value);
    },

    FillTypes() {
      const Select = $('StompAddType'), Keep = Select.value;
      Select.innerHTML = '';
      for (const Type of [0, 1, 3, 4, 5, 6, 7, 9, 10]) Select.add(new Option(`${Type} · ${Text('StompEventType' + Type)}`, String(Type)));
      Select.value = Keep || '0';
    },

    /** PT: Pergunta antes de jogar fora edições não gravadas. EN: Asks before throwing away unsaved edits. */
    MayLeave() { return !(this.Edit && this.Edit.Dirty) || window.confirm(Text('StompDiscardAsk')); },

    /** PT: Carrega a fase (cenário) e as sequências dela. EN: Loads the level (set) and its sequences. */
    async LoadLevel(Key) {
      if (!Key) return;
      if (Key !== this.LevelKey && !this.MayLeave()) { $('StompLevel').value = this.LevelKey; return; }
      Remember('StompLevel', Key);
      $('StompLevel').value = Key;
      this.LevelKey = Key;
      $('StompCount').textContent = Text('AssetLoading');
      const View = this.Stage().LevelView;
      if (!View.Scene || View.Scene.Key !== Key) { this.Exit(true); await Ui().LoadLevel(Key); }
      const Level = Ui().LevelByKey(Key);
      $('StompLevelName').textContent = Level ? Level.Name : Key;
      this.List = await Ui().FetchJson('/api/LevelSequences/' + encodeURIComponent(Key));
      if (this.List.Error) this.List = [];
      this.RenderList();
    },

    RenderList() {
      const Query = $('StompFilter').value.trim().toLowerCase();
      RenderRows({
        ListId: 'StompList', CountId: 'StompCount', Items: this.List, Selected: this.Selected,
        Match: Item => !Query || `${Item.Ref} ${Item.Names.join(' ')}`.toLowerCase().includes(Query),
        Fill: (Row, Item) => Row.append(Make('span', 'Ref', Item.Ref), Make('span', 'Name', Item.Names.filter(Boolean).join(', ') || '—'),
          Make('span', 'Meta', NumberText(Item.Duration, 2) + ' s'), Make('span', 'Sub', Text('StompRowSub', { Tracks: Item.Tracks, Duration: NumberText(Item.Duration, 1) }))),
        OnSelect: Item => this.Select(Item),
      });
    },

    /** PT: Abre uma sequência pela referência (usado por "Tocar na fase"). EN: Opens a sequence by reference. */
    async OpenSequence(LevelKey, Ref) {
      await this.Open();
      if (LevelKey && LevelKey !== this.LevelKey) await this.LoadLevel(LevelKey);
      const Item = this.List.find(Entry => Entry.Ref === Ref);
      if (Item) await this.Select(Item);
    },

    async Select(Item) {
      if (!Item) return;
      if (this.Selected && Item.Ref !== this.Selected.Ref && !this.MayLeave()) { MarkSelected('StompList', this.Selected.Ref); return; }
      this.Selected = Item;
      MarkSelected('StompList', Item.Ref);
      const Request = ++this.Request;
      const [Sequence, Raw] = await Promise.all([Ui().FetchJson(RefUrl('Sequence', Item.Ref)), Ui().FetchJson(RefUrl('SequenceRaw', Item.Ref))]);
      if (Request !== this.Request || Sequence.Error) return;
      if (Sequence.LevelKey && Sequence.LevelKey !== this.LevelKey) await this.LoadLevel(Sequence.LevelKey);
      this.Sequence = Sequence;
      this.SetEdit(Raw.Error ? null : Raw);
      this.Event = null;
      this.Track = null;
      $('StompEmpty').hidden = true;
      $('StompExport').disabled = false;
      $('StompImport').disabled = !this.Edit;
      this.ShowSequence();
      const Player = this.Player;
      if (!Player.Start(Sequence)) return;
      Player.SceneCamera = $('StompCamera').checked;
      Player.Sound = $('StompSound').checked;
      const Missing = Player.Tracks.filter(Track => Track.Number < 0 && !Track.IsCamera).length;
      const Note = [Player.CameraTrack ? '' : Text('StompNoCamera'), Missing ? Text('StompMissing', { Count: Missing }) : ''].filter(Boolean).join(' · ');
      this.SetNote(Text('StompLoadingRigs'));
      $('StompPlay').disabled = true;
      try { await Player.Loading; } catch (Error) { /* PT: segue sem os personagens / EN: carry on without them */ }
      if (Player.Sequence !== Sequence) return;
      $('StompPlay').disabled = false;
      this.SetNote(Note);
      Player.SetTime(0);
      this.Sync();
      Ui().SetStatus(Text('StompStatus', { Ref: Sequence.Ref, Tracks: Sequence.Tracks.length, Duration: NumberText(Sequence.Duration, 2) }));
    },

    SetEdit(Raw) {
      this.Edit = Raw ? new RiotStompEdit(Raw) : null;
      if (this.Edit) this.Edit.OnChange = () => this.Changed();
      $('StompEditBar').hidden = !this.Edit;
      this.SyncEditBar();
    },

    /** PT: Atualiza título, folha e painel com this.Sequence. EN: Refreshes title, sheet and panel from this.Sequence. */
    ShowSequence() {
      const Sequence = this.Sequence;
      $('StompSeqName').textContent = `${Sequence.Ref} · ${Sequence.Tracks.map(Track => Track.Name).filter(Boolean).slice(0, 4).join(', ')}`;
      $('StompTime').max = String(Math.max(Sequence.Duration, 0.001));
      this.RenderSheet();
      this.RenderInfo();
      this.Highlight();
      this.Sync();
    },

    SetNote(Note) { $('StompPreviewNote').textContent = Note || ''; $('StompPreviewNote').hidden = !Note; },

    Exit(Force) {
      if (!Force && !this.MayLeave()) return;
      const Player = this.Player;
      if (Player.Active) Player.Stop();
      this.Sequence = null;
      this.Selected = null;
      this.SetEdit(null);
      MarkSelected('StompList', null);
      $('StompSheet').innerHTML = '';
      $('StompInfo').innerHTML = '';
      $('StompSeqName').textContent = '';
      $('StompEmpty').hidden = false;
      $('StompExport').disabled = true;
      $('StompImport').disabled = true;
      this.SetNote('');
      this.Sync();
    },

    // ------------------------------------------------------------------ edição / editing
    /**
     * PT: Depois de cada mudança: o servidor decodifica a versão editada (mesmo código da leitura) e o tocador troca a
     *     sequência sem recomeçar. Pedidos antigos que chegam atrasados são ignorados.
     * EN: After each change the server decodes the edited version and the player swaps it in without restarting.
     */
    async Changed() {
      this.SyncEditBar();
      if (!this.Edit || !this.Sequence) return;
      const Request = ++this.PreviewRequest, Ref = this.Sequence.Ref;
      let Decoded;
      try {
        const Response = await fetch(RefUrl('PreviewSequence', Ref), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.Edit.Raw) });
        Decoded = await Response.json();
      } catch (Error) { Decoded = { Error: String(Error) }; }
      if (Request !== this.PreviewRequest || !this.Sequence || this.Sequence.Ref !== Ref) return;
      if (Decoded.Error) { Ui().SetStatus(Text('StompEditError', { Error: Decoded.Error })); return; }
      this.Sequence = Decoded;
      if (this.Event && !(Decoded.Tracks[this.Event[0]] && Decoded.Tracks[this.Event[0]].Events[this.Event[1]])) this.Event = null;
      this.ShowSequence();
      if (this.Player.Active) { this.Player.Replace(Decoded); this.Sync(); }
    },

    SyncEditBar() {
      const Edit = this.Edit, Dirty = Boolean(Edit && Edit.Dirty);
      $('StompUndo').disabled = !(Edit && Edit.UndoStack.length);
      $('StompRedo').disabled = !(Edit && Edit.RedoStack.length);
      $('StompSave').disabled = !Dirty;
      $('StompDiscard').disabled = !Dirty;
      $('StompDuplicate').disabled = $('StompDelete').disabled = !this.Event;
      $('StompAddKey').disabled = $('StompKeyPose').disabled = this.Track === null;
      $('StompDirty').textContent = Dirty ? Text('StompChanged', { Count: Edit.ChangedCount() }) : '';
    },

    PlayheadTime() { return this.Player.Active ? this.Player.Time : 0; },

    SelectEvent(TrackIndex, EventIndex) {
      this.Event = EventIndex === null || EventIndex < 0 ? null : [TrackIndex, EventIndex];
      this.Track = TrackIndex;
      this.Highlight(); this.RenderEvent(); this.SyncEditBar();
    },

    RequireTrack() {
      if (this.Track === null || !this.Edit) { Ui().SetStatus(Text('StompPickTrack')); return false; }
      return true;
    },

    AddKey() {
      if (!this.RequireTrack()) return;
      const Type = Number($('StompAddType').value), Track = this.Track;
      const Event = this.Edit.Add(Track, Type, this.PlayheadTime());
      this.SelectEvent(Track, this.Edit.Raw.Tracks[Track].Events.indexOf(Event));
    },

    /**
     * PT: Chave de pose no tempo atual: na trilha da câmera, a câmera do visor (desmarque "Câmera da cena" para voar e
     *     enquadrar); nas outras, a pose que o objeto tem agora (interpolada, ou a da colocação na fase).
     * EN: Pose key at the playhead: the view camera for the camera track, else the object's current pose.
     */
    KeyPose() {
      if (!this.RequireTrack()) return;
      const Player = this.Player, Item = Player.Active ? Player.Tracks[this.Track] : null, Time = this.PlayheadTime();
      if (!Item) return;
      let Position, Quat, Scale = null;
      if (Item.IsCamera) {
        const Camera = this.Stage().Viewport.Camera;
        Position = Camera.position.toArray();
        Quat = Camera.quaternion.toArray();
      } else {
        const Pose = Player.Pose(Item.Keys, Time);
        if (Pose) ({ Position, Quat, Scale } = Pose);
        else if (Item.Number >= 0) {
          const View = this.Stage().LevelView, Matrix = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
          View.InstanceMatrix(View.Scene.Instances[Item.Number], Matrix);
          Matrix.decompose(P, Q, S);
          Position = P.toArray(); Quat = Q.toArray(); Scale = S.toArray();
        } else { Ui().SetStatus(Text('StompNoPose')); return; }
      }
      const Index = this.Edit.KeyPose(this.Track, Time, Position, Quat, Scale);
      this.SelectEvent(this.Track, Index);
    },

    DuplicateKey() {
      if (!this.Event || !this.Edit) return;
      const [Track, Index] = this.Event, Source = this.Edit.Raw.Tracks[Track].Events[Index];
      let Time = this.PlayheadTime();
      if (Math.abs(Time - Source.Time) < 1e-4) Time = Source.Time + 0.5;
      const Event = this.Edit.Duplicate(Track, Index, Time);
      this.SelectEvent(Track, this.Edit.Raw.Tracks[Track].Events.indexOf(Event));
    },

    DeleteKey() {
      if (!this.Event || !this.Edit) return;
      const [Track, Index] = this.Event;
      this.Event = null;
      this.Edit.Remove(Track, Index);
      this.SelectEvent(Track, null);
    },

    /** PT: Desfaz/refaz (a seleção some: o índice pode ser de outro evento). EN: Undo/redo (clears the selection). */
    History(Forward) {
      if (!this.Edit) return;
      this.Event = null;
      if (!(Forward ? this.Edit.Redo() : this.Edit.Undo())) this.SyncEditBar();
    },

    Discard() {
      if (!this.Edit || !this.Edit.Dirty) return;
      const Saved = this.Edit.Saved;
      this.Event = null;
      this.Edit.Do(() => this.Edit.Restore(Saved));
    },

    async Save() {
      if (!this.Edit || !this.Edit.Dirty || !this.Sequence) return;
      const Ref = this.Sequence.Ref;
      let Result;
      try {
        const Response = await fetch(RefUrl('SaveSequence', Ref), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.Edit.Raw) });
        Result = await Response.json();
      } catch (Error) { Result = { Error: String(Error) }; }
      if (Result.Error) { Ui().SetStatus(Text('SaveFailed', { Error: Result.Error })); return; }
      // PT: relê do servidor: os floats ficam exatamente como foram gravados (f32) / EN: reload: floats as stored (f32)
      const Raw = await Ui().FetchJson(RefUrl('SequenceRaw', Ref));
      if (!Raw.Error && this.Sequence && this.Sequence.Ref === Ref) {
        const Undo = this.Edit.UndoStack, Redo = this.Edit.RedoStack;
        this.SetEdit(Raw);
        this.Edit.UndoStack = Undo; this.Edit.RedoStack = Redo;
        this.SyncEditBar();
      }
      this.List = await Ui().FetchJson('/api/LevelSequences/' + encodeURIComponent(this.LevelKey));
      if (this.List.Error) this.List = [];
      this.RenderList();
      MarkSelected('StompList', Ref);
      Ui().SetStatus(Result.Saved ? Text('StompSaved', { Ref, Backup: Result.Backup || '—' }) : Text('StompNothing'));
    },

    async RestoreOriginal() {
      if (!this.Sequence || !window.confirm(Text('StompRestoreAsk'))) return;
      const Ref = this.Sequence.Ref;
      const Response = await fetch(RefUrl('RestoreSequence', Ref), { method: 'POST' });
      const Result = await Response.json();
      if (Result.Error) { Ui().SetStatus(Text('SaveFailed', { Error: Result.Error })); return; }
      const Item = this.Selected;
      this.SetEdit(null);
      this.Selected = null;
      await this.Select(Item);
      Ui().SetStatus(Result.Saved ? Text('StompRestored', { Ref }) : Text('StompNothing'));
    },

    /** PT: Atalhos da aba (fora de campos de texto). EN: Tab shortcuts (outside text fields). */
    Shortcut(Event) {
      if ($('STOMPPane').hidden || !this.Edit) return;
      const Target = Event.target, Typing = Target && (/^(INPUT|SELECT|TEXTAREA)$/.test(Target.tagName) || Target.isContentEditable);
      const Ctrl = Event.ctrlKey || Event.metaKey, Key = Event.key.toLowerCase();
      if (Ctrl && Key === 's') { Event.preventDefault(); this.Save(); return; }
      if (Typing) return;
      if (Ctrl && Key === 'z' && !Event.shiftKey) { Event.preventDefault(); this.History(false); }
      else if (Ctrl && (Key === 'y' || (Key === 'z' && Event.shiftKey))) { Event.preventDefault(); this.History(true); }
      else if (Ctrl && Key === 'd') { Event.preventDefault(); this.DuplicateKey(); }
      else if (!Ctrl && (Event.key === 'Delete' || Event.key === 'Backspace')) { Event.preventDefault(); this.DeleteKey(); }
      else if (!Ctrl && !Event.altKey && Key === 'k') { Event.preventDefault(); this.KeyPose(); }
    },

    // ------------------------------------------------------------------ exportar / importar
    /** PT: Baixa a sequência na forma editável (JSON que a aba importa de volta). EN: Downloads the editable form. */
    Export() {
      if (!this.Sequence) return;
      const Data = this.Edit ? { Format: 'SurrealEd STOMP 1', ...this.Edit.Raw } : this.Sequence;
      const Blob_ = new Blob([JSON.stringify(Data, null, 1)], { type: 'application/json' });
      const Link = document.createElement('a');
      Link.href = URL.createObjectURL(Blob_);
      Link.download = this.Sequence.Ref + '.json';
      document.body.appendChild(Link);
      Link.click();
      setTimeout(() => { URL.revokeObjectURL(Link.href); Link.remove(); }, 1000);
    },

    async Import(File) {
      $('StompFile').value = '';
      if (!File || !this.Edit) return;
      let Data;
      try { Data = JSON.parse(await File.text()); } catch (Error) { Data = null; }
      if (!Data || Data.Format !== 'SurrealEd STOMP 1' || !Array.isArray(Data.Tracks)) { Ui().SetStatus(Text('StompImportBad')); return; }
      if (JSON.stringify(Data.Formats) !== JSON.stringify(this.Edit.Raw.Formats)) { Ui().SetStatus(Text('StompImportGame')); return; }
      const Same = Data.Tracks.length === this.Edit.Raw.Tracks.length && Data.Tracks.every((Track, Index) => Track.Object === this.Edit.Raw.Tracks[Index].Object);
      if ((Data.Ref !== this.Sequence.Ref || !Same) && !window.confirm(Text('StompImportOther', { Ref: Data.Ref || '?' }))) return;
      this.Event = null;
      this.Edit.Do(() => { this.Edit.Raw.Flags = Data.Flags; this.Edit.Raw.Radius = Data.Radius; this.Edit.Raw.Tracks = Data.Tracks; });
      Ui().SetStatus(Text('StompImported'));
    },

    /** PT: Chamado a cada mudança do tocador (inclusive a cada quadro tocando). EN: Called on every player change. */
    Sync() {
      const Player = this.Player, Active = Player.Active && this.Sequence && Player.Sequence && Player.Sequence.Ref === this.Sequence.Ref;
      const Duration = Math.max(this.Sequence ? this.Sequence.Duration : 0, 0.001), Time = Active ? Player.Time : 0;
      $('StompPlay').textContent = Text(Active && Player.Playing ? 'AnimPause' : 'AnimPlay');
      if (document.activeElement !== $('StompTime')) $('StompTime').value = String(Time);
      $('StompTimeLabel').textContent = `${NumberText(Time, 2)} / ${NumberText(this.Sequence ? Duration : 0, 2)} s`;
      for (const Head of document.querySelectorAll('#StompSheet .Playhead')) Head.style.left = `${(Time / Duration) * 100}%`;
    },

    Subtitle(Line) { $('StompTabSubtitle').hidden = !Line; $('StompTabSubtitle').textContent = Line || ''; },

    Seek(Time) {
      if (!this.Player.Active) return;
      this.Player.SetPlaying(false);
      this.Player.SetTime(Time);
    },

    /**
     * PT: Folha de chaves. Com a edição: arrastar um marcador muda o tempo (encaixa em 1/30 s; Alt = livre), clique
     *     duplo numa trilha cria uma chave do tipo escolhido ali, clique no nome escolhe a trilha.
     * EN: Dope sheet. Drag a marker to retime (snaps to 1/30 s, Alt = free), double-click a lane to add a key.
     */
    RenderSheet() {
      const Sheet = $('StompSheet'), Sequence = this.Sequence, Duration = Math.max(Sequence.Duration, 0.001);
      const Scroll = Sheet.scrollTop;
      Sheet.innerHTML = '';
      const Head = Make('div', 'DopeRow Head');
      const Ruler = Make('div', 'DopeRuler');
      const Step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find(Value => Duration / Value <= 12) || 120;
      for (let Time = 0; Time <= Duration + 1e-6; Time += Step) {
        const Mark = Make('span', null, NumberText(Time, Step < 1 ? 2 : 0) + 's');
        Mark.style.left = `calc(${(Time / Duration) * 100}% )`;
        if (Time === 0) Mark.style.transform = 'none';
        Ruler.appendChild(Mark);
      }
      Ruler.appendChild(Make('div', 'Playhead'));
      Head.append(Make('div', 'DopeName', Text('StompTrack')), Ruler);
      Head.querySelector('.DopeName').style.cursor = 'default';
      Sheet.appendChild(Head);
      const TimeAt = (Element, ClientX) => { const Box = Element.getBoundingClientRect(); return (ClientX - Box.left) / Box.width * Duration; };
      Ruler.addEventListener('click', Event => this.Seek(TimeAt(Ruler, Event.clientX)));
      Sequence.Tracks.forEach((Track, TrackNumber) => {
        const Row = Make('div', 'DopeRow');
        Row.dataset.track = TrackNumber;
        const Name = Make('div', 'DopeName', Track.Name || Track.Class || Text('StompNoObject'));
        Name.title = `${Track.Name || ''} ${Track.Class || ''} #${Track.Object}`;
        Name.appendChild(Make('small', null, `${Track.Class || '?'} · #${Track.Object}`));
        Name.addEventListener('click', () => { this.Track = this.Track === TrackNumber ? null : TrackNumber; if (this.Event && this.Event[0] !== TrackNumber) this.Event = null; this.Highlight(); this.RenderEvent(); this.SyncEditBar(); });
        const LaneElement = Make('div', 'DopeLane');
        Track.Events.forEach((Event, EventNumber) => {
          const Marker = Make('i');
          Marker.style.left = `${(Event.Time / Duration) * 100}%`;
          Marker.style.background = EventColors[Event.Type] || '#aaa';
          Marker.title = `${NumberText(Event.Time, 2)} s · ${Event.Name}${Event.Text ? ' · ' + Event.Text : Event.Animation ? ' · ' + Event.Animation : Event.Sound ? ' · ' + Event.Sound : ''}`;
          Marker.dataset.event = `${TrackNumber}:${EventNumber}`;
          Marker.addEventListener('pointerdown', Down => {
            if (Down.button !== 0) return;
            Down.stopPropagation();
            const StartX = Down.clientX;
            let Moved = false, NewTime = Event.Time;
            Marker.setPointerCapture(Down.pointerId);
            const OnMove = Move => {
              if (!this.Edit) return;
              if (!Moved && Math.abs(Move.clientX - StartX) < 4) return;
              Moved = true;
              const Raw = Math.max(0, Math.min(Duration * 1.25 + 1, TimeAt(LaneElement, Move.clientX)));
              NewTime = Move.altKey ? Raw : Math.round(Raw * 30) / 30;
              Marker.style.left = `${(NewTime / Duration) * 100}%`;
              Ui().SetStatus(`${Track.Name || '#' + Track.Object} · ${Event.Name} → ${NumberText(NewTime, 3)} s`);
            };
            const OnUp = () => {
              Marker.removeEventListener('pointermove', OnMove);
              Marker.removeEventListener('pointerup', OnUp);
              Marker.removeEventListener('pointercancel', OnUp);
              if (Moved && this.Edit && Math.abs(NewTime - Event.Time) > 1e-6) {
                const Index = this.Edit.Move(TrackNumber, EventNumber, NewTime);
                this.SelectEvent(TrackNumber, Index);
                this.Seek(NewTime);
              } else if (!Moved) {
                this.SelectEvent(TrackNumber, EventNumber);
                this.Seek(Event.Time);
                $('StompDetails').open = true;
              } else Marker.style.left = `${(Event.Time / Duration) * 100}%`;
            };
            Marker.addEventListener('pointermove', OnMove);
            Marker.addEventListener('pointerup', OnUp);
            Marker.addEventListener('pointercancel', OnUp);
          });
          Marker.addEventListener('click', Click => Click.stopPropagation());
          LaneElement.appendChild(Marker);
        });
        LaneElement.appendChild(Make('div', 'Playhead'));
        LaneElement.addEventListener('click', Event => { this.Seek(TimeAt(LaneElement, Event.clientX)); if (this.Track !== TrackNumber) { this.Track = TrackNumber; this.Highlight(); this.SyncEditBar(); } });
        LaneElement.addEventListener('dblclick', Event => {
          if (!this.Edit) return;
          const Time = Math.max(0, Math.round(TimeAt(LaneElement, Event.clientX) * 30) / 30);
          const Added = this.Edit.Add(TrackNumber, Number($('StompAddType').value), Time);
          this.SelectEvent(TrackNumber, this.Edit.Raw.Tracks[TrackNumber].Events.indexOf(Added));
          this.Seek(Time);
        });
        Row.append(Name, LaneElement);
        Sheet.appendChild(Row);
      });
      Sheet.scrollTop = Scroll;
    },

    Highlight() {
      for (const Row of document.querySelectorAll('#StompSheet .DopeRow[data-track]')) Row.classList.toggle('Selected', Number(Row.dataset.track) === this.Track);
      const Key = this.Event ? this.Event.join(':') : '';
      for (const Marker of document.querySelectorAll('#StompSheet .DopeLane i')) Marker.classList.toggle('Selected', Marker.dataset.event === Key);
    },

    RenderInfo() {
      const Panel = $('StompInfo'), Sequence = this.Sequence;
      Panel.innerHTML = '';
      if (!Sequence) return;
      Panel.appendChild(InfoGrid([
        [Text('StompLevel'), Sequence.Level || '—'],
        [Text('StompDuration'), NumberText(Sequence.Duration, 3) + ' s'],
        [Text('StompComplete'), Text(Sequence.Complete ? 'Yes' : 'No')],
      ]));
      if (this.Edit) {
        const Form = Make('div', 'StompForm');
        const Raw = this.Edit.Raw;
        const Flags = this.FieldInput('flags', Raw.Flags, Value => this.Edit.SetSequence(Value, Raw.Radius));
        Flags.title = Text('StompSeqFlagsTip');
        const Radius = this.FieldInput('float', Raw.Radius, Value => this.Edit.SetSequence(Raw.Flags, Value));
        Form.append(Make('span', null, Text('AudioFlags')), Flags, Make('span', null, Text('StompRadius')), Radius);
        Panel.appendChild(Form);
      } else Panel.appendChild(InfoGrid([[Text('StompRadius'), NumberText(Sequence.Radius, 2)], [Text('AudioFlags'), Sequence.Flags]]));
      const Legend = Make('div', 'EventLegend');
      const Types = [...new Set(Sequence.Tracks.flatMap(Track => Track.Events.map(Event => Event.Type)))].sort((A, B) => A - B);
      for (const Type of Types) {
        const Item = Make('span');
        const Swatch = Make('b');
        Swatch.style.background = EventColors[Type] || '#aaa';
        const Sample = Sequence.Tracks.flatMap(Track => Track.Events).find(Event => Event.Type === Type);
        Item.append(Swatch, document.createTextNode(`${Type} ${Sample ? Sample.Name : ''}`));
        Legend.appendChild(Item);
      }
      Panel.append(Make('h4', null, Text('StompLegend')), Legend);
      const EventBox = Make('div');
      EventBox.id = 'StompEvent';
      Panel.append(Make('h4', null, Text('StompEvent')), EventBox);
      if (this.Edit) {
        const Restore = Make('button', 'ToolButton', Text('StompRestore'));
        Restore.title = Text('StompRestoreTip');
        Restore.addEventListener('click', () => this.RestoreOriginal());
        Panel.appendChild(Restore);
      }
      this.RenderEvent();
    },

    /** PT: Campo de um valor cru (Commit recebe o valor cru novo). EN: Input for one raw value. */
    FieldInput(Kind, Raw, Commit, Options) {
      let Field;
      const Number_ = (Step, Value) => { Field = document.createElement('input'); Field.type = 'number'; Field.step = Step; Field.value = String(Value); };
      if (Kind === 'enum' || Kind === 'message') {
        Field = document.createElement('select');
        const Choices = Kind === 'message' ? Object.entries(Ui().MessageNames()).map(([Id, Name]) => [Number(Id), `${Id} · ${Name}`]) : Options.map(([Value, Key]) => [Value, `${Value} · ${Text(Key)}`]);
        if (!Choices.some(([Value]) => Value === Raw)) Choices.unshift([Raw, `${Raw} · ?`]);
        for (const [Value, Label] of Choices) Field.add(new Option(Label, String(Value)));
        Field.value = String(Raw);
        Field.addEventListener('change', () => Commit(Number(Field.value)));
      } else if (Kind === 'flags') {
        Field = document.createElement('input');
        Field.value = '0x' + (Raw >>> 0).toString(16).toUpperCase();
        Field.addEventListener('change', () => { const Value = Number(Field.value); if (Number.isInteger(Value) && Value >= 0 && Value <= 0xFFFFFFFF) Commit(Value); else Field.value = '0x' + (Raw >>> 0).toString(16).toUpperCase(); });
      } else if (Kind === 'ref') {
        Field = document.createElement('input');
        Field.value = RiotStompEdit.RefText(Raw);
        Field.placeholder = '0_0000';
        Field.addEventListener('change', () => { const Value = RiotStompEdit.ParseRef(Field.value); if (Value === null) Field.value = RiotStompEdit.RefText(Raw); else Commit(Value); });
      } else if (Kind === 'volume') {
        Number_('1', Math.round(Raw / 100));
        Field.addEventListener('change', () => { const Value = Math.round(Number(Field.value) * 100); if (Value >= 0 && Value <= 0xFFFF) Commit(Value); });
      } else if (Kind === 'float') {
        Number_('any', Math.round(Raw * 1e5) / 1e5);
        Field.addEventListener('change', () => { const Value = Number(Field.value); if (Field.value !== '' && Number.isFinite(Value)) Commit(Value); });
      } else {
        Number_('1', Raw);
        const Max = Kind === 'u16' ? 0xFFFF : 0xFFFFFFFF;
        Field.addEventListener('change', () => { const Value = Number(Field.value); if (Number.isInteger(Value) && Value >= 0 && Value <= Max) Commit(Value); else Field.value = String(Raw); });
      }
      Field.className = 'StompInput';
      return Field;
    },

    RenderEvent() {
      const Box = $('StompEvent');
      if (!Box) return;
      Box.innerHTML = '';
      if (!this.Event) { Box.appendChild(Make('p', 'Muted', Text(this.Edit ? 'StompPickEventEdit' : 'StompPickEvent'))); return; }
      const [TrackIndex, EventIndex] = this.Event;
      const Track = this.Sequence.Tracks[TrackIndex], Event = Track.Events[EventIndex];
      if (!Event) return;
      if (Event.Text) Box.appendChild(Make('p', 'Spoken', Event.Text));
      const RawEvent = this.Edit ? this.Edit.Raw.Tracks[TrackIndex].Events[EventIndex] : null;
      if (!RawEvent) { this.RenderEventReadOnly(Box, Track, Event); return; }
      const Edit = this.Edit, Raw = Edit.Raw, Values = RawEvent.Values, Format = Edit.Format(RawEvent.Type);
      const Set = Changes => { const Index = Edit.SetValues(TrackIndex, EventIndex, Changes); this.Event = [TrackIndex, Index]; };
      const Form = Make('div', 'StompForm');
      const Row = (Label, ...Fields) => { const Cell = Make('div', 'StompCells'); Cell.append(...Fields); Form.append(Make('span', null, Label), Cell); };
      Form.append(Make('span', null, Text('StompTrack')), Make('b', null, Track.Name || `#${Track.Object}`));
      Form.append(Make('span', null, Text('StompType')), Make('b', null, `${Event.Type} · ${Text('StompEventType' + Event.Type)}`));
      Row(Text('StompTime') + ' (s)', this.FieldInput('float', RawEvent.Time, Value => { const Index = Edit.Move(TrackIndex, EventIndex, Value); this.Event = [TrackIndex, Index]; this.Seek(Value); }));
      const Fields = RiotStompEdit.Fields(RawEvent.Type, Raw.IsTTB);
      for (const Field of Fields || []) {
        const Label = Text(Field.Key) + (Field.Kind === 'raw' ? ` p${Field.Index} (?)` : '');
        if (Field.Kind === 'position' || Field.Kind === 'scale') {
          const Divide = Field.Kind === 'position' ? Raw.Scale : 1;
          Row(Label, ...[0, 1, 2].map(Axis => this.FieldInput('float', Values[Field.Index + Axis] / Divide, Value => Set({ [Field.Index + Axis]: Value * Divide }))));
        } else if (Field.Kind === 'rotation') {
          const [X, Y, Z, W] = Values.slice(Field.Index, Field.Index + 4), Length = Math.hypot(X, Y, Z, W) || 1;
          const Euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(-X / Length, -Y / Length, -Z / Length, W / Length));
          const Degrees = [Euler.x, Euler.y, Euler.z].map(Value => Value * 180 / Math.PI);
          const Inputs = [0, 1, 2].map(Axis => this.FieldInput('float', Degrees[Axis], () => {
            const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...Inputs.map(Input => Number(Input.value) * Math.PI / 180)));
            Set({ [Field.Index]: -Q.x, [Field.Index + 1]: -Q.y, [Field.Index + 2]: -Q.z, [Field.Index + 3]: Q.w });
          }));
          Row(Label, ...Inputs);
        } else {
          const Code = Format[Field.Index];
          const Kind = Field.Kind === 'raw' ? (Code === 'f' ? 'float' : Code === 'H' ? 'u16' : 'int') : Field.Kind === 'int' && Code === 'H' ? 'u16' : Field.Kind;
          const Input = this.FieldInput(Kind, Values[Field.Index], Value => Set({ [Field.Index]: Value }), Field.Options);
          if (Field.Tip) Input.title = Text(Field.Tip);
          Row(Label, Input);
        }
      }
      Box.appendChild(Form);
      // PT: todos os valores crus (os tipos 2 e 8 da TTB só têm isto) / EN: all raw values (TTB types 2 and 8 only have this)
      const Details = Make('details', 'StompRaw');
      Details.open = !Fields;
      Details.appendChild(Make('summary', null, Text('StompRawValues', { Format })));
      const RawForm = Make('div', 'StompForm');
      [...Format].forEach((Code, Index) => {
        RawForm.append(Make('span', null, `[${Index}] ${Code}`), this.FieldInput(Code === 'f' ? 'float' : Code === 'H' ? 'u16' : 'int', Values[Index], Value => Set({ [Index]: Value })));
      });
      Details.appendChild(RawForm);
      Box.appendChild(Details);
      if (Event.Playable) {
        const Play = Make('button', 'ToolButton', Text('AnimPlay'));
        Play.addEventListener('click', () => { const Voice = new Audio(RefUrl('Sound', Event.Sound)); Voice.play().catch(() => {}); });
        Box.appendChild(Play);
      }
      if (Event.Animation) {
        const Open = Make('button', 'ToolButton', Text('TabAnimation') + ' →');
        Open.addEventListener('click', () => RiotAssetTabs.OpenAnimation(Event.Animation));
        Box.appendChild(Open);
      }
    },

    RenderEventReadOnly(Box, Track, Event) {
      const Fmt = List => List.map(Value => (typeof Value === 'number' && !Number.isInteger(Value) ? NumberText(Value, 3) : String(Value))).join(', ');
      Box.appendChild(InfoGrid([
        [Text('StompTrack'), Track.Name || `#${Track.Object}`],
        [Text('StompTime'), NumberText(Event.Time, 3) + ' s'],
        [Text('StompType'), `${Event.Type} · ${Event.Name}`],
        [Text('PropPosition'), Event.Position ? Fmt(Event.Position) : null],
        [Text('PropRotation'), Event.Rotation ? Fmt(Event.Rotation) : null],
        [Text('PropScale'), Event.Scale ? Fmt(Event.Scale) : null],
        [Text('StompValues'), Event.Values && Event.Values.length ? Fmt(Event.Values) : null],
      ]));
    },

    Relabel() { if (this.Opening) { this.RenderList(); this.FillTypes(); } this.Sync(); if (this.Sequence) this.ShowSequence(); this.SyncEditBar(); },

    /**
     * PT: Ao abrir a aba, o visor 3D da fase vem para dentro da prévia; ao sair, volta para a aba Fase.
     * EN: When the tab opens, the level's 3D viewport moves into the preview; it goes back when the tab closes.
     */
    Show(Active) {
      const Element = $('Viewport');
      if (Active) {
        $('StompPreview').prepend(Element);
        this.Open();
        this.Sync();
      } else if (Element.parentElement !== $('ViewportArea')) {
        $('ViewportArea').prepend(Element);
      }
      this.Stage().Viewport.Resize();
    },
  };

  // ================================================================== Vídeo / Video
  const VideoTab = {
    List: [], Selected: null, Ffmpeg: false, Request: 0,

    Open() { if (!this.Opening) this.Opening = this.OpenOnce(); return this.Opening; },

    async OpenOnce() {
      const Packages = await LoadPackages();
      if (!Packages.some(Package => Package.Videos > 0)) { $('VideoCount').textContent = Text('MediaNone'); return; }
      FillPackageSelect($('VideoPackage'), 'Videos', 'Interface');
      $('VideoPackage').addEventListener('change', () => { Remember('PackageVideos', $('VideoPackage').value); this.LoadPackage(); });
      const Player = $('VideoPlayer');
      Player.addEventListener('loadeddata', () => { $('VideoEmpty').hidden = true; });
      Player.addEventListener('error', () => { if (!Player.getAttribute('src')) return; Player.hidden = true; $('VideoEmpty').hidden = false; $('VideoEmpty').textContent = Text('VideoConvertError'); });
      await this.LoadPackage();
    },

    async LoadPackage() {
      $('VideoCount').textContent = Text('AssetLoading');
      const Result = await Ui().FetchJson('/api/Videos/' + $('VideoPackage').value);
      this.Ffmpeg = Boolean(Result.Ffmpeg);
      this.List = Result.Videos || [];
      this.RenderList();
    },

    RenderList() {
      RenderRows({
        ListId: 'VideoList', CountId: 'VideoCount', Items: this.List, Selected: this.Selected, Match: () => true,
        Fill: (Row, Item) => Row.append(Make('span', 'Ref', Item.Ref), Make('span', 'Name', `${Item.Width}×${Item.Height} · ${Item.Fps} fps`),
          Make('span', 'Meta', NumberText(Item.Duration, 1) + ' s'), Make('span', 'Sub', NumberText(Item.Bytes / 1048576, 1) + ' MB')),
        OnSelect: Item => this.Select(Item),
      });
    },

    Select(Item) {
      if (!Item) return;
      this.Selected = Item;
      MarkSelected('VideoList', Item.Ref);
      const Player = $('VideoPlayer'), Empty = $('VideoEmpty');
      Player.pause();
      if (this.Ffmpeg) {
        Player.hidden = false;
        Empty.hidden = false;
        Empty.textContent = Text('VideoConverting');
        Player.src = RefUrl('VideoMp4', Item.Ref);
        Player.load();
      } else {
        Player.removeAttribute('src');
        Player.hidden = true;
        Empty.hidden = false;
        Empty.textContent = Text('VideoNoFfmpeg');
      }
      this.RenderInfo();
      Ui().SetStatus(Text('VideoStatus', { Ref: Item.Ref, Width: Item.Width, Height: Item.Height, Duration: NumberText(Item.Duration, 1) }));
    },

    RenderInfo() {
      const Panel = $('VideoInfo'), Item = this.Selected;
      Panel.innerHTML = '';
      if (!Item) return;
      Panel.appendChild(Make('h3', null, Item.Ref));
      Panel.appendChild(InfoGrid([
        [Text('VideoSize'), `${Item.Width} × ${Item.Height}`],
        [Text('VideoFps'), Item.Fps],
        [Text('VideoDuration'), NumberText(Item.Duration, 2) + ' s'],
        [Text('VideoBytes'), NumberText(Item.Bytes)],
        ['Codec', 'WMV (ASF)'],
      ]));
      Panel.appendChild(DownloadLink(RefUrl('VideoWmv', Item.Ref), Text('VideoSaveWmv'), Item.Ref + '.wmv'));
      if (!this.Ffmpeg) Panel.appendChild(Make('p', 'Muted', Text('VideoNoFfmpeg')));
    },

    Relabel() { if (this.Opening) this.RenderList(); if (this.Selected) { this.RenderInfo(); if (!this.Ffmpeg) $('VideoEmpty').textContent = Text('VideoNoFfmpeg'); } },
    Show(Active) { if (Active) this.Open(); else $('VideoPlayer').pause(); },
  };

  RiotAssetTabs.Register('Audio', AudioTab);
  RiotAssetTabs.Register('STOMP', StompTab);
  RiotAssetTabs.Register('Video', VideoTab);
})();
