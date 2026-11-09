/*
 * RiotStompEdit — edição de uma sequência STOMP / editing one STOMP sequence
 *
 * PT: Guarda a sequência na forma crua que o servidor grava (/api/SequenceRaw): cada evento = tipo, tempo e os valores
 *     exatamente como vão para o .qdu (formato de cada tipo em Raw.Formats: f = float, I = u32, H = u16). Toda mudança
 *     passa por Do(), que guarda uma cópia para desfazer/refazer. Os eventos de cada trilha ficam sempre em ordem de
 *     tempo (todas as sequências originais estão assim, e o servidor ordena igual), então o índice de um evento aqui é o
 *     mesmo da visão decodificada que o tocador usa.
 *     Campos por tipo (Fields): o que se sabe de cada valor (mesmos fatos de RiotMedia.py); o resto aparece como valor
 *     cru com "(?)". Conversões: posição = cru / Raw.Scale (2048 no TS1, 1 no TTB); rotação: o arquivo guarda o
 *     quaternião invertido (mundo -> objeto), a rotação do objeto é (-x, -y, -z, w), mostrada em graus (Euler XYZ).
 * EN: Holds a sequence in the raw form the server writes; every change goes through Do() (undo/redo snapshots); events
 *     stay in time order so indexes match the decoded view. Fields(Type) describes each value; unknown ones stay raw.
 */
class RiotStompEdit {
  constructor(Raw) {
    this.Raw = Raw;
    this.Saved = this.Snapshot();
    this.UndoStack = [];
    this.RedoStack = [];
    this.OnChange = null;
  }

  Snapshot() { return JSON.stringify({ Flags: this.Raw.Flags, Radius: this.Raw.Radius, Tracks: this.Raw.Tracks }); }

  get Dirty() { return this.Snapshot() !== this.Saved; }

  /** PT: Quantos eventos diferem do que está gravado (para o rótulo). EN: How many events differ from the saved file. */
  ChangedCount() {
    const Saved = JSON.parse(this.Saved);
    let Count = (Saved.Flags !== this.Raw.Flags ? 1 : 0) + (Saved.Radius !== this.Raw.Radius ? 1 : 0);
    this.Raw.Tracks.forEach((Track, TrackIndex) => {
      const Before = (Saved.Tracks[TrackIndex] || { Events: [] }).Events.map(Event => JSON.stringify(Event));
      const After = Track.Events.map(Event => JSON.stringify(Event));
      const Pool = new Map();
      for (const Key of Before) Pool.set(Key, (Pool.get(Key) || 0) + 1);
      let Same = 0;
      for (const Key of After) if (Pool.get(Key)) { Pool.set(Key, Pool.get(Key) - 1); Same++; }
      Count += Math.max(Before.length, After.length) - Same;
    });
    return Count;
  }

  /** PT: Aplica uma mudança com desfazer. EN: Applies a change with undo. */
  Do(Change) {
    const Before = this.Snapshot();
    const Result = Change();
    if (this.Snapshot() === Before) return Result;
    this.UndoStack.push(Before);
    if (this.UndoStack.length > 200) this.UndoStack.shift();
    this.RedoStack = [];
    this.Sort();
    if (this.OnChange) this.OnChange();
    return Result;
  }

  Restore(Text_) { const Data = JSON.parse(Text_); this.Raw.Flags = Data.Flags; this.Raw.Radius = Data.Radius; this.Raw.Tracks = Data.Tracks; }
  Undo() { if (!this.UndoStack.length) return false; this.RedoStack.push(this.Snapshot()); this.Restore(this.UndoStack.pop()); if (this.OnChange) this.OnChange(); return true; }
  Redo() { if (!this.RedoStack.length) return false; this.UndoStack.push(this.Snapshot()); this.Restore(this.RedoStack.pop()); if (this.OnChange) this.OnChange(); return true; }
  MarkSaved() { this.Saved = this.Snapshot(); }

  /** PT: Ordena os eventos de cada trilha pelo tempo (estável). EN: Sorts each track's events by time (stable). */
  Sort() { for (const Track of this.Raw.Tracks) Track.Events.sort((A, B) => Math.fround(A.Time) - Math.fround(B.Time)); }

  Format(Type) { return this.Raw.Formats[String(Type)] || ''; }

  // ------------------------------------------------------------------ operações / operations
  /** PT: Valores de um evento novo: copia o vizinho do mesmo tipo (trilha, depois sequência) ou usa padrões neutros. */
  /** EN: New event values: copy the nearest same-type event (track first, then sequence) or neutral defaults. */
  DefaultValues(TrackIndex, Type, Time) {
    const Nearest = Events => Events.filter(Event => Event.Type === Type).sort((A, B) => Math.abs(A.Time - Time) - Math.abs(B.Time - Time))[0];
    const Copy = Nearest(this.Raw.Tracks[TrackIndex].Events) || Nearest(this.Raw.Tracks.flatMap(Track => Track.Events));
    if (Copy) return [...Copy.Values];
    const Format = this.Format(Type);
    const Values = [...Format].map(Code => (Code === 'f' ? 0 : 0));
    if (Type === 0) { Values[3] = 1; Values[9] = Values[10] = Values[11] = 1; }
    if (Type === 1) Values[4] = 1;
    if (Type === 3) Values[1] = 10000;
    if (Type === 6) Values[0] = 1;
    if (Type === 9) { Values[0] = 1; Values[2] = 1; }
    return Values;
  }

  Add(TrackIndex, Type, Time, Values) {
    return this.Do(() => {
      const Event = { Type, Time: Math.fround(Math.max(0, Time)), Values: Values || this.DefaultValues(TrackIndex, Type, Time) };
      this.Raw.Tracks[TrackIndex].Events.push(Event);
      return Event;
    });
  }

  Remove(TrackIndex, EventIndex) { this.Do(() => { this.Raw.Tracks[TrackIndex].Events.splice(EventIndex, 1); }); }

  Duplicate(TrackIndex, EventIndex, Time) {
    const Source = this.Raw.Tracks[TrackIndex].Events[EventIndex];
    return this.Add(TrackIndex, Source.Type, Time, [...Source.Values]);
  }

  /** PT: Muda o tempo de um evento; devolve o novo índice. EN: Changes an event's time; returns its new index. */
  Move(TrackIndex, EventIndex, Time) {
    const Event = this.Raw.Tracks[TrackIndex].Events[EventIndex];
    this.Do(() => { Event.Time = Math.fround(Math.max(0, Time)); });
    return this.Raw.Tracks[TrackIndex].Events.indexOf(Event);
  }

  /** PT: Troca valores crus de um evento ({índice: valor}). EN: Sets raw values of an event. */
  SetValues(TrackIndex, EventIndex, Changes) {
    const Event = this.Raw.Tracks[TrackIndex].Events[EventIndex];
    this.Do(() => { for (const [Index, Value] of Object.entries(Changes)) Event.Values[Number(Index)] = Value; });
    return this.Raw.Tracks[TrackIndex].Events.indexOf(Event);
  }

  SetSequence(Flags, Radius) { this.Do(() => { this.Raw.Flags = Flags; this.Raw.Radius = Radius; }); }

  /**
   * PT: Grava uma pose (do visor) como chave de transformação no tempo: atualiza a chave que já está nesse tempo ou
   *     cria uma copiando flags/escala/extras da chave anterior. Position em unidades do visor, Quat = rotação do objeto.
   * EN: Stores a pose as a transform key at a time (updates a key already at that time, else adds one).
   */
  KeyPose(TrackIndex, Time, Position, Quat, Scale) {
    const Track = this.Raw.Tracks[TrackIndex], S = this.Raw.Scale;
    const Length = Math.hypot(...Quat) || 1;
    const Pose = { 0: -Quat[0] / Length, 1: -Quat[1] / Length, 2: -Quat[2] / Length, 3: Quat[3] / Length, 4: Position[0] * S, 5: Position[1] * S, 6: Position[2] * S };
    if (Scale) Object.assign(Pose, { 9: Scale[0], 10: Scale[1], 11: Scale[2] });
    const Existing = Track.Events.findIndex(Event => Event.Type === 0 && Math.abs(Event.Time - Time) < 1e-4);
    if (Existing >= 0) return this.SetValues(TrackIndex, Existing, Pose);
    const Previous = Track.Events.filter(Event => Event.Type === 0 && Event.Time <= Time).pop();
    const Values = this.DefaultValues(TrackIndex, 0, Time);
    if (Previous) Values.splice(0, Values.length, ...Previous.Values);
    for (const [Index, Value] of Object.entries(Pose)) Values[Number(Index)] = Value;
    const Event = this.Add(TrackIndex, 0, Time, Values);
    return Track.Events.indexOf(Event);
  }

  // ------------------------------------------------------------------ campos / fields
  /**
   * PT: Descrição dos valores de cada tipo: [{Index, Kind, Key (texto), Count}]. Kinds: float, int, u16, ref, message,
   *     enum (Options), flags, volume, position (3), rotation (4), scale (3), raw.
   * EN: Value layout of each event type.
   */
  static Fields(Type, IsTTB) {
    switch (Type) {
      case 0: return [
        { Index: 4, Kind: 'position', Key: 'PropPosition' }, { Index: 0, Kind: 'rotation', Key: 'StompRotationDeg' },
        { Index: 9, Kind: 'scale', Key: 'PropScale' },
        { Index: 8, Kind: 'flags', Key: 'StompKeyFlags', Tip: 'StompKeyFlagsTip' }, { Index: 7, Kind: 'raw', Key: 'StompUnknown' },
        ...(IsTTB ? [12, 13, 14].map(Index => ({ Index, Kind: 'raw', Key: 'StompUnknown' })) : [])];
      case 1: return [
        { Index: 1, Kind: 'ref', Key: 'TabAnimation' }, { Index: 0, Kind: 'int', Key: 'StompChannel' },
        { Index: 2, Kind: 'float', Key: 'StompStart' }, { Index: 3, Kind: 'float', Key: 'StompBlend' },
        { Index: 4, Kind: 'float', Key: 'StompSpeed' }, { Index: 5, Kind: 'flags', Key: 'PropFlags', Tip: 'StompAnimFlagsTip' }];
      case 3: return [
        { Index: 0, Kind: 'ref', Key: 'TabAudio' }, { Index: 1, Kind: 'volume', Key: 'AudioVolume' },
        { Index: 2, Kind: 'flags', Key: 'PropFlags', Tip: 'StompSoundFlagsTip' }];
      case 4: return [{ Index: 0, Kind: 'int', Key: 'StompAttachTrack' }, { Index: 1, Kind: 'int', Key: 'StompHardpoint' }];
      case 5: return [{ Index: 0, Kind: 'enum', Key: 'StompState', Options: [[0, 'StompTake'], [1, 'StompRelease']] }];
      case 6: return [{ Index: 0, Kind: 'enum', Key: 'StompState', Options: [[0, 'StompHidden'], [1, 'StompShown']] }];
      case 7: return [{ Index: 0, Kind: 'message', Key: 'StompMessage' }, { Index: 1, Kind: 'int', Key: 'StompParam' }, { Index: 2, Kind: 'flags', Key: 'PropFlags' }];
      case 9: return [
        { Index: 0, Kind: 'float', Key: 'StompTimeScale' }, { Index: 1, Kind: 'int', Key: 'StompFov' },
        { Index: 2, Kind: 'enum', Key: 'StompInterp', Options: [[0, 'StompStep'], [1, 'StompLinear'], [2, 'StompEaseOut'], [4, 'StompEaseIn'], [6, 'StompEaseInOut']] }];
      case 10: return [];
      default: return null;
    }
  }

  static RefText(Value) { return Value ? `${Value >>> 16}_${(Value & 0xFFFF).toString(16).padStart(4, '0')}` : ''; }

  static ParseRef(Text_) {
    const Match = /^\s*(\d+)[_:/ ]([0-9a-fA-F]{1,4})\s*$/.exec(Text_ || '');
    if (!Text_ || !Text_.trim()) return 0;
    return Match ? ((Number(Match[1]) << 16) | parseInt(Match[2], 16)) >>> 0 : null;
  }
}
