/*
 * RiotParticles — efeitos de partículas no visor / particle effects in the viewport
 *
 * PT: Simula os emissores de Scene.Effects (montados por Riot/RiotEffects.py, parâmetros em metros/segundos) e os
 *     desenha como quadrados virados para a câmera. Um "pool" (uma malha instanciada) por textura + mistura.
 *     Cor do passe como no motor: saturate(2 × textura × cor), conta feita em gama (a textura é lida sem
 *     conversão sRGB e o resultado vai direto para a tela). Sem colisão com o chão (o motor também não testa).
 *     Efeitos que o jogo só liga por mensagem (relé, STOMP) aparecem quando "Mostrar efeitos desligados" está
 *     marcado; os de duração curta (faíscas, explosões) repetem a cada poucos segundos para dar para ver.
 * EN: Simulates Scene.Effects emitters and draws camera-facing quads, one instanced pool per texture + blend.
 *     Pass colour as in the engine: saturate(2 × texture × colour) in gamma space. No ground collision (the
 *     engine has none either). Message-triggered effects show when "Show effects that start off" is on; short
 *     bursts repeat every few seconds so they can be seen.
 */
class RiotParticlePool {
  constructor(Map, Blend, Flip) {
    this.Capacity = 256;
    this.Count = 0;
    const Quad = new THREE.InstancedBufferGeometry();
    Quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    Quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.Geometry = Quad;
    this.Allocate(this.Capacity);
    const Blends = {
      0: { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor },
      1: { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor },
      2: { blending: THREE.CustomBlending, blendEquation: THREE.ReverseSubtractEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor },
    };
    this.Material = new THREE.ShaderMaterial(Object.assign({
      uniforms: { Map: { value: Map }, Grid: { value: Flip ? Math.round(Math.sqrt(Flip.Grid)) : 1 } },
      vertexShader: `
        attribute vec4 Center;   // xyz, half size
        attribute vec4 Shape;    // rotation, squash, frame, mirror
        attribute vec4 Tint;
        uniform float Grid;
        varying vec2 vUv;
        varying vec4 vTint;
        void main() {
          vec4 View = modelViewMatrix * vec4(Center.xyz, 1.0);
          float C = cos(Shape.x), S = sin(Shape.x);
          vec2 Corner = vec2(position.x, position.y * Shape.y);
          View.xy += vec2(C * Corner.x - S * Corner.y, S * Corner.x + C * Corner.y) * Center.w;
          gl_Position = projectionMatrix * View;
          vec2 Uv = vec2(position.x * Shape.w * 0.5 + 0.5, 0.5 - position.y * 0.5);
          float Column = mod(Shape.z, Grid), Row = floor(Shape.z / Grid);
          vUv = (vec2(Column, Row) + Uv) / Grid;
          vTint = Tint;
        }`,
      fragmentShader: `
        uniform sampler2D Map;
        varying vec2 vUv;
        varying vec4 vTint;
        void main() {
          vec4 Texel = texture2D(Map, vUv);
          float Alpha = Texel.a * vTint.a;
          if (Alpha < 0.004) discard;
          gl_FragColor = vec4(clamp(2.0 * Texel.rgb * vTint.rgb, 0.0, 1.0), Alpha);
        }`,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    }, Blends[Blend] || Blends[0]));
    this.Mesh = new THREE.Mesh(this.Geometry, this.Material);
    this.Mesh.frustumCulled = false;
    this.Mesh.renderOrder = 5;
    this.Mesh.userData.Particles = true;
  }

  Allocate(Capacity) {
    this.Capacity = Capacity;
    this.CenterData = new Float32Array(Capacity * 4);
    this.ShapeData = new Float32Array(Capacity * 4);
    this.TintData = new Float32Array(Capacity * 4);
    for (const [Name, Data] of [['Center', this.CenterData], ['Shape', this.ShapeData], ['Tint', this.TintData]]) {
      const Attribute = new THREE.InstancedBufferAttribute(Data, 4);
      Attribute.setUsage(THREE.DynamicDrawUsage);
      this.Geometry.setAttribute(Name, Attribute);
    }
  }

  Push(X, Y, Z, Size, Rotation, Squash, Frame, Mirror, R, G, B, A) {
    if (this.Count >= this.Capacity) {
      if (this.Capacity >= 65536) return;
      const Old = [this.CenterData, this.ShapeData, this.TintData];
      this.Allocate(this.Capacity * 2);
      this.CenterData.set(Old[0]); this.ShapeData.set(Old[1]); this.TintData.set(Old[2]);
    }
    const O = this.Count++ * 4;
    this.CenterData[O] = X; this.CenterData[O + 1] = Y; this.CenterData[O + 2] = Z; this.CenterData[O + 3] = Size;
    this.ShapeData[O] = Rotation; this.ShapeData[O + 1] = Squash; this.ShapeData[O + 2] = Frame; this.ShapeData[O + 3] = Mirror;
    this.TintData[O] = R; this.TintData[O + 1] = G; this.TintData[O + 2] = B; this.TintData[O + 3] = A;
  }

  Upload() {
    this.Geometry.instanceCount = this.Count;
    for (const Name of ['Center', 'Shape', 'Tint']) this.Geometry.attributes[Name].needsUpdate = true;
    this.Mesh.visible = this.Count > 0;
  }

  Dispose() {
    this.Geometry.dispose();
    this.Material.dispose();
  }
}

class RiotParticles {
  constructor(LevelView) {
    this.View = LevelView;
    this.Group = new THREE.Group();
    this.Group.name = 'Particles';
    this.On = true;
    this.ShowOff = false;    // PT: mostrar também os que começam desligados (o selecionado sempre toca) / EN: also preview the ones that start off (the selected one always plays)
    this.Emitters = [];
    this.Pools = new Map();
    this.Maps = new Map();
    this.Time = 0;
    this.MaxPerEmitter = 600;
  }

  // ------------------------------------------------------------------ montar / build
  Clear() {
    for (const Pool of this.Pools.values()) { this.Group.remove(Pool.Mesh); Pool.Dispose(); }
    for (const Map of this.Maps.values()) Map.dispose();
    this.Pools = new Map();
    this.Maps = new Map();
    this.Emitters = [];
    if (this.Group.parent) this.Group.parent.remove(this.Group);
  }

  /** PT: textura sem conversão sRGB (a conta do passe é em gama). EN: texture without sRGB decode (gamma maths). */
  MapFor(Code) {
    if (this.Maps.has(Code)) return this.Maps.get(Code);
    const Info = this.View.TextureInfo.get(Code);
    let Map = null;
    if (Info) {
      Map = new THREE.DataTexture(Info.Pixels, Info.Width, Info.Height, THREE.RGBAFormat);
      Map.magFilter = THREE.LinearFilter;
      Map.minFilter = THREE.LinearMipmapLinearFilter;
      Map.generateMipmaps = true;
      Map.wrapS = Map.wrapT = THREE.ClampToEdgeWrapping;
      Map.needsUpdate = true;
    }
    this.Maps.set(Code, Map);
    return Map;
  }

  PoolFor(Code, Blend, Flip) {
    const Key = Code + '|' + Blend + '|' + (Flip ? Flip.Grid : 1);
    if (!this.Pools.has(Key)) {
      const Map = this.MapFor(Code);
      if (!Map) { this.Pools.set(Key, null); return null; }
      const Pool = new RiotParticlePool(Map, Blend, Flip);
      this.Pools.set(Key, Pool);
      this.Group.add(Pool.Mesh);
    }
    return this.Pools.get(Key);
  }

  Build(Scene) {
    this.Clear();
    this.View.Viewport.Scene.add(this.Group);
    this.Group.visible = this.On;
    for (const Effect of Scene.Effects || []) {
      const Matrix = this.MatrixOf(Effect);
      if (Effect.Kind === 'Generator') {
        for (const Child of Effect.Children) {
          const Emitter = this.MakeEmitter(Child, Effect, Matrix);
          if (!Emitter) continue;
          // PT: o gerador dispara o efeito a cada p7 ± p8 s / EN: the generator fires the effect every p7 ± p8 s
          Emitter.Generator = { Every: Effect.Every, Next: Math.random() * Effect.Every[0], StartsOn: Effect.On };
          Emitter.Active = false;
          Emitter.StartsOn = Effect.On;
          this.Emitters.push(Emitter);
        }
        continue;
      }
      const Emitter = this.MakeEmitter(Effect, Effect, Matrix);
      if (Emitter) this.Emitters.push(Emitter);
    }
  }

  MatrixOf(Effect) {
    const Instance = Effect.N >= 0 && this.View.Scene.Instances[Effect.N];
    return this.View.InstanceMatrix(Instance || [null, Effect.Pos, Effect.Rot, Effect.Scale], new THREE.Matrix4());
  }

  Place(Emitter, Matrix) {
    const E = Matrix.elements;
    Emitter.Matrix = Matrix;
    Emitter.Origin.set(E[12], E[13], E[14]);
    if (Emitter.Effect.Axes) Emitter.Axes = Emitter.Effect.Axes.map(Index => new THREE.Vector3(E[4 * Index], E[4 * Index + 1], E[4 * Index + 2]).normalize());
  }

  /** PT: A instância andou (gizmo, desfazer). EN: The instance moved (gizmo, undo). */
  Moved(Number) {
    let Matrix = null;
    for (const Emitter of this.Emitters) {
      if (Emitter.Owner.N !== Number) continue;
      Matrix = Matrix || this.MatrixOf(Emitter.Owner);
      this.Place(Emitter, Matrix.clone());
    }
  }

  /** PT: Cópia colada: o efeito vai junto. EN: Pasted copy: the effect comes along. */
  Copied(SourceNumber, Number) {
    const Instance = this.View.Scene.Instances[Number];
    const Owners = new Map();
    for (const Emitter of this.Emitters.filter(Item => Item.Owner.N === SourceNumber)) {
      if (!Owners.has(Emitter.Owner)) Owners.set(Emitter.Owner, Object.assign({}, Emitter.Owner, { N: Number, Id: Instance[6] }));
      const Owner = Owners.get(Emitter.Owner);
      const Copy = this.MakeEmitter(Emitter.Effect, Owner, this.MatrixOf(Owner));
      if (!Copy) continue;
      if (Emitter.Generator) { Copy.Generator = Object.assign({}, Emitter.Generator); Copy.Active = false; Copy.StartsOn = Emitter.StartsOn; }
      this.Emitters.push(Copy);
    }
  }

  MakeEmitter(Effect, Owner, Matrix) {
    const Pools = Effect.Tex.map(Code => this.PoolFor(Code, Effect.Kind === 'Billboard' ? 1 : Effect.Blend, Effect.Flip)).filter(Boolean);
    if (!Pools.length) return null;
    const E = Matrix.elements;
    const Axis = Index => new THREE.Vector3(E[4 * Index], E[4 * Index + 1], E[4 * Index + 2]).normalize();
    const ObjectScale = Math.max(Math.abs(Owner.Scale[0]), Math.abs(Owner.Scale[1]), Math.abs(Owner.Scale[2])) || 1;
    const Emitter = {
      Effect, Owner, Pools, Matrix, Origin: new THREE.Vector3(E[12], E[13], E[14]),
      Axes: Effect.Axes ? Effect.Axes.map(Axis) : null, Particles: [], Acc: 0, Active: Effect.On !== false, StartsOn: Effect.On !== false,
      RunFor: Effect.Duration > 0 ? Effect.Duration : Infinity, Rest: 0, Scale: Effect.Kind === 'Fountain' ? ObjectScale : 1,
      Box: null, Light: null,
    };
    if (Effect.Box && Owner.N >= 0 && this.View.ModelVerts) {
      const Instance = this.View.Scene.Instances[Owner.N], Vertices = Instance && this.View.ModelVerts.get(Instance[0]);
      if (Vertices && !Vertices.Box.isEmpty()) Emitter.Box = Vertices.Box.clone();
    }
    if (Effect.Lit) {
      const World = this.View.WorldLightAt(Emitter.Origin);
      const Light = [0.6, 0.6, 0.6];
      if (World) for (let C = 0; C < 3; C++) Light[C] = Math.min(1, World.A[C] + (World.D ? 0.6 * World.D[3 + C] : 0));
      Emitter.Light = Light;
    }
    return Emitter;
  }

  SetOn(On) {
    this.On = On;
    this.Group.visible = On;
    if (!On) for (const Emitter of this.Emitters) Emitter.Particles.length = 0;
  }

  SetShowOff(Show) {
    this.ShowOff = Show;
    for (const Emitter of this.Emitters) if (!Emitter.StartsOn) Emitter.Particles.length = 0;
  }

  // ------------------------------------------------------------------ simular / simulate
  Visible(Emitter) {
    const Owner = Emitter.Owner;
    if (Owner.N >= 0 && Owner.N === this.SelectedNumber) return !this.View.Hidden.has(Owner.N);
    if (!Emitter.StartsOn && !this.ShowOff) return false;
    if (Owner.Dormant && !this.View.ShowDormant) return this.ShowOff;
    if (Owner.N >= 0 && this.View.Hidden.has(Owner.N)) return false;
    return true;
  }

  Frame(Delta) {
    if (!this.On || !this.View.Scene || !this.Emitters.length) return;
    const Dt = Math.min(0.1, Math.max(0, Delta || 0));
    this.Time += Dt;
    const Camera = this.View.Viewport.Camera;
    const CameraPosition = Camera.position;
    for (const Pool of this.Pools.values()) if (Pool) Pool.Count = 0;
    const ViewMatrix = Camera.matrixWorldInverse;
    this.SelectedNumber = this.View.Selected ? this.View.SelectedNumber() : null;
    for (const Emitter of this.Emitters) {
      if (!this.Visible(Emitter)) { Emitter.Particles.length = 0; continue; }
      const Distance = CameraPosition.distanceTo(Emitter.Origin);
      if (Emitter.Effect.Kind === 'Billboard') { this.DrawBillboard(Emitter, Distance); continue; }
      if (Emitter.Effect.Kind === 'Cone') { this.DrawCone(Emitter, ViewMatrix); continue; }
      this.Update(Emitter, Dt, Distance);
      this.Draw(Emitter, ViewMatrix);
    }
    for (const Pool of this.Pools.values()) if (Pool) Pool.Upload();
  }

  Lod(Effect, Distance) {
    const [Near, Far] = Effect.Lod;
    return Distance <= Near ? 1 : Distance >= Far ? 0 : (Far - Distance) / (Far - Near);
  }

  Update(Emitter, Dt, Distance) {
    const Effect = Emitter.Effect;
    if (Emitter.Generator) {
      const Generator = Emitter.Generator;
      Generator.Next -= Dt;
      if (Generator.Next <= 0) {
        const [Low, High] = Generator.Every;
        Generator.Next = Low + Math.random() * (High - Low);
        Emitter.Active = true;
        Emitter.RunFor = Effect.Duration > 0 ? Effect.Duration : Math.min(Generator.Next, 2);
      }
    } else if (!Emitter.Active || Emitter.RunFor <= 0) {
      // PT: rajada já acabou: repete depois de uma pausa (só no editor) / EN: burst over: repeat after a pause (editor only)
      Emitter.Rest -= Dt;
      if (Emitter.Rest <= 0 && Emitter.Particles.length === 0) {
        Emitter.Active = true;
        Emitter.RunFor = Effect.Duration > 0 ? Effect.Duration : Infinity;
      }
    }
    if (Emitter.Active) {
      Emitter.RunFor -= Dt;
      if (Emitter.RunFor <= 0) { Emitter.Active = false; Emitter.Rest = 1.5; }
      const Rate = Effect.Rate * (Emitter.Generator ? 1 : this.Lod(Effect, Distance));
      if (Rate > 0) {
        Emitter.Acc += Rate * Dt;
        let Guard = 0;
        while (Emitter.Acc >= 1 && Guard++ < 400) { Emitter.Acc -= 1; this.Emit(Emitter); }
      } else Emitter.Acc = 0;
    }
    const Gravity = Effect.Gravity * Dt;
    const List = Emitter.Particles;
    for (let Index = List.length - 1; Index >= 0; Index--) {
      const P = List[Index];
      P.Age += Dt;
      if (P.Age >= P.Life) { List[Index] = List[List.length - 1]; List.pop(); continue; }
      P.V.y -= Gravity;
      P.P.addScaledVector(P.V, Dt);
      P.Rotation += P.Spin * Dt;
    }
  }

  Emit(Emitter) {
    if (Emitter.Particles.length >= this.MaxPerEmitter) return;
    const Effect = Emitter.Effect;
    const Random = (Low, High) => Low + Math.random() * (High - Low);
    const [A, U, W] = Emitter.Axes;
    let Position;
    if (Emitter.Box) {
      const B = Emitter.Box;
      Position = new THREE.Vector3(Random(B.min.x, B.max.x), Random(B.min.y, B.max.y), Random(B.min.z, B.max.z)).applyMatrix4(Emitter.Matrix);
    } else Position = Emitter.Origin.clone();
    const Velocity = new THREE.Vector3();
    if (Effect.Cone > 0 || Effect.Kind === 'Simple') {
      // PT: cone em volta do eixo principal (TTB, deduzido) / EN: cone around the primary axis (TTB, inferred)
      const Open = THREE.MathUtils.degToRad(Effect.Cone) * Math.sqrt(Math.random()), Turn = Math.random() * Math.PI * 2;
      const Direction = A.clone().multiplyScalar(Math.cos(Open)).addScaledVector(U, Math.sin(Open) * Math.cos(Turn)).addScaledVector(W, Math.sin(Open) * Math.sin(Turn));
      Velocity.addScaledVector(Direction, Random(Effect.Speed[0], Effect.Speed[1]));
    } else {
      // PT: disco de raio p3 nos eixos u/v + velocidade no eixo principal e radial (TS1) / EN: TS1 disc + axial and radial speed
      const Angle = THREE.MathUtils.degToRad(Effect.Disc) * Math.random();
      const Radial = U.clone().multiplyScalar(Math.cos(Angle)).addScaledVector(W, Math.sin(Angle));
      Position.addScaledVector(Radial, Effect.Radius * Math.sqrt(Math.random()) * Emitter.Scale);
      Velocity.addScaledVector(A, Random(Effect.Speed[0], Effect.Speed[1])).addScaledVector(Radial, Effect.Radial * Math.random());
    }
    const Life = Math.max(Random(Effect.Life[0], Effect.Life[1]), Effect.FadeFraction ? 0 : Effect.FadeOut, 0.02);
    const Spin = THREE.MathUtils.degToRad(Random(Effect.Spin[0], Effect.Spin[1])) * (Effect.SpinSign && Math.random() < 0.5 ? -1 : 1);
    Emitter.Particles.push({
      P: Position, V: Velocity, Age: 0, Life,
      Size: Random(Effect.Size[0], Effect.Size[1]) * Emitter.Scale,
      Rotation: THREE.MathUtils.degToRad(Random(Effect.Rot0[0], Effect.Rot0[1])), Spin,
      Pool: Emitter.Pools[(Math.random() * Emitter.Pools.length) | 0],
    });
  }

  Draw(Emitter, ViewMatrix) {
    const Effect = Emitter.Effect;
    const E = ViewMatrix.elements;
    for (const P of Emitter.Particles) {
      const T = P.Age / P.Life;
      let FadeIn = Effect.FadeIn, FadeOut = Effect.FadeOut;
      if (Effect.FadeFraction) { FadeIn *= P.Life; FadeOut *= P.Life; }
      const Alpha = (FadeIn > 0 ? Math.min(1, P.Age / FadeIn) : 1) * (FadeOut > 0 ? Math.min(1, Math.max(0, P.Life - P.Age) / FadeOut) : 1);
      let Size = Effect.EndSize != null ? P.Size * (1 + (Effect.EndSize - 1) * T) : Math.max(0, P.Size + Effect.Grow * Emitter.Scale * P.Age);
      if (Size <= 0 || Alpha <= 0) continue;
      let R, G, B;
      if (Emitter.Light) { R = Effect.Color0[0] * Emitter.Light[0]; G = Effect.Color0[1] * Emitter.Light[1]; B = Effect.Color0[2] * Emitter.Light[2]; }
      else {
        R = Effect.Color0[0] + (Effect.Color1[0] - Effect.Color0[0]) * T;
        G = Effect.Color0[1] + (Effect.Color1[1] - Effect.Color0[1]) * T;
        B = Effect.Color0[2] + (Effect.Color1[2] - Effect.Color0[2]) * T;
      }
      let Rotation = P.Rotation, Squash = 1, Mirror = 1;
      if (Effect.Streak) {
        // PT: rastro: o quadrado vira na direção da velocidade na tela e achata quando vem para a câmera
        // EN: streak: the quad turns along the on-screen velocity and flattens when flying at the camera
        const Speed = P.V.length();
        let Nx = 1, Ny = 0, Nz = 0;
        if (Speed > 1e-9) {
          const X = -P.V.x / Speed, Y = -P.V.y / Speed, Z = -P.V.z / Speed;
          Nx = E[0] * X + E[4] * Y + E[8] * Z; Ny = E[1] * X + E[5] * Y + E[9] * Z; Nz = E[2] * X + E[6] * Y + E[10] * Z;
        }
        const Cx = E[0] * P.P.x + E[4] * P.P.y + E[8] * P.P.z + E[12], Cy = E[1] * P.P.x + E[5] * P.P.y + E[9] * P.P.z + E[13];
        const Cz = E[2] * P.P.x + E[6] * P.P.y + E[10] * P.P.z + E[14];
        const Tx = Cx + Nx * Size, Ty = Cy + Ny * Size, Tz = Cz + Nz * Size;
        const Wx = Tx / -Tz - Cx / -Cz, Wy = Ty / -Tz - Cy / -Cz;
        if (Wx * Wx + Wy * Wy > 1e-20) Rotation = Math.atan2(-Wx, Wy);
        Squash = Math.max(0, 0.99 - Math.abs(Nz));
        Mirror = -1;
      }
      let Frame = 0;
      if (Effect.Flip) Frame = Effect.Flip.Start + (Math.floor(P.Age * Effect.Flip.Fps) % Effect.Flip.Frames);
      P.Pool.Push(P.P.x, P.P.y, P.P.z, Size, Rotation, Squash, Frame, Mirror, R, G, B, Alpha);
    }
  }

  /**
   * PT: Billboard Light Cone da TTB (SufferingTTB.exe 0x4B5990): billboards no eixo p0 da matriz, meia largura = raio
   *     local, alfa de cada um vindo do servidor; perto da câmera o alfa cai em (profundidade − 0,15625) / (0,75 × raio).
   * EN: TTB Billboard Light Cone: billboards along the p0 matrix axis, half width = local radius; near-camera fade.
   */
  DrawCone(Emitter, ViewMatrix) {
    const Effect = Emitter.Effect, M = Emitter.Matrix.elements, E = ViewMatrix.elements, I = Effect.Axis;
    const Dx = M[4 * I] * Effect.Sign * Effect.Length, Dy = M[4 * I + 1] * Effect.Sign * Effect.Length, Dz = M[4 * I + 2] * Effect.Sign * Effect.Length;
    const O = Emitter.Origin, [R0, R1] = Effect.Radius, C = Effect.Color0, Pool = Emitter.Pools[0];
    for (let K = 0; K < Effect.Steps.length; K++) {
      const T = Effect.Steps[K];
      let Alpha = Effect.Alphas[K];
      if (Alpha <= 0) continue;
      const X = O.x + Dx * T, Y = O.y + Dy * T, Z = O.z + Dz * T, Radius = R0 + (R1 - R0) * T;
      const Depth = -(E[2] * X + E[6] * Y + E[10] * Z + E[14]) - 0.15625;
      if (Depth <= 0) continue;
      if (Depth < 0.75 * Radius) Alpha *= Depth / (0.75 * Radius);
      Pool.Push(X, Y, Z, Radius, 0, 1, 0, 1, C[0], C[1], C[2], Alpha);
    }
  }

  DrawBillboard(Emitter, Distance) {
    const Effect = Emitter.Effect;
    if (Distance > Effect.Far) return;
    const Fade = Math.min(1, (Effect.Far - Distance) / Math.max(1, Effect.Far * 0.25));
    const Size = Math.min(Effect.Size[1], Math.max(Effect.Size[0], Effect.Size[0] + (Effect.Size[1] - Effect.Size[0]) * Distance / Effect.Far));
    const O = Emitter.Origin;
    Emitter.Pools[0].Push(O.x, O.y, O.z, Size * 0.5, 0, 1, 0, 1, 0.5, 0.5, 0.5, Fade);
  }

  Count() {
    let Total = 0;
    for (const Pool of this.Pools.values()) if (Pool) Total += Pool.Count;
    return Total;
  }
}
