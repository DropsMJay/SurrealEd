/*
 * RiotGltfExport — exporta modelos e animações para glTF 2.0 binário (.glb) / exports models and animations to .glb
 *
 * PT: Usa só os dados lidos do jogo (os mesmos que o visor mostra):
 *       • malha: um primitivo por grupo de material, posições, normais e UVs da LOD 0, como no .mdu;
 *       • texturas: PNG na orientação normal (o .tdu é guardado de baixo para cima; os UVs são invertidos em v junto);
 *       • esqueleto (0x0208): um nó por osso na pose de referência, matrizes inversas de bind do próprio arquivo,
 *         todos os pesos de cada vértice (JOINTS_n / WEIGHTS_n em grupos de 4, sem descartar nenhum);
 *         vértices sem peso ficam presos a um osso extra "Unskinned" na origem (no jogo eles não se movem);
 *       • animação (.adu): as chaves exatas de cada trilha (rotação; posição quando a trilha tem), interpolação linear,
 *         como o visor. Ossos sem trilha ficam na pose de referência.
 *     O modo de mistura do jogo vai em material.extras.RiotBlend; aditivo/subtrativo etc. viram BLEND sem luz.
 * EN: Exports exactly the data read from the game: LOD 0 mesh, upright PNG textures (v flipped with them), the
 *     skeleton with the file's inverse bind matrices and every weight, and the exact animation keys (linear).
 *     Bones without a track keep the bind pose. The game's blend mode goes into material.extras.RiotBlend.
 */
const RiotGltfExport = (() => {
  const Float = 5126, UnsignedShort = 5123, ArrayBufferTarget = 34962;

  class GlbWriter {
    constructor() {
      this.Json = { asset: { version: '2.0', generator: 'SurrealEd (RiotTools)' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [],
        materials: [], textures: [], images: [], samplers: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] };
      this.Chunks = [];
      this.Length = 0;
    }

    View(Bytes, Target) {
      while (this.Length % 4) { this.Chunks.push(new Uint8Array(1)); this.Length++; }
      const View = { buffer: 0, byteOffset: this.Length, byteLength: Bytes.byteLength };
      if (Target) View.target = Target;
      this.Chunks.push(new Uint8Array(Bytes.buffer, Bytes.byteOffset, Bytes.byteLength));
      this.Length += Bytes.byteLength;
      this.Json.bufferViews.push(View);
      return this.Json.bufferViews.length - 1;
    }

    Accessor(Array_, Type, ComponentType, Options = {}) {
      const Size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[Type];
      const Accessor = { bufferView: this.View(Array_, Options.Target), componentType: ComponentType, count: Array_.length / Size, type: Type };
      if (Options.MinMax) {
        const Min = new Array(Size).fill(Infinity), Max = new Array(Size).fill(-Infinity);
        for (let Index = 0; Index < Array_.length; Index++) { const Axis = Index % Size; Min[Axis] = Math.min(Min[Axis], Array_[Index]); Max[Axis] = Math.max(Max[Axis], Array_[Index]); }
        Accessor.min = Min; Accessor.max = Max;
      }
      this.Json.accessors.push(Accessor);
      return this.Json.accessors.length - 1;
    }

    Node(Node) { this.Json.nodes.push(Node); return this.Json.nodes.length - 1; }

    Blob() {
      const Json = this.Json;
      Json.buffers[0].byteLength = this.Length;
      for (const Node of Json.nodes) if (Node.children && !Node.children.length) delete Node.children;
      Json.scenes[0].nodes = Json.scenes[0].nodes.filter(Index => Json.nodes[Index].children || Json.nodes[Index].mesh !== undefined);
      for (const Key of ['materials', 'textures', 'images', 'samplers', 'meshes', 'accessors', 'bufferViews']) if (!Json[Key].length) delete Json[Key];
      if (!this.Length) delete Json.buffers;
      let JsonText = JSON.stringify(Json);
      while (JsonText.length % 4) JsonText += " ";
      const JsonBytes = new TextEncoder().encode(JsonText);
      const BinLength = (this.Length + 3) & ~3;
      const Total = 12 + 8 + JsonBytes.length + (this.Length ? 8 + BinLength : 0);
      const Header = new DataView(new ArrayBuffer(20));
      Header.setUint32(0, 0x46546C67, true); Header.setUint32(4, 2, true); Header.setUint32(8, Total, true);
      Header.setUint32(12, JsonBytes.length, true); Header.setUint32(16, 0x4E4F534A, true);
      const Parts = [Header.buffer, JsonBytes];
      if (this.Length) {
        const BinHeader = new DataView(new ArrayBuffer(8));
        BinHeader.setUint32(0, BinLength, true); BinHeader.setUint32(4, 0x004E4942, true);
        Parts.push(BinHeader.buffer, ...this.Chunks, new Uint8Array(BinLength - this.Length));
      }
      return new Blob(Parts, { type: 'model/gltf-binary' });
    }
  }

  /** PT: PNG em pé de uma textura decodificada (linhas do .tdu de baixo para cima). EN: Upright PNG bytes. */
  async function UprightPng(Info) {
    const Canvas = document.createElement('canvas');
    Canvas.width = Info.Width; Canvas.height = Info.Height;
    const Image_ = new ImageData(Info.Width, Info.Height), Row = Info.Width * 4;
    for (let Y = 0; Y < Info.Height; Y++) Image_.data.set(Info.Pixels.subarray((Info.Height - 1 - Y) * Row, (Info.Height - Y) * Row), Y * Row);
    Canvas.getContext('2d').putImageData(Image_, 0, 0);
    const Blob_ = await new Promise(Resolve => Canvas.toBlob(Resolve, 'image/png'));
    return new Uint8Array(await Blob_.arrayBuffer());
  }

  /** PT: Material glTF a partir do grupo (mesmas regras do visor). EN: glTF material from a group (viewer rules). */
  function MaterialOf(Group, TextureInfo, TextureIndex) {
    const Info = Group.tex ? TextureInfo.get(Group.tex) : null;
    const Material = { name: Group.tex ? 'Texture ' + Group.tex : 'Untextured', doubleSided: true,
      pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 }, extras: { RiotBlend: Group.b || (Group.mask ? 'mask' : 'default') } };
    if (TextureIndex !== undefined) Material.pbrMetallicRoughness.baseColorTexture = { index: TextureIndex };
    else Material.pbrMetallicRoughness.baseColorFactor = [0.54, 0.545, 0.518, 1];
    const Special = ['sub', 'add', 'mulA', 'mod2x', 'oneA', 'mul'].includes(Group.b);
    const Alpha = Group.mask || !Info ? 0 : Info.AlphaKind;
    if (Special) { Material.alphaMode = 'BLEND'; Material.extensions = { KHR_materials_unlit: {} }; }
    else if (Group.b === 'opaque' || !Info) Material.alphaMode = 'OPAQUE';
    else if (Group.b === 'cutout' || (Group.b === 'alpha' && Info.AlphaBits === 1) || (!Group.b && Alpha)) { Material.alphaMode = 'MASK'; Material.alphaCutoff = 200 / 255; }
    else if (Group.b === 'alpha') Material.alphaMode = 'BLEND';
    else if (Alpha) { Material.alphaMode = 'MASK'; Material.alphaCutoff = 0.5; }
    return { Material, Unlit: Special };
  }

  function Decompose(Matrix) {
    const T = new THREE.Vector3(), R = new THREE.Quaternion(), S = new THREE.Vector3();
    Matrix.decompose(T, R, S);
    return { translation: T.toArray(), rotation: R.toArray(), scale: S.toArray() };
  }

  /**
   * PT: Grava o modelo (e, se vier, a animação) num .glb. Object = ModelObject da aba (dados originais em Object.Source).
   * EN: Writes the model (and optionally one animation) to a .glb blob.
   */
  async function Export(Object_, Animation, Name) {
    const Writer = new GlbWriter(), Json = Writer.Json;
    const { Info, Buffer, TextureInfo } = Object_.Source;
    const Root = Writer.Node({ name: Name });
    Json.scenes[0].nodes.push(Root);
    Json.nodes[Root].children = [];

    // PT: texturas, uma vez cada / EN: textures, once each
    const TextureOf = new Map();
    for (const Group of Info.Groups) {
      if (!Group.n || !Group.tex || TextureOf.has(Group.tex) || !TextureInfo.get(Group.tex)) continue;
      if (!Json.samplers.length) Json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
      const Png = await UprightPng(TextureInfo.get(Group.tex));
      Json.images.push({ name: Group.tex, mimeType: 'image/png', bufferView: Writer.View(Png) });
      Json.textures.push({ sampler: 0, source: Json.images.length - 1 });
      TextureOf.set(Group.tex, Json.textures.length - 1);
    }

    // PT: esqueleto / EN: skeleton
    let Joints = null, UnskinnedJoint = -1, Skin = -1;
    const Skeleton = Info.Skeleton;
    if (Skeleton) {
      const Bones = Skeleton.Bones;
      Joints = Bones.map((Bone, Index) => Writer.Node(Object.assign({ name: 'Bone' + String(Index).padStart(3, '0') + '_' + (Bone.Id >>> 0).toString(16).toUpperCase().padStart(8, '0') },
        Decompose(Object_.LocalBind[Index]))));
      Bones.forEach((Bone, Index) => {
        if (Bone.Parent >= 0) (Json.nodes[Joints[Bone.Parent]].children = Json.nodes[Joints[Bone.Parent]].children || []).push(Joints[Index]);
        else Json.nodes[Root].children.push(Joints[Index]);
      });
      // PT: algum canto sem peso? / EN: any corner without weights?
      let NeedsUnskinned = false;
      for (const Group of Info.Groups) {
        if (!Group.n) continue;
        if (Group.vo < 0) { NeedsUnskinned = true; break; }
        const Indexes = new Float32Array(Buffer, Group.vo, Group.n);
        for (let Corner = 0; Corner < Group.n && !NeedsUnskinned; Corner++) {
          const List = Skeleton.Weights[Indexes[Corner]];
          if (!List || !List.some((Value, Item) => Item % 2 === 1 && Value > 0)) NeedsUnskinned = true;
        }
        if (NeedsUnskinned) break;
      }
      if (NeedsUnskinned) { UnskinnedJoint = Writer.Node({ name: 'Unskinned' }); Json.nodes[Root].children.push(UnskinnedJoint); }
      const Count = Bones.length + (NeedsUnskinned ? 1 : 0);
      const Inverse = new Float32Array(Count * 16);
      Object_.InverseBind.forEach((Matrix, Index) => Inverse.set(Matrix.elements, Index * 16));
      if (NeedsUnskinned) Inverse.set(new THREE.Matrix4().elements, Bones.length * 16);
      Json.skins = [{ name: Name + ' skeleton', joints: NeedsUnskinned ? [...Joints, UnskinnedJoint] : Joints, inverseBindMatrices: Writer.Accessor(Inverse, 'MAT4', Float) }];
      Skin = 0;
    }

    // PT: malha: um primitivo por grupo / EN: mesh: one primitive per group
    const Primitives = [];
    const MaterialIndex = new Map();
    let NeedsUnlit = false;
    for (const Group of Info.Groups) {
      if (!Group.n) continue;
      const Positions = new Float32Array(Buffer, Group.po, Group.n * 3).slice();
      const Packed = new Int8Array(Buffer, Group.no, Group.n * 4);
      const Normals = new Float32Array(Group.n * 3);
      for (let Corner = 0; Corner < Group.n; Corner++) {
        const X = Packed[4 * Corner] / 127, Y = Packed[4 * Corner + 1] / 127, Z = Packed[4 * Corner + 2] / 127, Length = Math.hypot(X, Y, Z) || 1;
        Normals[3 * Corner] = X / Length; Normals[3 * Corner + 1] = Y / Length; Normals[3 * Corner + 2] = Z / Length;
      }
      const Attributes = { POSITION: Writer.Accessor(Positions, 'VEC3', Float, { MinMax: true, Target: ArrayBufferTarget }),
        NORMAL: Writer.Accessor(Normals, 'VEC3', Float, { Target: ArrayBufferTarget }) };
      if (Group.uo >= 0) {
        const Uvs = new Float32Array(Buffer, Group.uo, Group.n * 2).slice();
        for (let Corner = 0; Corner < Group.n; Corner++) Uvs[2 * Corner + 1] = 1 - Uvs[2 * Corner + 1];   // PT: PNG em pé / EN: upright PNG
        Attributes.TEXCOORD_0 = Writer.Accessor(Uvs, 'VEC2', Float, { Target: ArrayBufferTarget });
      }
      if (Skeleton) {
        const Indexes = Group.vo >= 0 ? new Float32Array(Buffer, Group.vo, Group.n) : null;
        const Lists = [];
        let Sets = 1;
        for (let Corner = 0; Corner < Group.n; Corner++) {
          const List = Indexes ? Skeleton.Weights[Indexes[Corner]] : null;
          const Pairs = [];
          // PT: pesos 0 não mudam nada e ficam de fora / EN: zero weights change nothing and are left out
          if (List && List.length) for (let Item = 0; Item < List.length; Item += 2) if (List[Item + 1] > 0) Pairs.push([List[Item], List[Item + 1]]);
          if (!Pairs.length) Pairs.push([Skeleton.Bones.length, 1]);
          Pairs.sort((A, B) => B[1] - A[1]);
          const Sum = Pairs.reduce((Total, Pair) => Total + Pair[1], 0) || 1;
          for (const Pair of Pairs) Pair[1] /= Sum;   // PT: o visor também divide pela soma / EN: the viewer normalises too
          Lists.push(Pairs);
          Sets = Math.max(Sets, Math.ceil(Pairs.length / 4));
        }
        for (let Set = 0; Set < Sets; Set++) {
          const JointsArray = new Uint16Array(Group.n * 4), WeightsArray = new Float32Array(Group.n * 4);
          Lists.forEach((Pairs, Corner) => {
            for (let Slot = 0; Slot < 4; Slot++) {
              const Pair = Pairs[Set * 4 + Slot];
              if (Pair) { JointsArray[4 * Corner + Slot] = Pair[0]; WeightsArray[4 * Corner + Slot] = Pair[1]; }
            }
          });
          Attributes['JOINTS_' + Set] = Writer.Accessor(JointsArray, 'VEC4', UnsignedShort, { Target: ArrayBufferTarget });
          Attributes['WEIGHTS_' + Set] = Writer.Accessor(WeightsArray, 'VEC4', Float, { Target: ArrayBufferTarget });
        }
      }
      const Key = `${Group.tex}|${Group.b}|${Group.mask}`;
      if (!MaterialIndex.has(Key)) {
        const { Material, Unlit } = MaterialOf(Group, TextureInfo, TextureOf.get(Group.tex));
        NeedsUnlit = NeedsUnlit || Unlit;
        Json.materials.push(Material);
        MaterialIndex.set(Key, Json.materials.length - 1);
      }
      Primitives.push({ attributes: Attributes, material: MaterialIndex.get(Key), mode: 4 });
    }
    if (!Primitives.length) throw new Error(Text('ExportEmpty'));
    Json.meshes.push({ name: Name, primitives: Primitives });
    // PT: malha com pele na raiz da cena (o glTF ignora os pais dela) / EN: skinned mesh node at the scene root
    const MeshNode = Writer.Node({ name: Name + ' mesh', mesh: 0 });
    if (Skin >= 0) Json.nodes[MeshNode].skin = Skin;
    Json.scenes[0].nodes.push(MeshNode);
    if (NeedsUnlit) Json.extensionsUsed = ['KHR_materials_unlit'];

    // PT: animação: chaves exatas das trilhas / EN: animation: the tracks' exact keys
    if (Animation && Skeleton) {
      const Samplers = [], Channels = [];
      const Add = (Node, Path, Times, Values, Type) => {
        Samplers.push({ input: Writer.Accessor(Times, 'SCALAR', Float, { MinMax: true }), output: Writer.Accessor(Values, Type, Float), interpolation: 'LINEAR' });
        Channels.push({ sampler: Samplers.length - 1, target: { node: Node, path: Path } });
      };
      Skeleton.Bones.forEach((Bone, Index) => {
        const Track = Animation.Tracks[String(Bone.Id)];
        if (!Track || !Track.Keys.length) return;
        const Keys = Track.Keys, Stride = Track.Stride, Count = Keys.length / Stride;
        const Times = new Float32Array(Count), Rotations = new Float32Array(Count * 4), Translations = new Float32Array(Count * 3);
        for (let Key = 0; Key < Count; Key++) {
          const Base = Key * Stride;
          Times[Key] = Math.max(0, Keys[Base]);
          const Q = new THREE.Quaternion(Keys[Base + 1], Keys[Base + 2], Keys[Base + 3], Keys[Base + 4]).normalize();
          Rotations.set([Q.x, Q.y, Q.z, Q.w], Key * 4);
          if (Stride === 8) Translations.set([Keys[Base + 5], Keys[Base + 6], Keys[Base + 7]], Key * 3);
          else if (Track.Rest) Translations.set(Track.Rest, Key * 3);
        }
        // PT: o glTF exige tempos estritamente crescentes / EN: glTF needs strictly increasing times
        for (let Key = 1; Key < Count; Key++) if (Times[Key] <= Times[Key - 1]) Times[Key] = Times[Key - 1] + 1e-4;
        // PT: o visor usa escala 1 nos ossos animados / EN: the viewer uses scale 1 on animated bones
        Add(Joints[Index], 'rotation', Times, Rotations, 'VEC4');
        Add(Joints[Index], 'translation', Times, Translations, 'VEC3');
        const Scale = Json.nodes[Joints[Index]].scale;
        if (Scale.some(Value => Math.abs(Value - 1) > 1e-4)) Add(Joints[Index], 'scale', Times, new Float32Array(Count * 3).fill(1), 'VEC3');
      });
      if (Channels.length) Json.animations = [{ name: Animation.Ref, samplers: Samplers, channels: Channels,
        extras: { RiotDuration: Animation.Duration, RiotLoop: Animation.Loop, RiotPlaysOnce: Boolean(Animation.PlaysOnce),
          RiotEvents: (Animation.Events || []).map(Event => ({ Time: Event.Time, Type: Event.Type, Code: Event.Code, Bone: Event.Bone, Name: Event.Name || undefined })) } }];
    }
    return Writer.Blob();
  }

  function Download(Blob_, FileName) {
    const Link = document.createElement('a');
    Link.href = URL.createObjectURL(Blob_);
    Link.download = FileName;
    Link.click();
    setTimeout(() => URL.revokeObjectURL(Link.href), 4000);
  }

  return { Export, Download };
})();
