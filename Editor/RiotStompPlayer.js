/*
 * RiotStompPlayer — sequências STOMP tocando dentro da fase / STOMP sequences playing inside the level
 *
 * PT: Toca uma sequência (.qdu 0x0311) no visor da fase: as chaves de transformação movem e giram os objetos das
 *     trilhas, a trilha do objeto Camera assume o visor (posição, rotação e campo de visão das chaves de câmera),
 *     a visibilidade liga/desliga objetos, os sons tocam na hora (com legenda) e mensagens/controle/anexos/marcadores
 *     aparecem num registro. Nada é gravado; ao sair, tudo volta para o lugar.
 *     Regras (fatos conferidos com o projeto "the-suffering-engine", código escrito aqui):
 *       • transformação: quaternion (x, y, z, w) guardado INVERTIDO (mundo -> objeto): a rotação do objeto é
 *         (-x, -y, -z, w), na mesma base das instâncias da fase; posição em unidades do arquivo; escala nos eixos do
 *         mundo (M = T · S · R, como no .lvl);
 *       • a última chave vale até a próxima, a menos que a próxima peça interpolação: 0x10 linear, 0x20 Catmull-Rom
 *         (precisa de uma chave depois), 0xC0 suavização (0x40 sai, 0x80 entra, 0xC0 cosseno), 0x800 posição em
 *         velocidade constante (a suavização só vale para a rotação), 0x100/0x200/0x400 deixam posição/rotação/escala
 *         como estavam;
 *       • câmera: olha para o -Z do objeto; o FOV da chave é VERTICAL numa imagem 4:3 (telas mais largas mantêm o
 *         ângulo horizontal do 4:3); FOV e escala de tempo interpolam até a próxima chave (0 degrau, 1/3/5 linear,
 *         2 sai, 4 entra, 6 cosseno); a escala de tempo muda a velocidade do relógio do jogo.
 *     Personagens: as chaves de animação (tipo 1) do canal 0 tocam no modelo com esqueleto (pele na CPU, como na aba
 *     Animação): tempo do clipe = início + (t − chave) × velocidade (em loop, ou parado no fim se o .adu diz "toca uma
 *     vez"); mistura linear do clipe anterior durante o "blend" da chave; movimento da raiz pelos 4 modos de 2 bits
 *     das flags (x, y, z, rotação): 0 fica na pose, 1 vai para o objeto (aqui fica na pose), 2 travado (sem
 *     movimento). Canais ≠ 0 (só um ramo do esqueleto) ainda não.
 * EN: Plays a STOMP sequence in the level viewport: transform keys pose the tracks' objects, the Camera track drives
 *     the view (with the camera keys' FOV and time scale), visibility toggles objects, sounds play with subtitles and
 *     the other keys are logged. Nothing is saved; everything is put back on exit.
 */
class RiotStompPlayer {
  constructor(LevelView, Viewport) {
    this.LevelView = LevelView;
    this.Viewport = Viewport;
    this.Sequence = null;
    this.Playing = false;
    this.Time = 0;
    this.SceneCamera = true;
    this.Sound = true;
    this.Voices = [];
    this.Log = [];
  }

  get Active() { return Boolean(this.Sequence); }

  // ------------------------------------------------------------------ preparação / setup
  Start(Sequence) {
    this.Stop();
    const Scene = this.LevelView.Scene;
    if (!Scene) return false;
    const ByTime = (A, B) => A.Time - B.Time;
    this.Sequence = Sequence;
    this.Time = 0;
    this.Tracks = Sequence.Tracks.map(Track => {
      const Number = Scene.Instances.findIndex(Instance => Instance[6] === Track.Object);
      const Keys = Track.Events.filter(Event => Event.Type === 0).sort(ByTime).map(Event => {
        const [X, Y, Z, W] = Event.Rotation, Length = Math.hypot(X, Y, Z, W) || 1;
        return { Time: Event.Time, Quat: [-X / Length, -Y / Length, -Z / Length, W / Length], Position: Event.Position, Scale: Event.Scale, Flags: Event.Flags };
      });
      return {
        Track, Number, Keys,
        Cameras: Track.Events.filter(Event => Event.Type === 9).sort(ByTime).map(Event => ({ Time: Event.Time, TimeScale: Event.TimeScale, Fov: Event.Fov || 0, Mode: Event.Values ? Event.Values[2] & 7 : 1 })),
        Visibility: Track.Events.filter(Event => Event.Type === 6).sort(ByTime).map(Event => ({ Time: Event.Time, Visible: Event.Values ? Event.Values[0] !== 0 : true })),
        Others: Track.Events.filter(Event => ![0, 6, 9].includes(Event.Type)),
        Anims: Track.Events.filter(Event => Event.Type === 1 && !Event.Channel).sort(ByTime).map(Event => ({
          Time: Event.Time, Ref: Event.Animation, Start: Event.Start || 0, Blend: Event.Blend || 0, Speed: Event.Speed, Flags: parseInt(Event.AnimFlags, 16) || 0 })),
        Rig: null,
        IsCamera: Track.Class === 'Camera',
        Touched: false,
      };
    });
    this.CameraTrack = this.Tracks.find(Item => Item.IsCamera && Item.Keys.length) || null;
    const Camera = this.Viewport.Camera, Forward = new THREE.Vector3();
    Camera.getWorldDirection(Forward);
    this.SavedView = [Camera.position.clone(), Camera.position.clone().add(Forward.multiplyScalar(5)), Camera.fov];
    this.Log = [];
    // PT: a cena mostra os objetos das trilhas, mesmo os escondidos no início (Hermes e Killjoy na 1b têm flags 0)
    // EN: the scene shows its tracks' objects, even hidden-at-start ones
    for (const Item of this.Tracks) if (Item.Number >= 0) { this.LevelView.ForceShown.add(Item.Number); this.LevelView.UpdateInstance(Item.Number); }
    // PT: modo cinema: marcadores do editor e colisão invisível saem da frente (mesmo com "All" no filtro de classes)
    // EN: cinema mode: editor markers and invisible collision get out of the way
    this.LevelView.SetCinema(true);
    if (!this.CameraTrack) this.Frame0();
    this.Apply();
    this.Loading = this.LoadRigs(Sequence);
    return true;
  }

  /** PT: Sem trilha de câmera: enquadra onde a cena acontece. EN: No camera track: frame where the scene happens. */
  Frame0() {
    // PT: objetos "estacionados" fora do mapa entram pela 1ª chave longe da ação, então procura o ponto com mais
    //     vizinhos (a 8 m) entre posições de colocação e de todas as chaves, valendo o dobro para os atores.
    // EN: stand-ins parked off the map make a naive box useless: take the densest spot among placements and keys.
    const Points = [];
    for (const Item of this.Tracks) {
      const Weight = Item.Number >= 0 && Item.Anims.length ? 2 : Item.Number >= 0 ? 1 : 0.25;
      if (Item.Keys.length) for (const Key of Item.Keys) Points.push([new THREE.Vector3().fromArray(Key.Position), Weight]);
      else if (Item.Number >= 0) Points.push([new THREE.Vector3().fromArray(this.LevelView.Scene.Instances[Item.Number][1]), Weight]);
      else if (Item.Track.Position) Points.push([new THREE.Vector3().fromArray(Item.Track.Position), Weight]);
    }
    if (!Points.length) return;
    let Best = null, BestScore = -1;
    for (const [Point] of Points) {
      const Score = Points.reduce((Sum, [Other, Weight]) => Sum + (Other.distanceTo(Point) < 8 ? Weight : 0), 0);
      if (Score > BestScore) { BestScore = Score; Best = Point; }
    }
    const Center = new THREE.Vector3(), Box = new THREE.Box3();
    let Total = 0;
    for (const [Point, Weight] of Points) if (Point.distanceTo(Best) < 8) { Center.addScaledVector(Point, Weight); Total += Weight; Box.expandByPoint(Point); }
    Center.divideScalar(Total || 1);
    const Size = Math.min(Math.max(Box.getSize(new THREE.Vector3()).length(), 5), 15);
    this.Viewport.SetView(new THREE.Vector3(Center.x + Size * 0.7, Center.y + Size * 0.45, Center.z + Size * 0.7), Center);
  }

  // ------------------------------------------------------------------ personagens / characters
  /** PT: Carrega modelos com esqueleto e os clipes usados (em segundo plano). EN: Loads skinned models and clips. */
  async LoadRigs(Sequence) {
    const Shared = RiotAssetTabs.Shared, Clips = new Map();
    const Clip = Ref => {
      if (!Clips.has(Ref)) { const [Package, Index] = Shared.SplitRef(Ref); Clips.set(Ref, fetch(`/api/Animation/${Package}/${Index}`).then(Response => Response.json()).catch(() => null)); }
      return Clips.get(Ref);
    };
    await Promise.all(this.Tracks.map(async Item => {
      if (Item.Number < 0 || !Item.Anims.length) return;
      const Key = this.LevelView.Scene.Instances[Item.Number][0];
      let Model = null;
      try { Model = await Shared.FetchModel(Key); } catch (Error) { Model = null; }
      if (this.Sequence !== Sequence) { if (Model) Model.Dispose(); return; }
      if (!Model || !Model.Bones) { if (Model) Model.Dispose(); return; }
      await Promise.all(Item.Anims.map(async Anim => { const Data = await Clip(Anim.Ref); Anim.Clip = Data && !Data.Error ? Data : null; }));
      if (this.Sequence !== Sequence) { Model.Dispose(); return; }
      Model.Root.matrixAutoUpdate = false;
      Model.Locals = Model.Bones.map(() => ({ Q: new THREE.Quaternion(), V: new THREE.Vector3(), Has: false }));
      Model.LocalsB = Model.Bones.map(() => ({ Q: new THREE.Quaternion(), V: new THREE.Vector3(), Has: false }));
      this.Viewport.Scene.add(Model.Root);
      Item.Rig = Model;
      this.Log.push(`${Item.Track.Name || Item.Track.Class}: ${Item.Anims.length} anim`);
      this.Apply();
    }));
  }

  static Locks(Flags) {
    const Mode = Shift => Math.min(2, (Flags >>> Shift) & 3);
    return { X: Mode(0), Y: Mode(2), Z: Mode(4), R: Mode(6) };
  }

  /** PT: Pose local de cada osso num tempo do clipe. EN: Local pose of every bone at a clip time. */
  static Sample(Model, Animation, Time, Locks, Out) {
    const QA = new THREE.Quaternion(), QB = new THREE.Quaternion();
    Model.Bones.forEach((Bone, Index) => {
      const Slot = Out[Index], Track = Animation ? Animation.Tracks[String(Bone.Id)] : null;
      Slot.Has = Boolean(Track && Track.Keys.length);
      if (!Slot.Has) return;
      const Keys = Track.Keys, Stride = Track.Stride, Count = Keys.length / Stride;
      let Low = 0, High = Count - 1;
      while (Low < High) { const Middle = (Low + High + 1) >> 1; if (Keys[Middle * Stride] <= Time) Low = Middle; else High = Middle - 1; }
      const A = Low * Stride, B = Math.min(Low + 1, Count - 1) * Stride, Span = Keys[B] - Keys[A];
      const U = Span > 0 ? Math.min(1, Math.max(0, (Time - Keys[A]) / Span)) : 0;
      QA.set(Keys[A + 1], Keys[A + 2], Keys[A + 3], Keys[A + 4]); QB.set(Keys[B + 1], Keys[B + 2], Keys[B + 3], Keys[B + 4]);
      Slot.Q.copy(QA).slerp(QB, U).normalize();
      if (Stride === 8) Slot.V.set(Keys[A + 5] + (Keys[B + 5] - Keys[A + 5]) * U, Keys[A + 6] + (Keys[B + 6] - Keys[A + 6]) * U, Keys[A + 7] + (Keys[B + 7] - Keys[A + 7]) * U);
      else if (Track.Rest) Slot.V.set(Track.Rest[0], Track.Rest[1], Track.Rest[2]);
      else Slot.V.set(0, 0, 0);
      // PT: ossos de cima (raiz e pelve): movimento travado = valor do começo do clipe / EN: locked root motion
      if (Bone.Parent < 0 || Model.Bones[Bone.Parent].Parent < 0) {
        if (Stride === 8) { if (Locks.X === 2) Slot.V.x = Keys[5]; if (Locks.Y === 2) Slot.V.y = Keys[6]; if (Locks.Z === 2) Slot.V.z = Keys[7]; }
        if (Locks.R === 2) Slot.Q.set(Keys[1], Keys[2], Keys[3], Keys[4]).normalize();
      }
    });
  }

  /** PT: Tempo dentro do clipe para uma chave (loop ou para no fim). EN: Clip time for a key (loop or hold). */
  static ClipTime(Anim, Time) {
    const Clip = Anim.Clip, Duration = Clip ? Math.max(Clip.Duration, 1e-3) : 1;
    const Local = Anim.Start + (Time - Anim.Time) * Anim.Speed;
    return Clip && Clip.PlaysOnce ? Math.min(Math.max(Local, 0), Duration) : ((Local % Duration) + Duration) % Duration;
  }

  /** PT: Pose do personagem no tempo da sequência, misturando o clipe anterior. EN: Character pose, blending clips. */
  PoseRig(Item) {
    const Model = Item.Rig, Anims = Item.Anims, Index = RiotStompPlayer.LastAt(Anims, this.Time);
    const Current = Index >= 0 ? Anims[Index] : null, Previous = Index > 0 ? Anims[Index - 1] : null;
    if (Current && Current.Clip) RiotStompPlayer.Sample(Model, Current.Clip, RiotStompPlayer.ClipTime(Current, this.Time), RiotStompPlayer.Locks(Current.Flags), Model.Locals);
    else for (const Slot of Model.Locals) Slot.Has = false;
    let Weight = 1;
    if (Current && Previous && Previous.Clip && Current.Blend > 0 && this.Time - Current.Time < Current.Blend) {
      Weight = (this.Time - Current.Time) / Current.Blend;
      RiotStompPlayer.Sample(Model, Previous.Clip, RiotStompPlayer.ClipTime(Previous, this.Time), RiotStompPlayer.Locks(Previous.Flags), Model.LocalsB);
    } else for (const Slot of Model.LocalsB) Slot.Has = false;
    const Local = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), BindQ = new THREE.Quaternion(), BindV = new THREE.Vector3(), Unused = new THREE.Vector3();
    let Pelvis = -1;
    for (const Bone of Model.Order) {
      const Info = Model.Bones[Bone], Parent = Info.Parent, A = Model.Locals[Bone], B = Model.LocalsB[Bone];
      if (!A.Has && !B.Has && Current && Pelvis >= 0 && Parent >= 0 && Model.Bones[Parent].Parent < 0) {
        Model.World[Bone].multiplyMatrices(Model.World[Pelvis], Model.InverseBind[Pelvis]).multiply(Model.Bind[Bone]);
        continue;
      }
      if (A.Has || B.Has) {
        Model.LocalBind[Bone].decompose(BindV, BindQ, Unused);
        const QA = A.Has ? A.Q : BindQ, VA = A.Has ? A.V : BindV, QB = B.Has ? B.Q : BindQ, VB = B.Has ? B.V : BindV;
        if (Weight < 1) { Q.copy(QB).slerp(QA, Weight); V.copy(VB).lerp(VA, Weight); } else { Q.copy(QA); V.copy(VA); }
        Local.makeRotationFromQuaternion(Q).setPosition(V);
      } else Local.copy(Model.LocalBind[Bone]);
      if (Parent >= 0) Model.World[Bone].multiplyMatrices(Model.World[Parent], Local); else Model.World[Bone].copy(Local);
      if ((A.Has || B.Has) && Pelvis < 0 && Parent >= 0 && Model.Bones[Parent].Parent < 0) Pelvis = Bone;
    }
    for (let Bone = 0; Bone < Model.Bones.length; Bone++) Model.Skin[Bone].multiplyMatrices(Model.World[Bone], Model.InverseBind[Bone]);
    Model.ApplySkin();
  }

  /** PT: Sai do modo de reprodução e devolve tudo. EN: Leaves playback and restores everything. */
  Stop() {
    if (!this.Sequence) return;
    this.SetPlaying(false);
    for (const Item of this.Tracks) {
      if (Item.Rig) { this.Viewport.Scene.remove(Item.Rig.Root); Item.Rig.Dispose(); Item.Rig = null; }
      if (Item.Number >= 0 && (Item.Touched || Item.Anims.length)) this.LevelView.UpdateInstance(Item.Number);
    }
    const Camera = this.Viewport.Camera;
    if (this.SavedView) {
      Camera.fov = this.SavedView[2];
      Camera.updateProjectionMatrix();
      if (this.CameraTrack && this.SceneCamera) {
        // PT: a câmera livre continua de onde a cena parou / EN: the free camera carries on from the shot
        const Forward = new THREE.Vector3();
        Camera.getWorldDirection(Forward);
        this.Viewport.SetView(Camera.position.clone(), Camera.position.clone().add(Forward.multiplyScalar(5)));
      }
    }
    this.LevelView.SetCinema(false);
    const Forced = [...this.LevelView.ForceShown];
    this.LevelView.ForceShown.clear();
    for (const Number of Forced) this.LevelView.UpdateInstance(Number);
    this.Sequence = null;
    this.Tracks = [];
    this.CameraTrack = null;
    if (this.OnChange) this.OnChange();
  }

  // ------------------------------------------------------------------ amostragem / sampling
  static Ease(U, Flags) {
    switch (Flags & 0xC0) {
      case 0x40: return 1 - (U - 1) * (U - 1);
      case 0x80: return U * U;
      case 0xC0: return (1 - Math.cos(U * Math.PI)) / 2;
      default: return U;
    }
  }

  static EaseCamera(U, Mode) {
    if (Mode === 0) return U >= 1 ? 1 : 0;
    if (Mode === 2) return 1 - (U - 1) * (U - 1);
    if (Mode === 4) return U * U;
    if (Mode === 6) return (1 - Math.cos(U * Math.PI)) / 2;
    return U;
  }

  static LastAt(List, Time) {
    let Found = -1;
    for (let Index = 0; Index < List.length && List[Index].Time <= Time + 1e-6; Index++) Found = Index;
    return Found;
  }

  static Spline(P0, P1, P2, P3, U) {
    const U2 = U * U, U3 = U2 * U;
    return 0.5 * (2 * P1 + (P2 - P0) * U + (2 * P0 - 5 * P1 + 4 * P2 - P3) * U2 + (3 * P1 - P0 - 3 * P2 + P3) * U3);
  }

  /** PT: Pose da trilha no tempo (ou null antes da 1ª chave). EN: Track pose at a time (null before the first key). */
  Pose(Keys, Time) {
    const Index = RiotStompPlayer.LastAt(Keys, Time);
    if (Index < 0) return null;
    const Current = Keys[Index];
    const Held = Mask => { for (let Back = Index; Back >= 0; Back--) if (!(Keys[Back].Flags & Mask)) return Keys[Back]; return Current; };
    let Position = Held(0x100).Position, Quat = Held(0x200).Quat, Scale = Held(0x400).Scale;
    const Next = Keys[Index + 1];
    if (Next && Next.Flags & 0x30 && Next.Time - Current.Time >= 1e-3) {
      const Linear = Math.min(1, Math.max(0, (Time - Current.Time) / (Next.Time - Current.Time)));
      const Eased = RiotStompPlayer.Ease(Linear, Next.Flags), Along = Next.Flags & 0x800 ? Linear : Eased;
      if (!(Next.Flags & 0x100)) {
        if (Next.Flags & 0x20 && Keys[Index + 2]) {
          const Before = (Keys[Index - 1] || Current).Position, After = Keys[Index + 2].Position;
          Position = [0, 1, 2].map(Axis => RiotStompPlayer.Spline(Before[Axis], Current.Position[Axis], Next.Position[Axis], After[Axis], Along));
        } else Position = [0, 1, 2].map(Axis => Current.Position[Axis] + (Next.Position[Axis] - Current.Position[Axis]) * Along);
      }
      if (!(Next.Flags & 0x200)) {
        const A = new THREE.Quaternion(...Current.Quat), B = new THREE.Quaternion(...Next.Quat);
        A.slerp(B, Eased);
        Quat = [A.x, A.y, A.z, A.w];
      }
      if (!(Next.Flags & 0x400)) Scale = [0, 1, 2].map(Axis => Current.Scale[Axis] + (Next.Scale[Axis] - Current.Scale[Axis]) * Along);
    }
    return { Position, Quat, Scale };
  }

  Lens(Cameras, Time) {
    const Index = RiotStompPlayer.LastAt(Cameras, Time);
    if (Index < 0) return null;
    const Current = Cameras[Index], Next = Cameras[Index + 1];
    if (!Next || Next.Time - Current.Time < 1e-3) return { Fov: Current.Fov, TimeScale: Current.TimeScale };
    const U = RiotStompPlayer.EaseCamera(Math.min(1, (Time - Current.Time) / (Next.Time - Current.Time)), Next.Mode);
    return {
      Fov: Current.Fov && Next.Fov ? Current.Fov + (Next.Fov - Current.Fov) * U : Current.Fov,
      TimeScale: Current.TimeScale && Next.TimeScale ? Current.TimeScale + (Next.TimeScale - Current.TimeScale) * U : Current.TimeScale,
    };
  }

  // ------------------------------------------------------------------ aplicar / apply
  Apply() {
    if (!this.Sequence) return;
    const View = this.LevelView, Matrix = new THREE.Matrix4(), Scale = new THREE.Matrix4(), Quat = new THREE.Quaternion();
    for (const Item of this.Tracks) {
      if (Item.Number < 0) continue;
      const Pose = this.Pose(Item.Keys, this.Time);
      const Vis = Item.Visibility[RiotStompPlayer.LastAt(Item.Visibility, this.Time)];
      const Hidden = (Vis && !Vis.Visible) || View.Hidden.has(Item.Number);
      if (!Pose && !Vis && !Item.Rig) { if (Item.Touched) { View.UpdateInstance(Item.Number); Item.Touched = false; } continue; }
      Item.Touched = true;
      if (Hidden) Matrix.makeScale(0, 0, 0);
      else if (Pose) {
        Matrix.makeRotationFromQuaternion(Quat.set(...Pose.Quat));
        Matrix.premultiply(Scale.makeScale(...Pose.Scale));
        Matrix.setPosition(Pose.Position[0], Pose.Position[1], Pose.Position[2]);
      } else View.InstanceMatrix(View.Scene.Instances[Item.Number], Matrix);
      if (Item.Rig) {
        // PT: o personagem com esqueleto substitui a malha parada / EN: the skinned character replaces the static mesh
        Item.Rig.Root.matrix.copy(Matrix);
        Item.Rig.Root.matrixWorldNeedsUpdate = true;
        Item.Rig.Root.visible = !Hidden;
        if (!Hidden) this.PoseRig(Item);
        Matrix.makeScale(0, 0, 0);
      }
      for (const [Mesh, Slot] of View.InstanceSlots.get(Item.Number) || []) { Mesh.setMatrixAt(Slot, Matrix); Mesh.instanceMatrix.needsUpdate = true; }
    }
    this.ApplyCamera();
    if (this.OnChange) this.OnChange();
  }

  /** PT: Chamado a cada quadro, depois dos controles: a câmera da cena manda no visor. EN: Per frame, after the controls. */
  ApplyCamera() {
    if (!this.Sequence || !this.CameraTrack || !this.SceneCamera) return;
    const Pose = this.Pose(this.CameraTrack.Keys, this.Time);
    if (!Pose) return;
    const Camera = this.Viewport.Camera;
    Camera.position.set(Pose.Position[0], Pose.Position[1], Pose.Position[2]);
    Camera.quaternion.set(...Pose.Quat);
    const Lens = this.Lens(this.CameraTrack.Cameras, this.Time);
    const Degrees = Lens && Lens.Fov ? Lens.Fov : this.SavedView[2];
    const Fov = Lens && Lens.Fov ? 2 * Math.atan(Math.tan(Degrees * Math.PI / 360) * Math.min(1, (4 / 3) / Math.max(Camera.aspect, 1e-3))) * 180 / Math.PI : Degrees;
    if (Math.abs(Camera.fov - Fov) > 1e-3) { Camera.fov = Fov; Camera.updateProjectionMatrix(); }
    Camera.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ tempo / time
  SetTime(Time) {
    this.Time = Math.max(0, Math.min(this.Sequence ? this.Sequence.Duration : 0, Time));
    this.Apply();
  }

  SetPlaying(Playing) {
    if (Playing && !this.Sequence) return;
    if (Playing && this.Time >= this.Sequence.Duration - 1e-3) { this.Time = 0; this.Log = []; }
    this.Playing = Playing;
    if (!Playing) { for (const Voice of this.Voices) Voice.pause(); this.Voices = []; if (this.OnSubtitle) this.OnSubtitle(null); }
    else this.Fire(this.Time - 1e-4, this.Time);
    if (this.OnChange) this.OnChange();
  }

  /** PT: Avança o relógio (escala de tempo da câmera incluída). EN: Advances the clock (camera time scale included). */
  Frame(Delta) {
    if (!this.Sequence) return;
    if (this.Playing) {
      const Lens = this.CameraTrack ? this.Lens(this.CameraTrack.Cameras, this.Time) : null;
      const Rate = Lens && Lens.TimeScale > 0 ? Lens.TimeScale : 1;
      const Before = this.Time;
      this.Time = Math.min(this.Sequence.Duration, this.Time + Delta * Rate);
      this.Fire(Before, this.Time);
      this.Apply();
      if (this.Time >= this.Sequence.Duration) this.SetPlaying(false);
    } else this.ApplyCamera();
  }

  /** PT: Dispara sons e registra as outras chaves entre dois tempos. EN: Fires sounds and logs other keys. */
  Fire(From, To) {
    for (const Item of this.Tracks) for (const Event of Item.Others) {
      if (!(Event.Time > From && Event.Time <= To)) continue;
      const Who = Item.Track.Name || Item.Track.Class || '#' + Item.Track.Object;
      let Line = `${Event.Time.toFixed(2)} s · ${Who} · ${Event.Name}`;
      if (Event.Type === 3) {
        Line += ' · ' + Event.Sound;
        if (this.Sound && Event.Playable && this.OnSound) {
          const Voice = this.OnSound(Event);
          if (Voice) {
            this.Voices.push(Voice);
            if (Event.Text && this.OnSubtitle) { this.OnSubtitle(Event.Text); Voice.addEventListener('ended', () => { if (this.OnSubtitle) this.OnSubtitle(null); }); }
          }
        } else if (Event.Text && this.OnSubtitle) this.OnSubtitle(Event.Text);
      } else if (Event.Type === 7) Line += ' · ' + Event.Message;
      else if (Event.Type === 1) Line += ' · ' + Event.Animation;
      else if (Event.Type === 5) Line += ' · ' + Event.State;
      this.Log.push(Line);
    }
    if (this.Log.length > 60) this.Log.splice(0, this.Log.length - 60);
  }
}
