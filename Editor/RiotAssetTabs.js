/*
 * RiotAssetTabs — abas Texturas, Modelos e Animação / Textures, Models and Animation tabs
 *
 * PT: Navegadores dos recursos dos pacotes (Riot/RiotAssets.py no servidor):
 *       Texturas  grade com miniaturas (carregadas sob demanda), visualização com zoom, canais RGB/alfa, salvar PNG
 *       Modelos   lista do pacote, visor 3D com materiais do jogo, wireframe, esqueleto e a tabela de LOD
 *       Animação  lista do pacote, modelo compatível (mesmos ossos), reprodução com linha do tempo e eventos
 *     Esqueleto: as matrizes do 0x0208 são de bind inversa (modelo -> osso); as chaves são locais ao pai;
 *     pele: v' = Σ peso · Mundo_osso(t) · BindInversa_osso · v (como no visualizador de cenas).
 * EN: Package asset browsers backed by Riot/RiotAssets.py. Skinning: v' = Σ w · World_bone(t) · InvBind_bone · v.
 */
const RiotAssetTabs = (() => {
  const $ = Id => document.getElementById(Id);
  let Ui = null;
  let Packages = null;

  function Make(Tag, ClassName, TextValue) {
    const Item = document.createElement(Tag);
    if (ClassName) Item.className = ClassName;
    if (TextValue !== undefined && TextValue !== null) Item.textContent = TextValue;
    return Item;
  }

  function InfoGrid(Rows) {
    const Grid = Make('dl', 'InfoGrid');
    for (const [Label, Value] of Rows) {
      if (Value === undefined || Value === null || Value === '') continue;
      Grid.append(Make('dt', null, Label), Make('dd', null, String(Value)));
    }
    return Grid;
  }

  function Table(Headers, Rows, OnClick) {
    const Element = Make('table', 'InfoTable');
    const Head = Make('tr');
    for (const Header of Headers) Head.appendChild(Make('th', null, Header));
    Element.appendChild(Head);
    for (const Row of Rows) {
      const Line = Make('tr', OnClick && Row.Click ? 'Link' : '');
      for (const Cell of Row.Cells) Line.appendChild(Make('td', null, Cell));
      if (OnClick && Row.Click) Line.addEventListener('click', () => OnClick(Row.Click));
      Element.appendChild(Line);
    }
    return Element;
  }

  function SplitRef(Code) {
    const [Package, Index] = Code.split('_');
    return [Number(Package), parseInt(Index, 16)];
  }

  // ------------------------------------------------------------------ pacotes / packages
  async function LoadPackages() {
    if (!Packages) Packages = await Ui.FetchJson('/api/Packages');
    return Packages;
  }

  /** PT: Preenche um <select> com os pacotes que têm Field > 0, agrupados como no disco. EN: Fills a package <select>. */
  function FillPackageSelect(Select, Field, Preferred) {
    Select.innerHTML = '';
    const Groups = [['Common', 'GroupCommon'], ['World', 'GroupWorld'], ['Chapter', 'GroupChapter'], ['Level', 'GroupLevel'], ['Other', 'GroupOther']];
    let Chosen = null;
    for (const [Group, Key] of Groups) {
      const List = Packages.filter(Package => Package.Group === Group && Package[Field] > 0);
      if (!List.length) continue;
      const Optgroup = document.createElement('optgroup');
      Optgroup.label = Text(Key);
      for (const Package of List) {
        const Option = Make('option', null, `${Package.Name} (${Package.Id}) · ${NumberText(Package[Field])}`);
        Option.value = Package.Id;
        Optgroup.appendChild(Option);
        if (Chosen === null || Package.Name === Preferred) Chosen = Package.Id;
      }
      Select.appendChild(Optgroup);
    }
    const Saved = Remember('Package' + Field);
    if (Saved && Packages.some(Package => String(Package.Id) === Saved && Package[Field] > 0)) Chosen = Number(Saved);
    if (Chosen !== null) Select.value = String(Chosen);
  }

  function Remember(Key, Value) {
    try {
      if (Value === undefined) return localStorage.getItem('SurrealEd' + Key);
      localStorage.setItem('SurrealEd' + Key, String(Value));
    } catch (Error) { /* sem armazenamento / no storage */ }
    return null;
  }

  // ------------------------------------------------------------------ materiais / materials
  /** PT: Texturas e materiais de um modelo (mesmas regras da aba Fase, sem a luz pré-calculada). EN: Model materials. */
  class MaterialFactory {
    constructor(TextureInfo) {
      this.TextureInfo = TextureInfo;
      this.Cache = new Map();
      this.Grey = new THREE.MeshLambertMaterial({ color: 0x8a8b84, side: THREE.DoubleSide });
    }
    Texture(Code) {
      if (!Code) return null;
      if (!this.Cache.has(Code)) {
        const Info = this.TextureInfo.get(Code);
        if (!Info) return null;
        const Texture = new THREE.DataTexture(Info.Pixels, Info.Width, Info.Height, THREE.RGBAFormat);
        Texture.wrapS = Texture.wrapT = THREE.RepeatWrapping;
        Texture.magFilter = THREE.LinearFilter;
        Texture.minFilter = THREE.LinearMipmapLinearFilter;
        Texture.generateMipmaps = true;
        Texture.encoding = THREE.sRGBEncoding;
        Texture.anisotropy = 4;
        Texture.needsUpdate = true;
        this.Cache.set(Code, Texture);
      }
      return this.Cache.get(Code);
    }
    For(Group) {
      const Info = this.TextureInfo.get(Group.tex);
      const Alpha = Group.mask || !Info ? 0 : Info.AlphaKind;
      const Map = this.Texture(Group.tex);
      const Modes = {
        sub: [THREE.ReverseSubtractEquation, THREE.SrcAlphaFactor, THREE.OneFactor], add: [THREE.AddEquation, THREE.SrcAlphaFactor, THREE.OneFactor],
        mulA: [THREE.AddEquation, THREE.ZeroFactor, THREE.SrcAlphaFactor], mod2x: [THREE.AddEquation, THREE.DstColorFactor, THREE.SrcColorFactor],
        oneA: [THREE.AddEquation, THREE.OneFactor, THREE.SrcAlphaFactor], mul: [THREE.AddEquation, THREE.ZeroFactor, THREE.SrcColorFactor],
      }[Group.b];
      if (Map && Modes) return new THREE.MeshBasicMaterial({ map: Map, side: THREE.DoubleSide, transparent: true, depthWrite: false,
        blending: THREE.CustomBlending, blendEquation: Modes[0], blendSrc: Modes[1], blendDst: Modes[2], premultipliedAlpha: false });
      if (!Map) return this.Grey.clone();
      // PT: mesma regra da aba Fase: o modo do material decide / EN: same rule as the Level tab
      if (Group.b === 'opaque') return new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide });
      if (Group.b === 'cutout' || (Group.b === 'alpha' && Info && Info.AlphaBits === 1)) return new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, alphaTest: 200 / 255 });
      if (!Group.b) return new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, alphaTest: Alpha ? 200 / 255 : 0 });
      if (Group.b === 'alpha') return new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, transparent: true, depthWrite: false, alphaTest: 0.02 });
      return new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, alphaTest: Alpha && Group.b !== 'opaque' ? 0.4 : Alpha ? 0.5 : 0 });
    }
    Dispose() { for (const Texture of this.Cache.values()) Texture.dispose(); this.Cache.clear(); }
  }

  // ------------------------------------------------------------------ modelo 3D / 3D model
  /**
   * PT: Monta um modelo (grupos por material) num THREE.Group. Com esqueleto, guarda a pose de referência por vértice
   *     para refazer a pele a cada quadro (CPU, como no visualizador de cenas).
   * EN: Builds a model into a THREE.Group; skinned models keep per-vertex bind data for CPU skinning.
   */
  class ModelObject {
    constructor(Info, Buffer, TextureInfo) {
      this.Info = Info;
      this.Source = { Info, Buffer, TextureInfo };   // PT: dados originais (exportar) / EN: original data (export)
      this.Root = new THREE.Group();
      this.Meshes = [];
      this.Materials = new MaterialFactory(TextureInfo);
      const Count = Info.Vertices;
      this.BindPositions = new Float32Array(Count * 3);
      this.BindNormals = new Float32Array(Count * 3);
      for (const Group of Info.Groups) {
        if (!Group.n) continue;
        const Points = new Float32Array(Buffer, Group.po, Group.n * 3);
        const Packed = new Int8Array(Buffer, Group.no, Group.n * 4);
        const Indexes = Group.vo >= 0 ? new Float32Array(Buffer, Group.vo, Group.n) : null;
        const Geometry = new THREE.BufferGeometry();
        const Positions = new Float32Array(Points);
        const Normals = new Float32Array(Group.n * 3);
        for (let Corner = 0; Corner < Group.n; Corner++) {
          Normals[3 * Corner] = Packed[4 * Corner] / 127; Normals[3 * Corner + 1] = Packed[4 * Corner + 1] / 127; Normals[3 * Corner + 2] = Packed[4 * Corner + 2] / 127;
          if (Indexes) {
            const Vertex = Indexes[Corner];
            for (let Axis = 0; Axis < 3; Axis++) { this.BindPositions[3 * Vertex + Axis] = Points[3 * Corner + Axis]; this.BindNormals[3 * Vertex + Axis] = Normals[3 * Corner + Axis]; }
          }
        }
        Geometry.setAttribute('position', new THREE.BufferAttribute(Positions, 3));
        Geometry.setAttribute('normal', new THREE.BufferAttribute(Normals, 3));
        if (Group.uo >= 0) Geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(Buffer, Group.uo, Group.n * 2), 2));
        const Mesh = new THREE.Mesh(Geometry, this.Materials.For(Group));
        Mesh.frustumCulled = false;
        Mesh.userData = { Group, Indexes, MakePlain: () => this.Materials.Grey.clone() };
        if (Group.b) Mesh.renderOrder = 2;
        this.Root.add(Mesh);
        this.Meshes.push(Mesh);
      }
      const Box = Info.Box;
      this.Box = new THREE.Box3(new THREE.Vector3(Box[0], Box[1], Box[2]), new THREE.Vector3(Box[3], Box[4], Box[5]));
      if (Info.Skeleton) this.SetupSkeleton(Info.Skeleton);
    }

    SetupSkeleton(Skeleton) {
      const Bones = Skeleton.Bones;
      this.Bones = Bones;
      this.InverseBind = Bones.map(Bone => { const M = Bone.Matrix, Matrix = new THREE.Matrix4(); Matrix.set(M[0], M[1], M[2], M[3], M[4], M[5], M[6], M[7], M[8], M[9], M[10], M[11], 0, 0, 0, 1); return Matrix; });
      this.Bind = this.InverseBind.map(Matrix => Matrix.clone().invert());
      this.LocalBind = Bones.map((Bone, Index) => Bone.Parent >= 0 ? this.Bind[Bone.Parent].clone().invert().multiply(this.Bind[Index]) : this.Bind[Index].clone());
      this.World = Bones.map(() => new THREE.Matrix4());
      this.Skin = Bones.map(() => new THREE.Matrix4());
      // PT: ordem com pais antes dos filhos / EN: parents before children
      const Order = [], Done = new Set();
      const Visit = Index => { if (Done.has(Index)) return; const Parent = Bones[Index].Parent; if (Parent >= 0) Visit(Parent); Done.add(Index); Order.push(Index); };
      Bones.forEach((_Bone, Index) => Visit(Index));
      this.Order = Order;
      this.Weights = Skeleton.Weights;
      this.Posed = new Float32Array(this.BindPositions.length);
      this.PosedNormals = new Float32Array(this.BindNormals.length);
      this.SkeletonLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe0a33c, depthTest: false, transparent: true }));
      this.SkeletonLines.renderOrder = 10;
      this.SkeletonLines.visible = false;
      this.SkeletonLines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Bones.length * 6), 3));
      this.Root.add(this.SkeletonLines);
      for (let Index = 0; Index < Bones.length; Index++) this.World[Index].copy(this.Bind[Index]);
      this.UpdateSkeletonLines();
    }

    UpdateSkeletonLines() {
      if (!this.SkeletonLines) return;
      const Array_ = this.SkeletonLines.geometry.attributes.position.array, A = new THREE.Vector3(), B = new THREE.Vector3();
      this.Bones.forEach((Bone, Index) => {
        B.setFromMatrixPosition(this.World[Index]);
        if (Bone.Parent >= 0) A.setFromMatrixPosition(this.World[Bone.Parent]); else A.copy(B);
        Array_.set([A.x, A.y, A.z, B.x, B.y, B.z], Index * 6);
      });
      this.SkeletonLines.geometry.attributes.position.needsUpdate = true;
    }

    /**
     * PT: Aplica uma animação no tempo Time. InPlace tira o deslocamento horizontal da raiz.
     * EN: Poses the skeleton from an animation at Time; InPlace removes the root's horizontal travel.
     */
    Pose(Animation, Time, InPlace) {
      if (!this.Bones) return;
      const Local = new THREE.Matrix4(), Q = new THREE.Quaternion(), QA = new THREE.Quaternion(), QB = new THREE.Quaternion(), V = new THREE.Vector3();
      let Pelvis = -1;
      for (const Index of this.Order) {
        const Bone = this.Bones[Index], Parent = Bone.Parent;
        const Track = Animation ? Animation.Tracks[String(Bone.Id)] : null;
        const Has = Track && Track.Keys.length;
        if (!Has && Animation && Pelvis >= 0 && Parent >= 0 && this.Bones[Parent].Parent < 0) {
          // PT: filhos diretos da raiz sem trilha seguem a pelve (ex.: raios do Killjoy) / EN: untracked root children follow the pelvis
          this.World[Index].multiplyMatrices(this.World[Pelvis], this.InverseBind[Pelvis]).multiply(this.Bind[Index]);
        } else {
          if (Has) {
            const Keys = Track.Keys, Stride = Track.Stride, KeyCount = Keys.length / Stride;
            let Low = 0, High = KeyCount - 1;
            while (Low < High) { const Middle = (Low + High + 1) >> 1; if (Keys[Middle * Stride] <= Time) Low = Middle; else High = Middle - 1; }
            const A = Low * Stride, B = Math.min(Low + 1, KeyCount - 1) * Stride;
            const Span = Keys[B] - Keys[A];
            const U = Span > 0 ? Math.min(1, Math.max(0, (Time - Keys[A]) / Span)) : 0;
            // PT: normalizadas antes: com chaves quase iguais e norma > 1, o slerp do three.js devolvia a 1ª sem interpolar
            // EN: normalised first: with near-equal keys of norm > 1, three.js slerp returned the first key unchanged
            QA.set(Keys[A + 1], Keys[A + 2], Keys[A + 3], Keys[A + 4]).normalize(); QB.set(Keys[B + 1], Keys[B + 2], Keys[B + 3], Keys[B + 4]).normalize();
            Q.copy(QA).slerp(QB, U).normalize();
            if (Stride === 8) V.set(Keys[A + 5] + (Keys[B + 5] - Keys[A + 5]) * U, Keys[A + 6] + (Keys[B + 6] - Keys[A + 6]) * U, Keys[A + 7] + (Keys[B + 7] - Keys[A + 7]) * U);
            else if (Track.Rest) V.set(Track.Rest[0], Track.Rest[1], Track.Rest[2]);
            else V.set(0, 0, 0);
            // PT: "no lugar": mantém a posição horizontal da 1ª chave nos ossos de cima da hierarquia
            // EN: "in place": keep the first key's horizontal position on the top bones
            if (InPlace && Stride === 8 && (Parent < 0 || this.Bones[Parent].Parent < 0)) { V.x = Keys[5]; V.z = Keys[7]; }
            Local.makeRotationFromQuaternion(Q).setPosition(V);
          } else Local.copy(this.LocalBind[Index]);
          if (Parent >= 0) this.World[Index].multiplyMatrices(this.World[Parent], Local); else this.World[Index].copy(Local);
          if (Has && Pelvis < 0 && Parent >= 0 && this.Bones[Parent].Parent < 0) Pelvis = Index;
        }
      }
      for (let Index = 0; Index < this.Bones.length; Index++) this.Skin[Index].multiplyMatrices(this.World[Index], this.InverseBind[Index]);
      this.ApplySkin();
      this.UpdateSkeletonLines();
    }

    ApplySkin() {
      const P = this.BindPositions, N = this.BindNormals, Out = this.Posed, OutN = this.PosedNormals, Weights = this.Weights;
      const Elements = this.Skin.map(Matrix => Matrix.elements);
      for (let Vertex = 0; Vertex < Weights.length; Vertex++) {
        const List = Weights[Vertex];
        const X = P[3 * Vertex], Y = P[3 * Vertex + 1], Z = P[3 * Vertex + 2];
        const NX = N[3 * Vertex], NY = N[3 * Vertex + 1], NZ = N[3 * Vertex + 2];
        if (!List || !List.length) { Out[3 * Vertex] = X; Out[3 * Vertex + 1] = Y; Out[3 * Vertex + 2] = Z; OutN[3 * Vertex] = NX; OutN[3 * Vertex + 1] = NY; OutN[3 * Vertex + 2] = NZ; continue; }
        let SX = 0, SY = 0, SZ = 0, TX = 0, TY = 0, TZ = 0, Sum = 0;
        for (let Item = 0; Item < List.length; Item += 2) {
          const E = Elements[List[Item]], W = List[Item + 1];
          SX += (E[0] * X + E[4] * Y + E[8] * Z + E[12]) * W; SY += (E[1] * X + E[5] * Y + E[9] * Z + E[13]) * W; SZ += (E[2] * X + E[6] * Y + E[10] * Z + E[14]) * W;
          TX += (E[0] * NX + E[4] * NY + E[8] * NZ) * W; TY += (E[1] * NX + E[5] * NY + E[9] * NZ) * W; TZ += (E[2] * NX + E[6] * NY + E[10] * NZ) * W;
          Sum += W;
        }
        Sum = Sum || 1;
        Out[3 * Vertex] = SX / Sum; Out[3 * Vertex + 1] = SY / Sum; Out[3 * Vertex + 2] = SZ / Sum;
        const Length = Math.hypot(TX, TY, TZ) || 1;
        OutN[3 * Vertex] = TX / Length; OutN[3 * Vertex + 1] = TY / Length; OutN[3 * Vertex + 2] = TZ / Length;
      }
      for (const Mesh of this.Meshes) {
        const Indexes = Mesh.userData.Indexes;
        if (!Indexes) continue;
        const Position = Mesh.geometry.attributes.position.array, Normal = Mesh.geometry.attributes.normal.array;
        for (let Corner = 0; Corner < Indexes.length; Corner++) {
          const Vertex = Indexes[Corner] * 3;
          Position[3 * Corner] = Out[Vertex]; Position[3 * Corner + 1] = Out[Vertex + 1]; Position[3 * Corner + 2] = Out[Vertex + 2];
          Normal[3 * Corner] = OutN[Vertex]; Normal[3 * Corner + 1] = OutN[Vertex + 1]; Normal[3 * Corner + 2] = OutN[Vertex + 2];
        }
        Mesh.geometry.attributes.position.needsUpdate = true;
        Mesh.geometry.attributes.normal.needsUpdate = true;
      }
    }

    ShowSkeleton(Visible) { if (this.SkeletonLines) this.SkeletonLines.visible = Visible; }

    Dispose() {
      for (const Mesh of this.Meshes) { Mesh.geometry.dispose(); for (const Key of ['OriginalMaterial', 'PlainMaterial']) if (Mesh.userData[Key]) Mesh.userData[Key].dispose(); Mesh.material.dispose(); }
      if (this.SkeletonLines) { this.SkeletonLines.geometry.dispose(); this.SkeletonLines.material.dispose(); }
      this.Materials.Dispose();
    }
  }

  async function FetchModel(Code) {
    const [Package, Index] = SplitRef(Code);
    const Path = `${Package}/${Index}`;
    const Info = await Ui.FetchJson('/api/Model/' + Path);
    if (Info.Error) throw new Error(Info.Error);
    const [Geometry, Textures] = await Promise.all([Ui.FetchBuffer('/api/ModelGeometry/' + Path), Ui.FetchBuffer('/api/ModelTextures/' + Path)]);
    return new ModelObject(Info, Geometry, RiotTextureDecoder.DecodeBundle(Textures));
  }

  /** PT: Visor 3D de uma aba de recurso (grade, luz, enquadrar). EN: 3D stage of an asset tab. */
  class Stage {
    constructor(Container) {
      this.Viewport = new RiotViewport(Container);
      this.Viewport.Scene.fog = null;
      this.Viewport.Scene.background = new THREE.Color(0x15171a);
      this.Grid = new THREE.GridHelper(20, 40, 0x3a3d43, 0x24262a);
      this.Viewport.Scene.add(this.Grid);
      this.Object = null;
    }
    Set(Object_, Frame = true) {
      this.Clear();
      this.Object = Object_;
      if (!Object_) return;
      this.Viewport.Scene.add(Object_.Root);
      this.Viewport.Pickables = Object_.Meshes;
      this.Viewport.ApplyRenderMode();
      const Size = Object_.Box.getSize(new THREE.Vector3());
      const Step = Math.pow(10, Math.floor(Math.log10(Math.max(Size.x, Size.z, 0.5))));
      this.Grid.scale.setScalar(Step);
      this.Grid.position.y = Object_.Box.min.y;
      if (Frame) this.Viewport.FrameBox(Object_.Box, 1.7);
    }
    Clear() {
      if (this.Object) { this.Viewport.Scene.remove(this.Object.Root); this.Object.Dispose(); }
      this.Viewport.Pickables = [];
      this.Object = null;
    }
    SetActive(Active) { this.Viewport.Active = Active; if (Active) this.Viewport.Resize(); }
  }

  // ================================================================== Texturas / Textures
  const TextureTab = {
    Ready: false, List: [], Selected: null, Zoom: 'fit', Channel: Remember('TexChannel') || 'rgb', Decoded: new Map(), Queue: [], Running: 0, Observer: null,

    Open() {
      // PT: a mesma promessa para todos que pedem a abertura / EN: one shared promise for every caller
      if (!this.Opening) this.Opening = this.OpenOnce();
      return this.Opening;
    },

    async OpenOnce() {
      this.Ready = true;
      await LoadPackages();
      FillPackageSelect($('TexPackage'), 'Textures', 'NPCs');
      $('TexPackage').addEventListener('change', () => { Remember('PackageTextures', $('TexPackage').value); this.LoadPackage(); });
      $('TexFilter').addEventListener('input', () => this.RenderGrid());
      for (const Button of document.querySelectorAll('[data-texzoom]')) Button.addEventListener('click', () => { this.Zoom = Button.dataset.texzoom; this.Draw(); });
      for (const Button of document.querySelectorAll('[data-texchannel]')) Button.addEventListener('click', () => { this.Channel = Button.dataset.texchannel; Remember('TexChannel', this.Channel); this.Draw(); });
      $('TexTile').addEventListener('change', () => this.Draw());
      new ResizeObserver(() => { if (this.Zoom === 'fit' && this.Info) this.Draw(); }).observe($('TexStage'));
      this.Observer = new IntersectionObserver(Entries => {
        for (const Entry of Entries) if (Entry.isIntersecting) { this.Observer.unobserve(Entry.target); this.Enqueue(Entry.target); }
      }, { root: $('TexGrid'), rootMargin: '200px' });
      await this.LoadPackage();
    },

    async LoadPackage() {
      const Package = Number($('TexPackage').value);
      $('TexCount').textContent = Text('AssetLoading');
      this.List = await Ui.FetchJson('/api/Textures/' + Package);
      this.Queue = [];
      this.RenderGrid();
    },

    RenderGrid() {
      const Grid = $('TexGrid');
      const Query = $('TexFilter').value.trim().toLowerCase();
      Grid.innerHTML = '';
      const Shown = this.List.filter(Item => !Query || `${Item.Ref} ${Item.Width}x${Item.Height} ${Item.Width}×${Item.Height} ${Item.Format}`.toLowerCase().includes(Query));
      $('TexCount').textContent = Text('AssetCount', { Shown: NumberText(Shown.length), Total: NumberText(this.List.length) });
      for (const Item of Shown) {
        const Tile = Make('button', 'TexTile');
        Tile.setAttribute('role', 'option');
        Tile.setAttribute('aria-selected', String(this.Selected && this.Selected.Ref === Item.Ref));
        Tile.dataset.ref = Item.Ref;
        const Canvas = document.createElement('canvas');
        Canvas.width = Canvas.height = 96;
        Tile.append(Canvas, Make('b', null, Item.Ref), Make('span', null, `${Item.Width}×${Item.Height} ${Item.Format}`));
        Tile.addEventListener('click', () => this.Select(Item));
        Grid.appendChild(Tile);
        if (this.Decoded.has(Item.Ref)) this.Thumbnail(Canvas, this.Decoded.get(Item.Ref)); else this.Observer.observe(Tile);
      }
    },

    Enqueue(Tile) { this.Queue.push(Tile); this.Pump(); },

    async Pump() {
      while (this.Running < 6 && this.Queue.length) {
        const Tile = this.Queue.shift();
        if (!Tile.isConnected) continue;
        this.Running++;
        this.Fetch(Tile.dataset.ref).then(Info => { if (Info && Tile.isConnected) this.Thumbnail(Tile.querySelector('canvas'), Info); })
          .catch(() => {}).finally(() => { this.Running--; this.Pump(); });
      }
    },

    async Fetch(Code) {
      if (this.Decoded.has(Code)) return this.Decoded.get(Code);
      const [Package, Index] = SplitRef(Code);
      const Bundle = await Ui.FetchBuffer(`/api/Texture/${Package}/${Index}`);
      const Info = RiotTextureDecoder.DecodeBundle(Bundle).get(Code) || [...RiotTextureDecoder.DecodeBundle(Bundle).values()][0];
      this.Decoded.set(Code, Info);
      if (this.Decoded.size > 400) this.Decoded.delete(this.Decoded.keys().next().value);
      return Info;
    },

    /** PT: Imagem 2D (linhas de cima para baixo) de uma textura decodificada. EN: Top-down 2D image of a decoded texture. */
    ImageOf(Info, Channel) {
      const { Width, Height, Pixels } = Info;
      const Image = new ImageData(Width, Height);
      for (let Y = 0; Y < Height; Y++) {
        const Source = (Height - 1 - Y) * Width * 4, Target = Y * Width * 4;
        for (let X = 0; X < Width * 4; X += 4) {
          const R = Pixels[Source + X], G = Pixels[Source + X + 1], B = Pixels[Source + X + 2], A = Pixels[Source + X + 3];
          if (Channel === 'alpha') { Image.data[Target + X] = Image.data[Target + X + 1] = Image.data[Target + X + 2] = A; Image.data[Target + X + 3] = 255; }
          else { Image.data[Target + X] = R; Image.data[Target + X + 1] = G; Image.data[Target + X + 2] = B; Image.data[Target + X + 3] = Channel === 'rgb' ? 255 : A; }
        }
      }
      return Image;
    },

    Thumbnail(Canvas, Info) {
      const Source = document.createElement('canvas');
      Source.width = Info.Width; Source.height = Info.Height;
      // PT: miniatura sem alfa: em muitas texturas o alfa é máscara de brilho, não transparência
      // EN: thumbnail without alpha: in many textures alpha is a gloss mask, not transparency
      Source.getContext('2d').putImageData(this.ImageOf(Info, 'rgb'), 0, 0);
      const Context = Canvas.getContext('2d');
      Context.clearRect(0, 0, Canvas.width, Canvas.height);
      const Scale = Math.min(Canvas.width / Info.Width, Canvas.height / Info.Height);
      const W = Info.Width * Scale, H = Info.Height * Scale;
      Context.imageSmoothingQuality = 'high';
      Context.drawImage(Source, (Canvas.width - W) / 2, (Canvas.height - H) / 2, W, H);
    },

    async Select(Item) {
      this.Selected = Item;
      for (const Tile of document.querySelectorAll('.TexTile')) Tile.setAttribute('aria-selected', String(Tile.dataset.ref === Item.Ref));
      $('TexEmpty').hidden = true;
      this.Info = await this.Fetch(Item.Ref);
      if (this.Selected !== Item) return;
      this.Draw();
      this.RenderInfo();
    },

    Draw() {
      for (const Button of document.querySelectorAll('[data-texzoom]')) Button.setAttribute('aria-pressed', String(Button.dataset.texzoom === this.Zoom));
      for (const Button of document.querySelectorAll('[data-texchannel]')) Button.setAttribute('aria-pressed', String(Button.dataset.texchannel === this.Channel));
      const Info = this.Info;
      if (!Info) return;
      const Canvas = $('TexCanvas');
      const Tile = $('TexTile').checked ? 3 : 1;
      Canvas.width = Info.Width * Tile; Canvas.height = Info.Height * Tile;
      const Image = this.ImageOf(Info, this.Channel);
      const Context = Canvas.getContext('2d');
      for (let Y = 0; Y < Tile; Y++) for (let X = 0; X < Tile; X++) Context.putImageData(Image, X * Info.Width, Y * Info.Height);
      // PT: "Ajustar" amplia até caber (pixels nítidos ao ampliar) / EN: "Fit" scales to the stage (crisp pixels when enlarged)
      const Stage = $('TexStage');
      let Scale = Number(this.Zoom);
      if (this.Zoom === 'fit') Scale = Math.max(0.05, Math.min((Stage.clientWidth - 32) / Canvas.width, (Stage.clientHeight - 80) / Canvas.height));
      Canvas.style.imageRendering = Scale >= 1 ? 'pixelated' : 'auto';
      Canvas.style.width = Canvas.width * Scale + 'px';
      Canvas.style.height = Canvas.height * Scale + 'px';
    },

    /**
     * PT: Importa uma imagem para a textura: lê no navegador, ajusta para potência de 2, escolhe DXT1/DXT5, comprime
     *     (RiotTextureEncoder) e manda para o servidor, que grava o .tdu com backup do original.
     * EN: Imports an image into the texture (decode, power-of-two resize, DXT encode in the browser, server writes the .tdu).
     */
    async Import(Item, File) {
      let Bitmap;
      try { Bitmap = await createImageBitmap(File); } catch (Error) { Ui.SetStatus(Text('TexImportBad')); return; }
      const Pow2 = Value => Math.min(4096, Math.max(4, 2 ** Math.round(Math.log2(Value))));
      const Width = Pow2(Bitmap.width), Height = Pow2(Bitmap.height);
      const Canvas = document.createElement('canvas');
      Canvas.width = Width; Canvas.height = Height;
      const Context = Canvas.getContext('2d', { willReadFrequently: true });
      Context.imageSmoothingQuality = 'high';
      Context.drawImage(Bitmap, 0, 0, Width, Height);
      const Pixels = new Uint8Array(Context.getImageData(0, 0, Width, Height).data.buffer);
      const Kind = RiotTextureEncoder.AlphaKind(Pixels);
      let Format = this.ImportFormat || 'auto';
      if (Format === 'auto') Format = Item.Format === 'DXT5' || Kind === 2 ? 'dxt5' : 'dxt1';
      // PT: DXT1 com recorte só se a imagem tiver transparência / EN: DXT1 punch-through only when the image has alpha
      const Punch = Format === 'dxt1' && Kind > 0;
      // PT: DXT5 sempre com AlphaBits 4: o leitor do jogo trata DxtType 3 + AlphaBits 8 como L8 sem compressão
      // EN: DXT5 always uses AlphaBits 4: the game reads DxtType 3 + AlphaBits 8 as uncompressed L8
      const AlphaBits = Format === 'dxt1' ? (Punch ? 1 : 0) : 4;
      const Mips = Math.min(Item.Mips || 0, Math.log2(Math.min(Width, Height)) - 2);
      if ((Item.Mips || 0) !== Mips) { Ui.SetStatus(Text('TexImportTooSmall')); return; }
      Ui.SetStatus(Text('TexImporting', { Ref: Item.Ref, Width, Height, Format: Format.toUpperCase() }));
      await new Promise(Resolve => setTimeout(Resolve, 30));
      const Payload = RiotTextureEncoder.Encode(Pixels, Width, Height, Format, Punch, Mips);
      const [Package, Index] = SplitRef(Item.Ref);
      let Result;
      try {
        const Response = await fetch(`/api/ImportTexture/${Package}/${Index}?width=${Width}&height=${Height}&format=${Format}&alphabits=${AlphaBits}&mips=${Mips}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Payload });
        Result = await Response.json();
      } catch (Error) { Result = { Error: String(Error) }; }
      if (Result.Error) { Ui.SetStatus(Text('TexImportFailed', { Error: Result.Error })); return; }
      await this.Reload(Item.Ref);
      const Resized = Width !== Bitmap.width || Height !== Bitmap.height;
      Ui.SetStatus(Text('TexImported', { Ref: Item.Ref, Width, Height, Format: Format.toUpperCase(), Bytes: NumberText(Result.Bytes), Old: NumberText(Result.OldBytes) })
        + (Resized ? ' ' + Text('TexImportResized', { From: `${Bitmap.width}×${Bitmap.height}` }) : ''));
    },

    async Restore(Item) {
      const [Package, Index] = SplitRef(Item.Ref);
      const Response = await fetch(`/api/RestoreTexture/${Package}/${Index}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const Result = await Response.json();
      if (Result.Error) { Ui.SetStatus(Text('TexImportFailed', { Error: Result.Error })); return; }
      await this.Reload(Item.Ref);
      Ui.SetStatus(Text('TexRestored', { Ref: Item.Ref }));
    },

    /** PT: Relê a lista e a textura depois de gravar. EN: Reloads list and texture after a write. */
    async Reload(Code) {
      this.Decoded.delete(Code);
      Packages = null;
      await LoadPackages();
      this.List = await Ui.FetchJson('/api/Textures/' + $('TexPackage').value);
      this.RenderGrid();
      const Item = this.List.find(Entry => Entry.Ref === Code);
      if (Item) await this.Select(Item);
      if (RiotAssetTabs.OnAssetsChanged) RiotAssetTabs.OnAssetsChanged();
    },

    /** PT: "média · % quase transparente" do canal alfa. EN: alpha mean and share of nearly transparent pixels. */
    AlphaStats(Info) {
      let Sum = 0, Clear = 0;
      const Pixels = Info.Pixels, Count = Pixels.length / 4;
      for (let Number = 3; Number < Pixels.length; Number += 4) { Sum += Pixels[Number]; if (Pixels[Number] < 16) Clear++; }
      return Text('TexAlphaStatsValue', { Mean: Math.round(Sum / Count), Clear: Math.round(Clear / Count * 100) });
    },

    RenderInfo() {
      const Item = this.Selected, Info = this.Info, Panel = $('TexInfo');
      Panel.innerHTML = '';
      const Package = Packages.find(Entry => Entry.Id === SplitRef(Item.Ref)[0]);
      Panel.append(Make('div', 'InfoTitle', Item.Ref), Make('div', 'InfoSub', Package ? `${Package.Name} · ${Package.Folder}` : ''));
      Panel.appendChild(InfoGrid([
        [Text('TexSize'), `${Item.Width} × ${Item.Height}`],
        [Text('TexFormat'), Item.Format],
        [Text('TexAlphaBits'), Item.AlphaBits],
        [Text('TexAlphaUse'), Text(['AlphaNone', 'AlphaCutout', 'AlphaBlend'][Info.AlphaKind])],
        [Text('TexAlphaStats'), this.AlphaStats(Info)],
        [Text('TexFlags'), '0x' + Item.Flags.toString(16).toUpperCase()],
        [Text('TexBytes'), NumberText(Item.Bytes)],
      ]));
      Panel.appendChild(Make('p', 'Note', Text('TexAlphaNote')));
      const Actions = Make('div', 'InfoActions');
      const Save = Make('button', 'Small', Text('TexSavePng'));
      Save.addEventListener('click', () => {
        const Canvas = document.createElement('canvas');
        Canvas.width = Info.Width; Canvas.height = Info.Height;
        Canvas.getContext('2d').putImageData(this.ImageOf(Info, 'rgba'), 0, 0);
        Canvas.toBlob(Blob => { const Link = document.createElement('a'); Link.href = URL.createObjectURL(Blob); Link.download = `${Item.Ref}.png`; Link.click(); setTimeout(() => URL.revokeObjectURL(Link.href), 2000); }, 'image/png');
      });
      Actions.appendChild(Save);
      if (Item.Format === 'DXT1' || Item.Format === 'DXT5' || Item.Format === 'Palette 8-bit' || Item.Format === 'L8') {
        // PT: importar PNG/JPG (qualquer tamanho em potência de 2, maior ou menor) / EN: import an image of any power-of-two size
        const Import = Make('button', 'Small', Text('TexImport'));
        const Picker = document.createElement('input');
        Picker.type = 'file'; Picker.accept = 'image/png,image/jpeg,image/webp,image/bmp'; Picker.hidden = true;
        Picker.addEventListener('change', () => { if (Picker.files[0]) this.Import(Item, Picker.files[0]); Picker.value = ''; });
        Import.addEventListener('click', () => Picker.click());
        const Format = document.createElement('select');
        Format.className = 'TexImportFormat';
        for (const [Value, Key] of [['auto', 'TexFormatAuto'], ['dxt1', 'TexFormatDXT1'], ['dxt5', 'TexFormatDXT5']]) { const Option = Make('option', null, Text(Key)); Option.value = Value; Format.appendChild(Option); }
        Format.value = this.ImportFormat || 'auto';
        Format.addEventListener('change', () => { this.ImportFormat = Format.value; });
        Format.setAttribute('aria-label', Text('TexImportFormatLabel'));
        Actions.append(Import, Format, Picker);
        const Restore = Make('button', 'Small', Text('TexRestore'));
        Restore.hidden = true;
        Restore.addEventListener('click', () => this.Restore(Item));
        Actions.appendChild(Restore);
        const [Package, Index] = SplitRef(Item.Ref);
        Ui.FetchJson(`/api/TextureStatus/${Package}/${Index}`).then(Status => { if (Status.Changed && this.Selected === Item) { Restore.hidden = false; Panel.appendChild(Make('p', 'Note', Text('TexChangedNote'))); } }).catch(() => {});
      }
      Panel.appendChild(Actions);
      Panel.appendChild(Make('p', 'Note', Text('TexImportNote')));
      Ui.SetStatus(Text('TexStatus', { Ref: Item.Ref, Width: Item.Width, Height: Item.Height, Format: Item.Format }));
    },

    Show(Active) { if (Active) this.Open(); },
  };

  // ================================================================== Modelos / Models
  const ModelTab = {
    Ready: false, List: [], Selected: null, Stage: null, Request: 0,

    Open() {
      // PT: a mesma promessa para todos que pedem a abertura / EN: one shared promise for every caller
      if (!this.Opening) this.Opening = this.OpenOnce();
      return this.Opening;
    },

    async OpenOnce() {
      this.Ready = true;
      this.Stage = new Stage($('ModelViewport'));
      await LoadPackages();
      FillPackageSelect($('ModelPackage'), 'Models', 'NPCs');
      $('ModelPackage').addEventListener('change', () => { Remember('PackageModels', $('ModelPackage').value); this.LoadPackage(); });
      $('ModelFilter').addEventListener('input', () => this.RenderList());
      $('ModelSkinnedOnly').addEventListener('change', () => this.RenderList());
      for (const Element of document.querySelectorAll('input[name=ModelRender], #ModelWire')) Element.addEventListener('change', () => this.SyncRender());
      $('ModelBones').addEventListener('change', () => { if (this.Stage.Object) this.Stage.Object.ShowSkeleton($('ModelBones').checked); });
      $('ModelGrid').addEventListener('change', () => { this.Stage.Grid.visible = $('ModelGrid').checked; });
      await this.LoadPackage();
    },

    SyncRender() {
      const Viewport = this.Stage.Viewport;
      Viewport.RenderMode.Textured = document.querySelector('input[name=ModelRender]:checked').value === 'Textured';
      Viewport.RenderMode.Wireframe = $('ModelWire').checked;
      Viewport.ApplyRenderMode();
    },

    async LoadPackage() {
      $('ModelCount').textContent = Text('AssetLoading');
      this.List = await Ui.FetchJson('/api/Models/' + $('ModelPackage').value);
      this.RenderList();
    },

    RenderList() {
      const Query = $('ModelFilter').value.trim().toLowerCase(), SkinnedOnly = $('ModelSkinnedOnly').checked;
      const Rows = $('ModelList');
      Rows.innerHTML = '';
      const Shown = this.List.filter(Item => (!SkinnedOnly || Item.Skinned) && (!Query || `${Item.Ref} ${Item.Classes.join(' ')}`.toLowerCase().includes(Query)));
      $('ModelCount').textContent = Text('AssetCount', { Shown: NumberText(Shown.length), Total: NumberText(this.List.length) });
      for (const Item of Shown) {
        const Row = Make('div', 'AssetRow');
        Row.setAttribute('role', 'option');
        Row.tabIndex = 0;
        Row.setAttribute('aria-selected', String(this.Selected && this.Selected.Ref === Item.Ref));
        Row.dataset.ref = Item.Ref;
        const Badge = Item.Skinned ? Make('span', 'Badge Accent', Text('BadgeSkinned', { Bones: Item.Bones })) : Make('span', 'Badge', Text('BadgeStatic'));
        Row.append(Make('span', 'Ref', Item.Ref), Make('span', 'Name', Item.Classes[0] || '—'), Badge,
          Make('span', 'Sub', Text('ModelRowSub', { Vertices: NumberText(Item.Vertices), Faces: NumberText(Item.Faces), Materials: Item.Materials })));
        Row.addEventListener('click', () => this.Select(Item));
        Row.addEventListener('keydown', Event => { if (Event.key === 'Enter') this.Select(Item); });
        Rows.appendChild(Row);
      }
    },

    async Select(Item) {
      this.Selected = Item;
      for (const Row of document.querySelectorAll('#ModelList .AssetRow')) Row.setAttribute('aria-selected', String(Row.dataset.ref === Item.Ref));
      const Request = ++this.Request;
      $('ModelEmpty').hidden = false;
      $('ModelEmpty').textContent = Text('AssetLoading');
      let Object_;
      try { Object_ = await FetchModel(Item.Ref); } catch (Error) { $('ModelEmpty').textContent = Text('AssetError', { Error: Error.message }); return; }
      if (Request !== this.Request) { Object_.Dispose(); return; }
      $('ModelEmpty').hidden = true;
      this.Stage.Set(Object_);
      Object_.ShowSkeleton($('ModelBones').checked);
      this.SyncRender();
      this.RenderInfo(Item, Object_.Info);
    },

    RenderInfo(Item, Info) {
      const Panel = $('ModelInfo');
      Panel.innerHTML = '';
      const Package = Packages.find(Entry => Entry.Id === SplitRef(Item.Ref)[0]);
      Panel.append(Make('div', 'InfoTitle', `${Item.Ref}${Info.Classes[0] ? ' · ' + Info.Classes[0] : ''}`), Make('div', 'InfoSub', Package ? `${Package.Name} · ${Package.Folder}` : ''));
      const Box = Info.Box;
      Panel.appendChild(InfoGrid([
        [Text('ModelKind'), Info.Skeleton ? Text('BadgeSkinned', { Bones: Info.Skeleton.Bones.length }) : Text('BadgeStatic')],
        [Text('ModelVertices'), NumberText(Info.Vertices)],
        [Text('ModelFacesLod0'), NumberText(Info.Faces)],
        [Text('ModelSize'), [Box[3] - Box[0], Box[4] - Box[1], Box[5] - Box[2]].map(Value => NumberText(Value, 2)).join(' × ')],
        [Text('ModelUsedBy'), Info.Classes.join(', ') || '—'],
      ]));
      Panel.appendChild(Make('div', 'InfoHeading', Text('ModelMaterials')));
      Panel.appendChild(Table([Text('ColNumber'), Text('ColMaterial'), Text('ColTexture'), Text('ColBlend')],
        Info.Groups.map((Group, Number) => ({ Cells: [String(Number), Info.Materials[Number] || '—', Group.tex || '—', Group.b || (Group.mask ? 'mask' : '—')], Click: Group.tex })),
        Code => RiotAssetTabs.OpenTexture(Code)));
      const ExportActions = Make('div', 'InfoActions');
      const ExportButton = Make('button', 'Small', Text('ExportGlb'));
      ExportButton.title = Text('ExportGlbTip');
      ExportButton.addEventListener('click', () => this.Export(Item));
      ExportActions.appendChild(ExportButton);
      Panel.appendChild(ExportActions);
      if (Info.Skeleton) {
        Panel.appendChild(Make('div', 'InfoHeading', Text('ModelLods')));
        Panel.appendChild(Table([Text('ColLod'), Text('ColDistance'), Text('ModelVertices'), Text('ColFaces')],
          Info.Skeleton.Lods.map((Lod, Number) => ({ Cells: [String(Number), NumberText(Lod[0], 1), NumberText(Lod[2]), NumberText(Lod[4])] }))));
        Panel.appendChild(Make('p', 'Note', Text('ModelLodNote')));
        const Actions = Make('div', 'InfoActions');
        const Animate = Make('button', 'Small', Text('ModelOpenAnimations'));
        Animate.addEventListener('click', () => RiotAssetTabs.OpenAnimationsFor(Item.Ref));
        Actions.appendChild(Animate);
        Panel.appendChild(Actions);
      }
      Ui.SetStatus(Text('ModelStatus', { Ref: Item.Ref, Vertices: NumberText(Info.Vertices), Faces: NumberText(Info.Faces) }));
    },

    /** PT: Exporta o modelo selecionado para .glb. EN: Exports the selected model to .glb. */
    async Export(Item) {
      const Object_ = this.Stage.Object;
      if (!Object_ || this.Selected !== Item) return;
      Ui.SetStatus(Text('ExportWorking', { Ref: Item.Ref }));
      try {
        const Blob_ = await RiotGltfExport.Export(Object_, null, Item.Ref);
        RiotGltfExport.Download(Blob_, `${Item.Ref}.glb`);
        Ui.SetStatus(Text('ExportDone', { File: `${Item.Ref}.glb`, Size: NumberText(Math.round(Blob_.size / 1024)) }));
      } catch (Error) { Ui.SetStatus(Text('ExportFailed', { Error: Error.message })); }
    },

    Show(Active) { if (Active) this.Open(); if (this.Stage) this.Stage.SetActive(Active); },
  };

  // ================================================================== Animação / Animation
  const AnimationTab = {
    Ready: false, List: [], Selected: null, Stage: null, Animation: null, ModelCode: null, Time: 0, Playing: false, Request: 0, FilterModel: null,

    Open() {
      // PT: a mesma promessa para todos que pedem a abertura / EN: one shared promise for every caller
      if (!this.Opening) this.Opening = this.OpenOnce();
      return this.Opening;
    },

    async OpenOnce() {
      this.Ready = true;
      this.Stage = new Stage($('AnimViewport'));
      this.Stage.Viewport.OnFrame = Delta => this.Tick(Delta);
      await LoadPackages();
      FillPackageSelect($('AnimPackage'), 'Animations', 'NPCs');
      $('AnimPackage').addEventListener('change', () => {
        if (!$('AnimPackage').value.startsWith('model:')) { Remember('PackageAnimations', $('AnimPackage').value); this.FilterModel = null; }
        this.LoadPackage();
      });
      $('AnimFilter').addEventListener('input', () => this.RenderList());
      $('AnimModel').addEventListener('change', () => this.LoadModel($('AnimModel').value));
      $('AnimBones').addEventListener('change', () => { if (this.Stage.Object) this.Stage.Object.ShowSkeleton($('AnimBones').checked); });
      $('AnimPlay').addEventListener('click', () => this.SetPlaying(!this.Playing));
      $('AnimTime').addEventListener('input', () => { this.SetPlaying(false); this.Time = Number($('AnimTime').value); this.Apply(); });
      $('AnimInPlace').addEventListener('change', () => this.Apply());
      await this.LoadPackage();
    },

    async LoadPackage() {
      $('AnimCount').textContent = Text('AssetLoading');
      const Value = $('AnimPackage').value;
      this.Source = null;
      if (Value.startsWith('model:')) {
        // PT: animações que os templates do modelo usam, de todos os pacotes / EN: the model's animations, every package
        const [Package, Index] = SplitRef(Value.slice(6));
        const Result = await Ui.FetchJson(`/api/ModelAnimations/${Package}/${Index}`);
        this.List = Result.Animations || [];
        this.Source = Result.Source;
      } else {
        this.List = await Ui.FetchJson('/api/Animations/' + Value);
      }
      this.RenderList();
    },

    RenderList() {
      const Query = $('AnimFilter').value.trim().toLowerCase();
      const Rows = $('AnimList');
      Rows.innerHTML = '';
      const Shown = this.List.filter(Item => !Query || `${Item.Ref} ${Item.Package || ''} ${(Item.Users || []).join(' ')} ${Item.Model ? Item.Model.Ref + ' ' + Item.Model.Classes.join(' ') : ''}`.toLowerCase().includes(Query));
      $('AnimCount').textContent = Text('AssetCount', { Shown: NumberText(Shown.length), Total: NumberText(this.List.length) })
        + (this.Source === 'bones' ? ' · ' + Text('AnimByBones') : this.Source === 'templates' ? ' · ' + Text('AnimByTemplates') : '');
      for (const Item of Shown) {
        const Row = Make('div', 'AssetRow');
        Row.setAttribute('role', 'option');
        Row.tabIndex = 0;
        Row.setAttribute('aria-selected', String(this.Selected && this.Selected.Ref === Item.Ref));
        Row.dataset.ref = Item.Ref;
        const Users = Item.Users || [];
        const Who = this.Source ? Item.Package : Item.Model ? `${Item.Model.Classes[0] || Item.Model.Ref}` : Text('AnimNoModel');
        const Sub = Text('AnimRowSub', { Bones: Item.Bones, Events: Item.Events })
          + (Users.length > 1 ? ' · ' + Text('AnimUsers', { Count: Users.length }) : Users.length ? '' : ' · ' + Text('AnimGuess'));
        Row.append(Make('span', 'Ref', Item.Ref), Make('span', 'Name', Who), Make('span', 'Meta', NumberText(Item.Duration, 2) + ' s'), Make('span', 'Sub', Sub));
        Row.title = Users.length ? Text('AnimUsedBy', { Models: Users.join(', ') }) : Text('AnimGuessTitle');
        Row.addEventListener('click', () => this.Select(Item));
        Row.addEventListener('keydown', Event => { if (Event.key === 'Enter') this.Select(Item); });
        Rows.appendChild(Row);
      }
    },

    async Select(Item) {
      this.Selected = Item;
      for (const Row of document.querySelectorAll('#AnimList .AssetRow')) Row.setAttribute('aria-selected', String(Row.dataset.ref === Item.Ref));
      const [Package, Index] = SplitRef(Item.Ref);
      const Request = ++this.Request;
      const Animation = await Ui.FetchJson(`/api/Animation/${Package}/${Index}`);
      if (Request !== this.Request || Animation.Error) return;
      this.Animation = Animation;
      this.Time = 0;
      $('AnimTime').max = String(Math.max(Animation.Duration, 0.001));
      this.RenderMarks();
      const Select = $('AnimModel');
      Select.innerHTML = '';
      for (const Model of Animation.Compatible) {
        const Option = Make('option', null, `${Model.Used ? '● ' : ''}${Model.Ref} · ${Model.Classes[0] || Model.Package}${Model.Match < 1 ? ` (${Math.round(Model.Match * 100)}%)` : ''}`);
        Option.value = Model.Ref;
        Select.appendChild(Option);
      }
      const Preferred = this.FilterModel && Animation.Compatible.some(Model => Model.Ref === this.FilterModel) ? this.FilterModel
        : Animation.Compatible.some(Model => Model.Ref === this.ModelCode) ? this.ModelCode : (Animation.Compatible[0] || {}).Ref;
      if (Preferred) Select.value = Preferred;
      this.RenderInfo();
      if (!Preferred) { this.Stage.Clear(); this.ModelCode = null; $('AnimEmpty').hidden = false; $('AnimEmpty').textContent = Text('AnimNoModel'); return; }
      if (Preferred !== this.ModelCode || !this.Stage.Object) await this.LoadModel(Preferred);
      this.SetPlaying(true);
      this.Apply();
    },

    async LoadModel(Code) {
      const Request = ++this.Request;
      $('AnimEmpty').hidden = false;
      $('AnimEmpty').textContent = Text('AssetLoading');
      let Object_;
      try { Object_ = await FetchModel(Code); } catch (Error) { $('AnimEmpty').textContent = Text('AssetError', { Error: Error.message }); return; }
      if (Request !== this.Request) { Object_.Dispose(); return; }
      $('AnimEmpty').hidden = true;
      const Same = this.ModelCode === Code;
      this.ModelCode = Code;
      this.Stage.Set(Object_, !Same);
      Object_.ShowSkeleton($('AnimBones').checked);
      this.Apply();
    },

    SetPlaying(Playing) {
      this.Playing = Playing;
      $('AnimPlay').textContent = Text(Playing ? 'AnimPause' : 'AnimPlay');
      $('AnimPlay').setAttribute('aria-pressed', String(Playing));
    },

    Tick(Delta) {
      if (!this.Playing || !this.Animation) return;
      const Duration = Math.max(this.Animation.Duration, 0.001);
      this.Time += Delta * Number($('AnimSpeed').value);
      if (this.Time > Duration) {
        if ($('AnimLoop').checked) this.Time %= Duration; else { this.Time = Duration; this.SetPlaying(false); }
      }
      this.Apply();
    },

    Apply() {
      $('AnimTime').value = String(this.Time);
      $('AnimTimeLabel').textContent = `${NumberText(this.Time, 2)} / ${NumberText(this.Animation ? this.Animation.Duration : 0, 2)} s`;
      if (this.Stage && this.Stage.Object && this.Animation) this.Stage.Object.Pose(this.Animation, this.Time, $('AnimInPlace').checked);
    },

    RenderMarks() {
      const Marks = $('AnimMarks');
      Marks.innerHTML = '';
      const Duration = Math.max(this.Animation.Duration, 0.001);
      for (const Event of this.Animation.Events) {
        const Mark = Make('i', Event.Type === 0 ? 'Attached' : '');
        Mark.style.left = `${Math.min(100, Event.Time / Duration * 100)}%`;
        Mark.title = `${NumberText(Event.Time, 2)} s · ${Event.Type === 0 ? Text('EventAttached') : Text('EventMarker')} ${Event.Code}${Event.Name ? ' · ' + Event.Name : ''}`;
        Marks.appendChild(Mark);
      }
    },

    RenderInfo() {
      const Animation = this.Animation, Panel = $('AnimInfo');
      Panel.innerHTML = '';
      const Package = Packages.find(Entry => Entry.Id === SplitRef(Animation.Ref)[0]);
      Panel.append(Make('div', 'InfoTitle', Animation.Ref), Make('div', 'InfoSub', Package ? `${Package.Name} · ${Package.Folder}` : ''));
      Panel.appendChild(InfoGrid([
        [Text('AnimDuration'), NumberText(Animation.Duration, 3) + ' s'],
        [Text('AnimLoopValue'), `0x${Animation.Loop.toString(16).toUpperCase()} · ${Text(Animation.PlaysOnce ? 'AnimPlaysOnce' : 'AnimLoops')}`],
        [Text('AnimBlendTime'), Animation.BlendTime !== undefined ? NumberText(Animation.BlendTime, 3) + ' s' : null],
        [Text('AnimRate'), Animation.Rate !== undefined ? NumberText(Animation.Rate, 3) : null],
        [Text('AnimTracks'), Object.keys(Animation.Tracks).length],
        [Text('AnimMoving'), Object.values(Animation.Tracks).filter(Track => Track.Stride === 8).length],
      ]));
      const ExportActions = Make('div', 'InfoActions');
      const ExportButton = Make('button', 'Small', Text('ExportAnimGlb'));
      ExportButton.title = Text('ExportAnimGlbTip');
      ExportButton.addEventListener('click', () => this.Export());
      ExportActions.appendChild(ExportButton);
      Panel.appendChild(ExportActions);
      Panel.appendChild(Make('div', 'InfoHeading', Text('AnimEvents', { Count: Animation.Events.length })));
      if (Animation.Events.length) {
        Panel.appendChild(Table([Text('ColTime'), Text('ColType'), Text('ColCode'), Text('ColBone')], Animation.Events.map(Event => ({
          Cells: [NumberText(Event.Time, 2), Event.Type === 0 ? Text('EventAttached') : Event.Type === 1 ? Text('EventMarker') : String(Event.Type),
            Event.Type === 0 ? ((Event.Code >>> 16) + '_' + (Event.Code & 0xffff).toString(16).padStart(4, '0')) : String(Event.Code) + (Event.Name ? ' · ' + Event.Name : ''), '0x' + Event.Bone.toString(16).toUpperCase()],
          Click: Event.Time + 0.0001,
        })), Time => { this.SetPlaying(false); this.Time = Time; this.Apply(); }));
        Panel.appendChild(Make('p', 'Note', Text('AnimEventNote')));
      }
      if (Animation.Links.length) {
        Panel.appendChild(Make('div', 'InfoHeading', Text('AnimLinks')));
        Panel.appendChild(Table([Text('ColAnimation'), Text('ColValue')], Animation.Links.map(Link => ({ Cells: [Link.Ref, NumberText(Link.Value, 2)], Click: Link.Ref })),
          Code => { const Item = this.List.find(Entry => Entry.Ref === Code); if (Item) this.Select(Item); }));
        Panel.appendChild(Make('p', 'Note', Text('AnimLinkNote')));
      }
      Panel.appendChild(Make('div', 'InfoHeading', Text('AnimCompatible', { Count: Animation.Compatible.length })));
      Panel.appendChild(Table([Text('ColModel'), Text('ColClass')], Animation.Compatible.map(Model => ({ Cells: [Model.Ref, Model.Classes[0] || Model.Package], Click: Model.Ref })),
        Code => { $('AnimModel').value = Code; this.LoadModel(Code); }));
      Ui.SetStatus(Text('AnimStatus', { Ref: Animation.Ref, Duration: NumberText(Animation.Duration, 2), Tracks: Object.keys(Animation.Tracks).length }));
    },

    /** PT: Exporta o modelo escolhido com esta animação para .glb. EN: Exports the chosen model with this animation. */
    async Export() {
      const Object_ = this.Stage.Object, Animation = this.Animation;
      if (!Object_ || !Animation || !this.ModelCode) { Ui.SetStatus(Text('AnimNoModel')); return; }
      const FileName = `${this.ModelCode}_${Animation.Ref}.glb`;
      Ui.SetStatus(Text('ExportWorking', { Ref: Animation.Ref }));
      try {
        const Blob_ = await RiotGltfExport.Export(Object_, Animation, this.ModelCode);
        RiotGltfExport.Download(Blob_, FileName);
        Ui.SetStatus(Text('ExportDone', { File: FileName, Size: NumberText(Math.round(Blob_.size / 1024)) }));
      } catch (Error) { Ui.SetStatus(Text('ExportFailed', { Error: Error.message })); }
    },

    Show(Active) { if (Active) this.Open(); if (this.Stage) this.Stage.SetActive(Active); },
  };

  const Tabs = { Textures: TextureTab, Models: ModelTab, Animation: AnimationTab };

  return {
    Init(UiObject) { Ui = UiObject; },
    Has(Name) { return Boolean(Tabs[Name]); },
    /** PT: Mostra uma aba (e pausa os visores das outras). EN: Shows one tab and pauses the others' viewports. */
    Show(Name) {
      for (const [Key, Tab] of Object.entries(Tabs)) {
        $(Key === 'Animation' ? 'AnimationPane' : Key + 'Pane').hidden = Key !== Name;
        Tab.Show(Key === Name);
      }
    },
    /** PT: Registra uma aba de outro arquivo (Áudio, STOMP, Vídeo). EN: Registers a tab from another file. */
    Register(Name, Tab) { Tabs[Name] = Tab; },
    /** PT: A aba registrada com esse nome. EN: The tab registered under that name. */
    Get(Name) { return Tabs[Name] || null; },
    /** PT: Ajudas compartilhadas com as outras abas. EN: Helpers shared with the other tab files. */
    Shared: { Make, InfoGrid, Table, SplitRef, FetchModel, LoadPackages: async () => { await LoadPackages(); return Packages; }, FillPackageSelect, Remember, Ui: () => Ui,
      /** PT: Textura decodificada em ImageData (cache da aba Textures). EN: Decoded texture as ImageData. */
      async TextureImage(Code) { const Info = await TextureTab.Fetch(Code); return Info ? TextureTab.ImageOf(Info) : null; } },
    async OpenTexture(Code) {
      Ui.SelectTab('Textures');
      await TextureTab.Open();
      const Package = String(SplitRef(Code)[0]);
      if ($('TexPackage').value !== Package) { $('TexPackage').value = Package; await TextureTab.LoadPackage(); }
      const Item = TextureTab.List.find(Entry => Entry.Ref === Code);
      if (Item) { await TextureTab.Select(Item); const Tile = document.querySelector(`.TexTile[data-ref="${Code}"]`); if (Tile) Tile.scrollIntoView({ block: 'center' }); }
    },
    async OpenAnimation(Code) {
      Ui.SelectTab('Animation');
      await AnimationTab.Open();
      const Package = String(SplitRef(Code)[0]);
      if (![...$('AnimPackage').options].some(Option => Option.value === Package)) return;
      if ($('AnimPackage').value !== Package) { $('AnimPackage').value = Package; await AnimationTab.LoadPackage(); }
      $('AnimFilter').value = '';
      AnimationTab.FilterModel = null;
      AnimationTab.RenderList();
      const Item = AnimationTab.List.find(Entry => Entry.Ref === Code);
      if (Item) { await AnimationTab.Select(Item); const Row = document.querySelector(`#AnimList .AssetRow[data-ref="${Code}"]`); if (Row) Row.scrollIntoView({ block: 'center' }); }
    },
    async OpenAnimationsFor(ModelCode) {
      Ui.SelectTab('Animation');
      await AnimationTab.Open();
      AnimationTab.FilterModel = ModelCode;
      $('AnimFilter').value = '';
      const Select = $('AnimPackage');
      let Option = Select.querySelector('option[data-model]');
      if (!Option) { Option = Make('option'); Option.dataset.model = '1'; Select.insertBefore(Option, Select.firstChild); }
      Option.value = 'model:' + ModelCode;
      Option.textContent = Text('AnimModelOption', { Model: ModelCode });
      Select.value = Option.value;
      await AnimationTab.LoadPackage();
    },
    Relabel() {
      if (TextureTab.Ready && TextureTab.Selected) TextureTab.RenderInfo();
      if (ModelTab.Ready) ModelTab.RenderList();
      if (AnimationTab.Ready) { AnimationTab.RenderList(); AnimationTab.SetPlaying(AnimationTab.Playing); if (AnimationTab.Animation) AnimationTab.RenderInfo(); }
      for (const Tab of Object.values(Tabs)) if (Tab.Relabel) Tab.Relabel();
    },
    Tabs,
  };
})();
