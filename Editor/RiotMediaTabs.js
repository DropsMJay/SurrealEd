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
  const StompTab = {
    List: [], Selected: null, Sequence: null, Time: 0, Playing: false, Request: 0, Event: null, Track: null, Last: 0, Voices: [],

    Open() { if (!this.Opening) this.Opening = this.OpenOnce(); return this.Opening; },

    async OpenOnce() {
      const Packages = await LoadPackages();
      if (!Packages.some(Package => Package.Sequences > 0)) { $('StompCount').textContent = Text('MediaNone'); return; }
      FillPackageSelect($('StompPackage'), 'Sequences', '');
      $('StompPackage').addEventListener('change', () => { Remember('PackageSequences', $('StompPackage').value); this.LoadPackage(); });
      $('StompFilter').addEventListener('input', () => this.RenderList());
      $('StompPlay').addEventListener('click', () => this.SetPlaying(!this.Playing));
      $('StompTime').addEventListener('input', () => { this.SetPlaying(false); this.Time = Number($('StompTime').value); this.Apply(); });
      new ResizeObserver(() => this.DrawMap()).observe($('StompMap'));
      await this.LoadPackage();
    },

    async LoadPackage() {
      $('StompCount').textContent = Text('AssetLoading');
      this.List = await Ui().FetchJson('/api/Sequences/' + $('StompPackage').value);
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

    async Select(Item) {
      if (!Item) return;
      this.Selected = Item;
      MarkSelected('StompList', Item.Ref);
      this.SetPlaying(false);
      const Request = ++this.Request;
      const Sequence = await Ui().FetchJson(RefUrl('Sequence', Item.Ref));
      if (Request !== this.Request || Sequence.Error) return;
      this.Sequence = Sequence;
      this.Event = null;
      this.Track = null;
      this.Time = 0;
      this.Last = 0;
      $('StompEmpty').hidden = true;
      $('StompTime').max = String(Math.max(Sequence.Duration, 0.001));
      this.Paths = Sequence.Tracks.map(Track => Track.Events.filter(Event => Event.Type === 0).sort((A, B) => A.Time - B.Time));
      this.RenderSheet();
      this.RenderInfo();
      this.Apply();
      Ui().SetStatus(Text('StompStatus', { Ref: Sequence.Ref, Tracks: Sequence.Tracks.length, Duration: NumberText(Sequence.Duration, 2) }));
    },

    RenderSheet() {
      const Sheet = $('StompSheet'), Sequence = this.Sequence, Duration = Math.max(Sequence.Duration, 0.001);
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
      Ruler.addEventListener('click', Event => { const Box = Ruler.getBoundingClientRect(); this.SetPlaying(false); this.Time = (Event.clientX - Box.left) / Box.width * Duration; this.Apply(); });
      Sequence.Tracks.forEach((Track, TrackNumber) => {
        const Row = Make('div', 'DopeRow');
        Row.dataset.track = TrackNumber;
        const Name = Make('div', 'DopeName', Track.Name || Track.Class || Text('StompNoObject'));
        Name.title = `${Track.Name || ''} ${Track.Class || ''} #${Track.Object}`;
        Name.appendChild(Make('small', null, `${Track.Class || '?'} · #${Track.Object}`));
        Name.addEventListener('click', () => { this.Track = this.Track === TrackNumber ? null : TrackNumber; this.Highlight(); this.DrawMap(); });
        const LaneElement = Make('div', 'DopeLane');
        Track.Events.forEach((Event, EventNumber) => {
          const Marker = Make('i');
          Marker.style.left = `${(Event.Time / Duration) * 100}%`;
          Marker.style.background = EventColors[Event.Type] || '#aaa';
          Marker.title = `${NumberText(Event.Time, 2)} s · ${Event.Name}${Event.Text ? ' · ' + Event.Text : Event.Animation ? ' · ' + Event.Animation : Event.Sound ? ' · ' + Event.Sound : ''}`;
          Marker.dataset.event = `${TrackNumber}:${EventNumber}`;
          Marker.addEventListener('click', Click => { Click.stopPropagation(); this.Event = [TrackNumber, EventNumber]; this.Track = TrackNumber; this.SetPlaying(false); this.Time = Event.Time; this.Highlight(); this.RenderEvent(); this.Apply(); });
          LaneElement.appendChild(Marker);
        });
        LaneElement.appendChild(Make('div', 'Playhead'));
        LaneElement.addEventListener('click', Event => { const Box = LaneElement.getBoundingClientRect(); this.SetPlaying(false); this.Time = (Event.clientX - Box.left) / Box.width * Duration; this.Apply(); });
        Row.append(Name, LaneElement);
        Sheet.appendChild(Row);
      });
    },

    Highlight() {
      for (const Row of document.querySelectorAll('#StompSheet .DopeRow[data-track]')) Row.classList.toggle('Selected', Number(Row.dataset.track) === this.Track);
      const Key = this.Event ? this.Event.join(':') : '';
      for (const Marker of document.querySelectorAll('#StompSheet .DopeLane i')) Marker.classList.toggle('Selected', Marker.dataset.event === Key);
    },

    SetPlaying(Playing) {
      if (Playing && !this.Sequence) return;
      if (Playing && this.Time >= this.Sequence.Duration - 1e-3) { this.Time = 0; }
      this.Playing = Playing;
      $('StompPlay').textContent = Text(Playing ? 'AnimPause' : 'AnimPlay');
      if (!Playing) { for (const Voice of this.Voices) Voice.pause(); this.Voices = []; return; }
      this.Last = this.Time;
      let Previous = performance.now();
      const Tick = Now => {
        if (!this.Playing) return;
        const Before = this.Time;
        this.Time = Math.min(this.Sequence.Duration, this.Time + (Now - Previous) / 1000);
        Previous = Now;
        this.FireSounds(Before, this.Time);
        this.Apply();
        if (this.Time >= this.Sequence.Duration) { this.Playing = false; $('StompPlay').textContent = Text('AnimPlay'); return; }
        requestAnimationFrame(Tick);
      };
      this.FireSounds(this.Time - 1e-4, this.Time);
      requestAnimationFrame(Tick);
    },

    FireSounds(From, To) {
      if (!$('StompSound').checked) return;
      for (const Track of this.Sequence.Tracks) for (const Event of Track.Events) {
        if (Event.Type !== 3 || !Event.Playable || !(Event.Time > From && Event.Time <= To)) continue;
        const Voice = new Audio(RefUrl('Sound', Event.Sound));
        Voice.volume = Number(Remember('AudioVolume') || 0.8);
        Voice.play().catch(() => {});
        this.Voices.push(Voice);
      }
    },

    Apply() {
      const Duration = Math.max(this.Sequence ? this.Sequence.Duration : 0, 0.001);
      $('StompTime').value = String(this.Time);
      $('StompTimeLabel').textContent = `${NumberText(this.Time, 2)} / ${NumberText(Duration, 2)} s`;
      for (const Head of document.querySelectorAll('#StompSheet .Playhead')) Head.style.left = `${(this.Time / Duration) * 100}%`;
      this.DrawMap();
    },

    /** PT: Posição interpolada da trilha no tempo atual (chaves de transformação). EN: Interpolated track position. */
    PositionAt(Path, Time) {
      if (!Path.length) return null;
      if (Time <= Path[0].Time) return Path[0].Position;
      for (let Number = 1; Number < Path.length; Number++) {
        const A = Path[Number - 1], B = Path[Number];
        if (Time <= B.Time) {
          if (!(B.Flags & 0x30)) return A.Position;   // PT: sem 0x10/0x20 = degrau / EN: no 0x10/0x20 = step
          const T = (Time - A.Time) / Math.max(1e-6, B.Time - A.Time);
          return A.Position.map((Value, Axis) => Value + (B.Position[Axis] - Value) * T);
        }
      }
      return Path[Path.length - 1].Position;
    },

    DrawMap() {
      const Canvas = $('StompMap');
      if (!Canvas.clientWidth || !this.Sequence) return;
      const Ratio = SizeCanvas(Canvas), Width = Canvas.width, Height = Canvas.height, Paint = Canvas.getContext('2d');
      Paint.clearRect(0, 0, Width, Height);
      const Points = [];
      this.Sequence.Tracks.forEach((Track, Number) => { for (const Key of this.Paths[Number]) Points.push(Key.Position); if (Track.Position) Points.push(Track.Position); });
      Paint.fillStyle = '#969890';
      Paint.font = `${11 * Ratio}px system-ui, sans-serif`;
      Paint.fillText(Text('StompMapHint'), 8 * Ratio, 16 * Ratio);
      if (!Points.length) return;
      // PT: enquadra a maioria dos pontos (percentis), para um objeto distante não espremer o resto. EN: robust framing.
      const Pick = (Values, Fraction) => { const Sorted = [...Values].sort((A, B) => A - B); return Sorted[Math.min(Sorted.length - 1, Math.floor(Fraction * (Sorted.length - 1)))]; };
      const Xs = Points.map(Point => Point[0]), Zs = Points.map(Point => Point[2]);
      const MinX = Pick(Xs, 0.1), MaxX = Pick(Xs, 0.9), MinZ = Pick(Zs, 0.1), MaxZ = Pick(Zs, 0.9);
      const Span = Math.max(MaxX - MinX, MaxZ - MinZ, 4) * 1.4, Margin = 24 * Ratio;
      const Scale = Math.min((Width - 2 * Margin) / Span, (Height - 2 * Margin) / Span);
      const CenterX = (MinX + MaxX) / 2, CenterZ = (MinZ + MaxZ) / 2;
      const Map = ([X, , Z]) => [Width / 2 + (X - CenterX) * Scale, Height / 2 + (Z - CenterZ) * Scale];
      this.Sequence.Tracks.forEach((Track, Number) => {
        const Path = this.Paths[Number], Chosen = this.Track === null || this.Track === Number;
        const Color = Chosen ? (this.Track === Number ? '#e0a33c' : '#7fb2e5') : '#7fb2e540';
        if (Path.length > 1) {
          Paint.strokeStyle = Color;
          Paint.lineWidth = (this.Track === Number ? 2 : 1.2) * Ratio;
          Paint.beginPath();
          Path.forEach((Key, Index) => { const [X, Y] = Map(Key.Position); if (Index && (Key.Flags & 0x30)) Paint.lineTo(X, Y); else Paint.moveTo(X, Y); });
          Paint.stroke();
        }
        const Where = this.PositionAt(Path, this.Time) || Track.Position;
        if (!Where) return;
        const [X, Y] = Map(Where);
        Paint.fillStyle = Chosen ? '#e4e2dc' : '#e4e2dc50';
        Paint.beginPath();
        Paint.arc(X, Y, (this.Track === Number ? 4.5 : 3) * Ratio, 0, Math.PI * 2);
        Paint.fill();
        if (Chosen && (Track.Name || Track.Class)) Paint.fillText(Track.Name || Track.Class, X + 6 * Ratio, Y - 6 * Ratio);
      });
    },

    RenderInfo() {
      const Panel = $('StompInfo'), Sequence = this.Sequence;
      Panel.innerHTML = '';
      if (!Sequence) return;
      Panel.appendChild(Make('h3', null, Sequence.Ref));
      Panel.appendChild(InfoGrid([
        [Text('StompLevel'), Sequence.Level || '—'],
        [Text('StompDuration'), NumberText(Sequence.Duration, 3) + ' s'],
        [Text('StompRadius'), NumberText(Sequence.Radius, 2)],
        [Text('AudioFlags'), Sequence.Flags],
        [Text('StompComplete'), Text(Sequence.Complete ? 'Yes' : 'No')],
      ]));
      if (Sequence.LevelKey) {
        const Button = Make('button', 'ToolButton', Text('StompOpenLevel'));
        Button.addEventListener('click', () => Ui().OpenLevel(Sequence.LevelKey));
        const Play = Make('button', 'ToolButton', Text('StompPlayInLevel'));
        Play.addEventListener('click', () => { this.SetPlaying(false); Ui().PlayStomp(Sequence); });
        const Row = Make('div', 'InfoActions');
        Row.append(Button, Play);
        Panel.appendChild(Row);
      }
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
      Panel.appendChild(Make('h4', null, Text('StompTrack')));
      Panel.appendChild(Table([Text('StompTrack'), Text('StompClass'), Text('StompEvents')], Sequence.Tracks.map((Track, Number) => ({
        Cells: [Track.Name || `#${Track.Object}`, Track.Class || '?', String(Track.Events.length)], Click: Track.Position && Sequence.LevelKey ? Number + 1 : null,
      })), Click => { const Track = Sequence.Tracks[Click - 1]; Ui().OpenLevel(Sequence.LevelKey, Track.Object, Track.Position); }));
      const EventBox = Make('div');
      EventBox.id = 'StompEvent';
      Panel.append(Make('h4', null, Text('StompEvent')), EventBox);
      this.RenderEvent();
    },

    RenderEvent() {
      const Box = $('StompEvent');
      if (!Box) return;
      Box.innerHTML = '';
      if (!this.Event) { Box.appendChild(Make('p', 'Muted', Text('StompPickEvent'))); return; }
      const Track = this.Sequence.Tracks[this.Event[0]], Event = Track.Events[this.Event[1]];
      if (Event.Text) Box.appendChild(Make('p', 'Spoken', Event.Text));
      const Fmt = List => List.map(Value => (typeof Value === 'number' && !Number.isInteger(Value) ? NumberText(Value, 3) : String(Value))).join(', ');
      Box.appendChild(InfoGrid([
        [Text('StompTrack'), Track.Name || `#${Track.Object}`],
        [Text('StompTime'), NumberText(Event.Time, 3) + ' s'],
        [Text('StompType'), `${Event.Type} · ${Event.Name}`],
        [Text('PropPosition'), Event.Position ? Fmt(Event.Position) : null],
        [Text('PropRotation'), Event.Rotation ? Fmt(Event.Rotation) : null],
        [Text('PropScale'), Event.Scale ? Fmt(Event.Scale) : null],
        [Text('PropFlags'), Event.Flags !== undefined ? Event.Flags : null],
        ['FOV', Event.Fov ? Event.Fov + '°' : null],
        [Text('StompTimeScale'), Event.TimeScale !== undefined ? Event.TimeScale : null],
        [Text('StompInterp'), Event.Interpolation],
        [Text('StompChannel'), Event.Channel !== undefined ? Event.Channel : null],
        [Text('StompStart'), Event.Start !== undefined ? NumberText(Event.Start, 3) + ' s' : null],
        [Text('StompBlend'), Event.Blend !== undefined ? NumberText(Event.Blend, 3) + ' s' : null],
        [Text('StompSpeed'), Event.Speed !== undefined ? NumberText(Event.Speed, 2) + '×' : null],
        [Text('PropFlags'), Event.AnimFlags],
        [Text('AudioVolume'), Event.Volume !== undefined ? Math.round(Event.Volume * 100) + ' %' : null],
        [Text('StompState'), Event.State],
        [Text('StompMessage'), Event.Message],
        [Text('TabAnimation'), Event.Animation],
        [Text('TabAudio'), Event.Sound],
        [Text('StompValues'), Event.Values && Event.Values.length ? Fmt(Event.Values) : null],
      ]));
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

    Relabel() { $('StompPlay').textContent = Text(this.Playing ? 'AnimPause' : 'AnimPlay'); if (this.Opening) this.RenderList(); if (this.Sequence) { this.RenderSheet(); this.RenderInfo(); this.Highlight(); this.Apply(); } },
    Show(Active) { if (Active) { this.Open(); this.DrawMap(); } else this.SetPlaying(false); },
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
