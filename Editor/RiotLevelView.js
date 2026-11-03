/*
 * RiotLevelView — aba Fase: carrega e desenha um .lvl / Level tab: loads and draws a .lvl
 *
 * PT: Pede a cena ao servidor (/api/Level, /api/LevelGeometry, /api/LevelTextures), decodifica as texturas,
 *     monta uma InstancedMesh por grupo de material e aplica a iluminação do jogo:
 *       final = textura × min(2·pré-calculada + Σ point lights + ambiente, 1.5686) × 0.5
 *     (xvsLightPrecomputed / xvsLightPoint / xvsLightFooter; cores do jogo em espaço gama -> pow 2.2).
 *     Transformação de instância idêntica à do Suffering.exe (FUN_0045A5C0): rotação Ry·Rx·Rz com
 *     yaw = arquivo − 90°, escala nos eixos do mundo, translação.
 * EN: Requests the scene from the server, decodes textures, builds one InstancedMesh per material group and
 *     applies the game lighting formula above. Instance transform matches Suffering.exe FUN_0045A5C0.
 */
class RiotLevelView {
  constructor(Viewport, Ui) {
    this.Viewport = Viewport;
    this.Ui = Ui;
    this.Scene = null;
    this.Meshes = [];
    this.Textures = new Map();
    this.TextureInfo = new Map();
    this.Center = new THREE.Vector3();
    this.Size = new THREE.Vector3(1, 1, 1);
    this.Selected = null;
    this.Busy = false;
    this.LitWidth = 2048;
    this.Uniforms = {
      LitTexture: { value: null }, DynTexture: { value: null }, LitWidth: { value: this.LitWidth },
      UseBaked: { value: 1 }, UsePoint: { value: 1 }, Gain: { value: 1 }, Ambient: { value: 0.06 }, LightOn: { value: 1 }, SplatFadeOn: { value: 1 },
    };
    this.Grey = new THREE.MeshLambertMaterial({ color: 0x6f7068, side: THREE.DoubleSide });
    this.CellGroup = new THREE.Group();
    this.CellGroup.visible = false;
    this.Viewport.Scene.add(this.CellGroup);
    this.Cells = null;
    this.CellsKey = null;
    this.ModelVerts = null;
    this.NormalsOn = false;
    this.NormalLines = null;
    this.Overlay = null;
    this.OverlayMaterial = new THREE.MeshBasicMaterial({ color: 0xe0a33c, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false });
    this.Shadows = new RiotShadows(this);
    this.Hidden = new Set();     // PT: instâncias apagadas (ainda não gravadas) / EN: deleted, not yet saved
    this.ShowDormant = false;    // PT: objetos com a flag 0x8 ou sem 0x1 (fora do jogo no início) / EN: flag-0x8 or not shown at start
    this.ForceShown = new Set();
    this.SkyOn = true;
    this.WorldOn = true;         // PT: Ambient/Directional Light nos objetos sem luz pré-calculada / EN: on unbaked objects
    this.LightIcons = new THREE.Group();
    this.LightIcons.renderOrder = 6;
    this.Viewport.Scene.add(this.LightIcons);
    this.Viewport.Markers = this.LightIcons.children;
    this.LightIconOf = new Map();
    this.IconSize = 0.06;        // PT: tamanho dos ícones (fração da altura da tela) / EN: icon size (fraction of the view height)
    try { this.IconSize = Number(localStorage.getItem('SurrealEdIconSize') || 0.06) || 0.06; } catch (Error) { /* sem armazenamento / no storage */ }
    this.Animated = [];          // PT: materiais animados da fase / EN: the level's animated materials
    this.AnimateOn = true;
    this.Stomp = new RiotStompPlayer(this, this.Viewport);
    this.Particles = new RiotParticles(this);   // PT: efeitos (RiotParticles.js) / EN: particle effects
    this.Viewport.OnFrame = Delta => { this.AnimateMaterials(); this.UpdateLightIcons(); this.Stomp.Frame(Delta); this.Particles.Frame(Delta); this.Shadows.Update(this.Viewport.Renderer, this.Viewport.Camera); };
  }

  // ------------------------------------------------------------------ materiais animados / animated materials
  /**
   * PT: Liga a animação do grupo ao material: troca de quadros (Animating Material: quadro = floor(t × fps) mod n)
   *     ou UV (Advanced Material: uv × escala + deslocamento + curva de rolagem do .wdu em fmod(t, duração)).
   *     A rolagem usa uma cópia da textura (mesma imagem na GPU) para ter o próprio deslocamento.
   * EN: Hooks a group's animation to its material: frame swap, or UV scale + offset + .wdu scroll curve.
   */
  AttachAnimation(Material, Group, Waves) {
    const Animation = Group.an;
    if (!Animation || !Material.map) return;
    if (Animation.fr) {
      const Frames = Animation.fr.map(Code => this.Texture(Code)).filter(Boolean);
      if (Frames.length > 1) this.Animated.push({ Material, Frames, Fps: Animation.fps || 15, Shown: -1 });
      return;
    }
    const Map = Material.map.clone();
    Map.needsUpdate = true;
    Material.map = Map;
    const Scale = Animation.k || 1, Offset = Animation.o || [0, 0];
    Map.repeat.set(Scale, Scale);
    Map.offset.set(Offset[0], Offset[1]);
    const Wave = Animation.sc && Waves ? Waves[Animation.sc] : null;
    const Entry = { Material, Map, Offset, Clone: true };
    if (Wave) {
      const [Rate, Channels, Data, Duration] = Wave;
      Entry.Wave = { Rate, Channels, Data, Count: Math.floor(Data.length / Channels) };
      Entry.Wave.Duration = Duration || Entry.Wave.Count / Rate;
    }
    this.Animated.push(Entry);
  }

  static WaveAt(Wave, Time, Channel) {
    if (Channel >= Wave.Channels) return 0;
    const X = (((Time % Wave.Duration) + Wave.Duration) % Wave.Duration) * Wave.Rate;
    const I = Math.min(Wave.Count - 1, Math.floor(X)), J = Math.min(Wave.Count - 1, I + 1), K = X - Math.floor(X);
    return Wave.Data[I * Wave.Channels + Channel] * (1 - K) + Wave.Data[J * Wave.Channels + Channel] * K;
  }

  AnimateMaterials() {
    if (!this.Animated.length) return;
    const Time = this.AnimateOn ? this.Viewport.Clock.elapsedTime : 0;
    for (const Entry of this.Animated) {
      if (Entry.Frames) {
        const Frame = Math.floor(Time * Entry.Fps) % Entry.Frames.length;
        if (Frame !== Entry.Shown) { Entry.Material.map = Entry.Frames[Frame]; Entry.Shown = Frame; }
      } else if (Entry.Wave) {
        Entry.Map.offset.set(Entry.Offset[0] + RiotLevelView.WaveAt(Entry.Wave, Time, 0), Entry.Offset[1] + RiotLevelView.WaveAt(Entry.Wave, Time, 1));
      }
    }
  }

  // ------------------------------------------------------------------ iluminação / lighting
  Lightify(Material, Splat) {
    const Uniforms = this.Uniforms;
    const IsSplat = Splat !== undefined;
    Material.onBeforeCompile = Shader => {
      Object.assign(Shader.uniforms, Uniforms);
      if (IsSplat) {
        // PT: passada de splat do terreno: alfa por vértice × (1 − (profundidade / distância)²), como xvsLandsplatAlpha.vsh
        // EN: terrain splat pass: per-vertex alpha × (1 − (depth / distance)²), as in xvsLandsplatAlpha.vsh
        Shader.uniforms.SplatFade = { value: Splat };
        Shader.vertexShader = Shader.vertexShader.replace('#include <common>', `#include <common>
attribute float SplatAlpha; uniform float SplatFade; uniform float SplatFadeOn; varying float vSplat;`)
          .replace('#include <project_vertex>', `#include <project_vertex>
float SplatDepth = SplatFade > 0.0 && SplatFadeOn > 0.5 ? -mvPosition.z / SplatFade : 0.0;
vSplat = SplatAlpha * clamp(1.0 - SplatDepth * SplatDepth, 0.0, 1.0);`);
        Shader.fragmentShader = Shader.fragmentShader.replace('#include <common>', `#include <common>
varying float vSplat;`).replace('#include <map_fragment>', `#include <map_fragment>
diffuseColor.a = vSplat;`);
      }
      Shader.vertexShader = Shader.vertexShader.replace('#include <common>', `#include <common>
attribute float vidx; attribute float LitOffset; attribute float DynOffset; attribute float ShadowSelf; varying vec3 vShadowWorld; varying vec3 vShadowNormal; varying float vShadowReceive;
uniform sampler2D LitTexture; uniform sampler2D DynTexture; uniform float LitWidth; uniform float UseBaked; uniform float UsePoint; uniform float Ambient;
varying vec3 vLight;
vec3 FetchColor(sampler2D Source, float Index) { return texelFetch(Source, ivec2(int(mod(Index, LitWidth)), int(floor(Index / LitWidth))), 0).rgb; }`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vec3 Light = vec3(Ambient);
if (UseBaked > 0.5 && LitOffset >= 0.0) Light += 2.0 * FetchColor(LitTexture, LitOffset + vidx);
if (UsePoint > 0.5 && DynOffset >= 0.0) Light += 2.0 * FetchColor(DynTexture, DynOffset + vidx);
vLight = min(Light, vec3(1.5686));`)
        .replace('#include <project_vertex>', `#include <project_vertex>
${RiotShadows.Vertex}`);
      Shader.fragmentShader = Shader.fragmentShader.replace('#include <common>', `#include <common>
uniform float LightOn; uniform float Gain; varying vec3 vLight;
uniform int ShadowCount; uniform float ShadowDebug; uniform sampler2D ShadowAtlas; uniform mat4 ShadowMatrix[16]; uniform vec4 ShadowDir[16]; uniform vec4 ShadowCenter[16]; uniform vec2 ShadowTile[16];
varying vec3 vShadowWorld; varying vec3 vShadowNormal; varying float vShadowReceive;`)
        .replace('#include <output_fragment>', `if (LightOn > 0.5) outgoingLight = diffuseColor.rgb * pow(vLight * 0.5 * Gain, vec3(2.2));
${RiotShadows.Fragment}
#include <output_fragment>`);
    };
    Material.customProgramCacheKey = () => IsSplat ? 'RiotLitSplat' : 'RiotLit';
    return Material;
  }

  SetLighting(Baked, Point, Gain, Ambient) {
    this.Uniforms.UseBaked.value = Baked ? 1 : 0;
    this.Uniforms.UsePoint.value = Point ? 1 : 0;
    this.Uniforms.LightOn.value = Baked || Point ? 1 : 0;
    this.Uniforms.Gain.value = Gain;
    this.Uniforms.Ambient.value = Ambient;
  }

  DataTexture(Bytes, Count) {
    const Height = Math.max(1, Math.ceil(Count / this.LitWidth));
    const Data = new Uint8Array(this.LitWidth * Height * 4);
    if (Count) Data.set(Bytes.subarray(0, Count * 4));
    const Texture = new THREE.DataTexture(Data, this.LitWidth, Height, THREE.RGBAFormat);
    Texture.needsUpdate = true;
    return Texture;
  }

  // ------------------------------------------------------------------ texturas / textures
  Texture(Code) {
    if (!Code) return null;
    if (!this.Textures.has(Code)) {
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
      this.Textures.set(Code, Texture);
    }
    return this.Textures.get(Code);
  }

  BlendMaterial(Group, Unlit) {
    const Modes = {
      sub: [THREE.ReverseSubtractEquation, THREE.SrcAlphaFactor, THREE.OneFactor], add: [THREE.AddEquation, THREE.SrcAlphaFactor, THREE.OneFactor],
      mulA: [THREE.AddEquation, THREE.ZeroFactor, THREE.SrcAlphaFactor], mod2x: [THREE.AddEquation, THREE.DstColorFactor, THREE.SrcColorFactor],
      oneA: [THREE.AddEquation, THREE.OneFactor, THREE.SrcAlphaFactor], mul: [THREE.AddEquation, THREE.ZeroFactor, THREE.SrcColorFactor],
    }[Group.b];
    if (!Modes) return null;
    // PT: o motor ilumina todo passe pela luz do vértice, menos os tingidos (TintedMaterial) / EN: every pass is vertex-lit
    const Options = {
      map: this.Texture(Group.tex), side: THREE.DoubleSide, transparent: true, depthWrite: false, fog: Group.b === 'add' || Group.b === 'oneA',
      blending: THREE.CustomBlending, blendEquation: Modes[0], blendSrc: Modes[1], blendDst: Modes[2], premultipliedAlpha: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    };
    return Unlit ? new THREE.MeshBasicMaterial(Options) : this.Lightify(new THREE.MeshLambertMaterial(Options));
  }

  /**
   * PT: Passe "tingido" (Advanced p3/p4, Animating p5/p6): sem luz, textura × cor da tinta (o motor manda tinta / 2 e o
   *     estágio 1 dobra). A conta é feita em gama, por isso a cor vira linear aqui.
   * EN: Tinted pass: unlit, texture × tint colour (gamma maths, so the colour is linearised here).
   */
  TintedMaterial(Group, Map, Info, Alpha) {
    const Tint = new THREE.Color(Group.tint);
    Tint.setRGB(Math.pow(Tint.r, 2.2), Math.pow(Tint.g, 2.2), Math.pow(Tint.b, 2.2));
    let Material = Group.b ? this.BlendMaterial(Group, true) : null;
    if (!Material) {
      const Options = { map: Map, side: THREE.DoubleSide };
      if (Group.b === 'alpha' && !(Info && Info.AlphaBits === 1)) Object.assign(Options, { transparent: true, depthWrite: false, alphaTest: 0.02 });
      else if (Group.b === 'cutout' || Group.b === 'alpha' || (!Group.b && Alpha)) Options.alphaTest = 200 / 255;
      Material = new THREE.MeshBasicMaterial(Options);
    }
    Material.color.copy(Tint);
    return Material;
  }

  MaterialFor(Group, ClassName) {
    if (Group.fx) return new THREE.MeshBasicMaterial({ color: 0xff8a2a });   // PT: marcador de efeito / EN: effect marker
    const Info = this.TextureInfo.get(Group.tex);
    const Alpha = Group.mask || !Info ? 0 : Info.AlphaKind;
    const Map = this.Texture(Group.tex);
    if (Group.b === 'splat') {
      if (!Map) return null;
      return this.Lightify(new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 - (Group.order || 0) }), Group.fade || 0);
    }
    if (Map && Group.tint) return this.TintedMaterial(Group, Map, Info, Alpha);
    if (Map && Group.b) { const Blend = this.BlendMaterial(Group); if (Blend) return Blend; }
    if (!Map) return this.Lightify(this.Grey.clone());
    if (ClassName === 'Water volume')
      return new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, transparent: true, opacity: 0.6, depthWrite: false });
    if (ClassName === 'Godray / alpha' && !Group.b)
      return new THREE.MeshBasicMaterial({ map: Map, side: THREE.DoubleSide, transparent: true, depthWrite: false,
        blending: Alpha ? THREE.NormalBlending : THREE.AdditiveBlending, opacity: Alpha ? 1 : 0.8 });
    // PT: o modo do material decide, não o alpha da textura (0x48FAB0): opaco = inteiro; alpha numa textura de 1 bit = recorte
    // EN: the material mode decides, not the texture alpha: opaque = whole; alpha on a 1-bit texture = cut-out
    if (Group.b === 'opaque') return this.Lightify(new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide }));
    if (Group.b === 'cutout' || (Group.b === 'alpha' && Info && Info.AlphaBits === 1))
      return this.Lightify(new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, alphaTest: 200 / 255 }));
    // PT: sem modo conhecido (textura direta, classe sem modo): alfa = recorte, senão opaco (como o the-suffering-engine)
    // EN: no known mode: alpha = cut-out, otherwise opaque
    if (!Group.b) return this.Lightify(new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, alphaTest: Alpha ? 200 / 255 : 0 }));
    if (Group.b === 'alpha')
      return this.Lightify(new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, transparent: true, depthWrite: false, alphaTest: 0.02 }));
    return this.Lightify(new THREE.MeshLambertMaterial({ map: Map, side: THREE.DoubleSide, alphaTest: Alpha ? 0.4 : 0 }));
  }

  // ------------------------------------------------------------------ transformação / transform
  InstanceMatrix(Instance, Out) {
    const DegreesToRadians = Math.PI / 180;
    const Euler = new THREE.Euler(Instance[2][0] * DegreesToRadians, (Instance[2][1] - 90) * DegreesToRadians, Instance[2][2] * DegreesToRadians, 'YXZ');
    const Rotation = new THREE.Matrix4().makeRotationFromEuler(Euler);
    const Scale = new THREE.Matrix4().makeScale(Instance[3][0], Instance[3][1], Instance[3][2]);
    Out.multiplyMatrices(Scale, Rotation);
    Out.setPosition(Instance[1][0], Instance[1][1], Instance[1][2]);
    return Out;
  }

  // ------------------------------------------------------------------ Point Lights (no navegador / in the browser)
  /**
   * PT: Σ cor × min(I/d², 2) × max(N·L, 0) por vértice original de cada instância (aproximação do xvsLightPoint.vsh).
   *     Toda instância ganha o seu espaço na textura de luz, então editar uma luz só recalcula as instâncias perto
   *     dela (antes e depois da mudança) e reenvia a textura.
   * EN: Per original vertex of every instance (approximation of xvsLightPoint.vsh). Every instance owns a slot in the
   *     light texture, so editing a light only relights the instances near it.
   */
  LightsFromScene() {
    // PT: raio de corte do jogo (0x4C7C20): R' = √(10 × (0,33 r + 0,45 g + 0,22 b) × I) / EN: the game's cull radius
    return this.Scene.Lights.filter(Light => Light[8] !== 0 && Light[6] > 0 && (this.ShowDormant || !Light[9])).map(Light => ({ P: new THREE.Vector3(Light[0], Light[1], Light[2]),
      R: Light[3], G: Light[4], B: Light[5], I: Light[6], Cut: this.LightCut(Light) }));
  }

  LightCut(Light) { return Math.sqrt(Math.max(0, 10 * (0.33 * Light[3] + 0.45 * Light[4] + 0.22 * Light[5]) * Light[6])); }

  BuildLighting(Scene, ModelVertices) {
    const Offsets = new Array(Scene.Instances.length).fill(-1);
    let Total = 0;
    Scene.Instances.forEach((Instance, Number) => {
      const Key = Instance[0];
      if (Key !== 'terrain' && Key.split('_')[0] === String(Scene.SystemPackage)) return;
      const Vertices = ModelVertices.get(Key);
      if (!Vertices || !Vertices.Count) return;
      Offsets[Number] = Total;
      Total += Vertices.Count;
    });
    const Texture = this.DataTexture(new Uint8Array(0), Math.max(1, Total));
    this.Lighting = { Offsets, Texture, Data: Texture.image.data, Lights: this.LightsFromScene() };
    Scene.Instances.forEach((Instance, Number) => { Instance[7] = Offsets[Number]; if (Offsets[Number] >= 0) this.LightInstance(Number); });
    return Texture;
  }

  InstanceBox(Number, Out) {
    const Instance = this.Scene.Instances[Number], Vertices = this.ModelVerts.get(Instance[0]);
    return Out.copy(Vertices.Box).applyMatrix4(this.InstanceMatrix(Instance, new THREE.Matrix4()));
  }

  /** PT: Ambient/Directional Light mais perto do ponto (as regiões não estão decodificadas). EN: Nearest ambient/directional. */
  WorldLightAt(Point) {
    const World = this.Scene.WorldLights;
    if (!this.WorldOn || !World || (!World.Ambient.length && !World.Directional.length)) return null;
    const Nearest = (List, At) => {
      let Best = null, Distance = Infinity;
      for (const Item of List) { const D = Point.distanceToSquared(new THREE.Vector3(Item[At], Item[At + 1], Item[At + 2])); if (D < Distance) { Distance = D; Best = Item; } }
      return Best;
    };
    const Ambient = Nearest(World.Ambient, 4), Directional = Nearest(World.Directional, 7);
    return { A: Ambient ? Ambient.slice(0, 3) : [0, 0, 0], D: Directional ? Directional.slice(0, 6) : null };
  }

  /** PT: Refaz a luz dinâmica de tudo (depois de mudar opções). EN: Relights everything. */
  RelightAll() {
    if (!this.Lighting) return;
    this.Lighting.Lights = this.LightsFromScene();
    this.Scene.Instances.forEach((_Instance, Number) => { if (this.Lighting.Offsets[Number] >= 0) this.LightInstance(Number); });
    this.Lighting.Texture.needsUpdate = true;
  }

  /** PT: Recalcula a luz de uma instância. EN: Relights one instance. */
  LightInstance(Number) {
    const Lighting = this.Lighting, Offset = Lighting.Offsets[Number];
    if (Offset < 0) return;
    const Instance = this.Scene.Instances[Number], Vertices = this.ModelVerts.get(Instance[0]);
    const Matrix = this.InstanceMatrix(Instance, new THREE.Matrix4()), Normal3 = new THREE.Matrix3().setFromMatrix4(Matrix);
    const Box = new THREE.Box3().copy(Vertices.Box).applyMatrix4(Matrix);
    const Near = Lighting.Lights.filter(Light => Box.distanceToPoint(Light.P) < Light.Cut);
    const Data = Lighting.Data, Point = new THREE.Vector3(), Normal = new THREE.Vector3();
    // PT: sem cor pré-calculada, o motor usa ambiente + direcional (a região mais perto) / EN: unbaked: ambient + directional
    const World = Instance[5] < 0 && Instance[0] !== 'terrain' ? this.WorldLightAt(Box.getCenter(new THREE.Vector3())) : null;
    if (!Near.length && !World) { Data.fill(0, 4 * Offset, 4 * (Offset + Vertices.Count)); return; }
    for (let Vertex = 0; Vertex < Vertices.Count; Vertex++) {
      Point.fromArray(Vertices.Positions, 3 * Vertex).applyMatrix4(Matrix);
      Normal.fromArray(Vertices.Normals, 3 * Vertex).applyMatrix3(Normal3).normalize();
      let Red = 0, Green = 0, Blue = 0;
      if (World) {
        Red = World.A[0]; Green = World.A[1]; Blue = World.A[2];
        if (World.D) {
          const Facing = Math.max(0, Normal.x * World.D[0] + Normal.y * World.D[1] + Normal.z * World.D[2]);
          Red += Facing * World.D[3]; Green += Facing * World.D[4]; Blue += Facing * World.D[5];
        }
      }
      for (const Light of Near) {
        const Dx = Light.P.x - Point.x, Dy = Light.P.y - Point.y, Dz = Light.P.z - Point.z;
        const D2 = Dx * Dx + Dy * Dy + Dz * Dz;
        if (D2 >= Light.Cut * Light.Cut) continue;
        const Inverse = 1 / Math.sqrt(D2 + 1e-9);
        const Facing = Math.max((Normal.x * Dx + Normal.y * Dy + Normal.z * Dz) * Inverse, 0);
        const Weight = Math.min(Light.I / (D2 + 1e-9), 2) * Facing;
        Red += Weight * Light.R; Green += Weight * Light.G; Blue += Weight * Light.B;
      }
      const Target = 4 * (Offset + Vertex);
      Data[Target] = Math.min(255, Math.round(Red / 2 * 255));
      Data[Target + 1] = Math.min(255, Math.round(Green / 2 * 255));
      Data[Target + 2] = Math.min(255, Math.round(Blue / 2 * 255));
      Data[Target + 3] = 255;
    }
  }

  /**
   * PT: Depois de mudar luzes: recalcula as instâncias dentro das esferas dadas (posição e raio antigos e novos).
   * EN: After changing lights: relights the instances inside the given spheres (old and new position/radius).
   */
  Relight(Spheres) {
    if (!this.Lighting) return 0;
    this.Lighting.Lights = this.LightsFromScene();
    const Box = new THREE.Box3();
    let Count = 0;
    this.Scene.Instances.forEach((Instance, Number) => {
      if (this.Lighting.Offsets[Number] < 0) return;
      this.InstanceBox(Number, Box);
      if (Spheres.some(([Center, Radius]) => Box.distanceToPoint(Center) < Radius)) { this.LightInstance(Number); Count++; }
    });
    this.Lighting.Texture.needsUpdate = true;
    return Count;
  }

  /** PT: Luz (entrada de Scene.Lights) de uma instância de Point Light. EN: Scene.Lights entry of a Point Light instance. */
  LightOf(InstanceId) { return this.Scene ? this.Scene.Lights.find(Light => Light[7] === InstanceId) : null; }

  /** PT: Muda uma luz e reacende o que ela alcança. EN: Changes a light and relights what it reaches. */
  UpdateLight(InstanceId, Changes) {
    const Light = this.LightOf(InstanceId);
    if (!Light) return;
    const Before = [new THREE.Vector3(Light[0], Light[1], Light[2]), this.LightCut(Light) + 0.01];
    if (Changes.Position) [Light[0], Light[1], Light[2]] = Changes.Position;
    if (Changes.Color) [Light[3], Light[4], Light[5]] = Changes.Color;
    if (Changes.Intensity !== undefined) Light[6] = Changes.Intensity;
    if (Changes.Enabled !== undefined) Light[8] = Changes.Enabled ? 1 : 0;
    const Number = this.Scene.Instances.findIndex(Instance => Instance[6] === InstanceId);
    if (Number >= 0) this.TintLightIcon(Number, Light);
    const After = [new THREE.Vector3(Light[0], Light[1], Light[2]), this.LightCut(Light) + 0.01];
    this.Relight([Before, After]);
    if (this.Shadows) this.Shadows.Build();
  }

  /** PT: Vértices originais de cada modelo (via vidx), para as Point Lights. EN: Original vertices per model. */
  ModelVertices(Scene, Buffer) {
    const Result = new Map();
    for (const [Key, Groups] of Object.entries(Scene.Models)) {
      let Count = 0;
      for (const Group of Groups) if (Group.vo >= 0) { const Indexes = new Float32Array(Buffer, Group.vo, Group.n); for (const Index of Indexes) Count = Math.max(Count, Index + 1); }
      const Positions = new Float32Array(Count * 3), Normals = new Float32Array(Count * 3);
      const Box = new THREE.Box3();
      for (const Group of Groups) {
        if (Group.vo < 0) continue;
        const Indexes = new Float32Array(Buffer, Group.vo, Group.n), Points = new Float32Array(Buffer, Group.po, Group.n * 3), Packed = new Int8Array(Buffer, Group.no, Group.n * 4);
        for (let Corner = 0; Corner < Group.n; Corner++) {
          const Index = Indexes[Corner];
          Positions[3 * Index] = Points[3 * Corner]; Positions[3 * Index + 1] = Points[3 * Corner + 1]; Positions[3 * Index + 2] = Points[3 * Corner + 2];
          Normals[3 * Index] = Packed[4 * Corner] / 127; Normals[3 * Index + 1] = Packed[4 * Corner + 1] / 127; Normals[3 * Index + 2] = Packed[4 * Corner + 2] / 127;
        }
        for (let Corner = 0; Corner < Group.n; Corner++) Box.expandByPoint(new THREE.Vector3(Points[3 * Corner], Points[3 * Corner + 1], Points[3 * Corner + 2]));
      }
      Result.set(Key, { Count, Positions, Normals, Box });
    }
    return Result;
  }

  // ------------------------------------------------------------------ carregar / load
  async Load(Key, Options) {
    if (this.Busy) return;
    this.Busy = true;
    const Ui = this.Ui;
    const Started = performance.now();
    try {
      const Level = Ui.LevelByKey(Key);
      Ui.ShowLoading(Text('Loading', { File: Level ? Level.File : Key }));
      const ServerStart = performance.now();
      const Scene = await Ui.FetchJson('/api/Level/' + encodeURIComponent(Key));
      if (Scene.Error) throw new Error(Scene.Error);
      const ServerTime = performance.now() - ServerStart;
      const [Geometry, TextureBundle] = await Promise.all([Ui.FetchBuffer('/api/LevelGeometry/' + encodeURIComponent(Key)), Ui.FetchBuffer('/api/LevelTextures/' + encodeURIComponent(Key))]);
      const ClientStart = performance.now();
      Ui.ShowLoading(Text('LoadingTextures', { Count: Scene.Textures.length }));
      await Ui.NextFrame();
      this.Unload();
      this.TextureInfo = RiotTextureDecoder.DecodeBundle(TextureBundle);
      Ui.ShowLoading(Text('LoadingLights'));
      await Ui.NextFrame();
      const Vertices = this.ModelVertices(Scene, Geometry);
      this.ModelVerts = Vertices;
      this.Scene = Scene;
      this.Uniforms.LitTexture.value = this.DataTexture(new Uint8Array(Geometry, Scene.Lit.o, Scene.Lit.n * 4), Scene.Lit.n);
      this.Uniforms.DynTexture.value = this.BuildLighting(Scene, Vertices);
      Ui.ShowLoading(Text('LoadingMeshes'));
      await Ui.NextFrame();
      this.Scene = Scene;
      this.Geometry = Geometry;
      const MeshStart = performance.now();
      this.BuildMeshes(Scene, Geometry);
      Scene.Instances.forEach((Instance, Number) => { if ((Instance[9] || Instance[10]) && !this.ShowDormant) this.UpdateInstance(Number); });
      this.BuildLightIcons();
      this.BuildSky();
      this.Particles.Build(Scene);
      if (Scene.ShadowFade) [this.Shadows.FadeStart, this.Shadows.FadeEnd] = Scene.ShadowFade;
      this.Shadows.Build();
      console.log('SurrealEd timings', { Server: ServerTime | 0, Decode: (performance.now() - ClientStart) | 0, Meshes: (performance.now() - MeshStart) | 0 });
      this.FrameLevel();
      if (Options && Options.View) this.Viewport.SetView(Options.View[0], Options.View[1]); else this.Overview();
      Ui.LevelLoaded(Scene, { ServerTime, ClientTime: performance.now() - ClientStart, Total: performance.now() - Started });
      if (this.CellGroup.visible) this.LoadCells(Key);
      if (this.NormalsOn) this.DrawNormals();
    } catch (Error) {
      console.error(Error);
      Ui.ShowLoading(Text('LoadError', { Error: Error.message || Error }), true);
      this.Busy = false;
      return;
    }
    Ui.HideLoading();
    this.Busy = false;
  }

  Unload() {
    if (this.Stomp) this.Stomp.Stop();
    if (this.Particles) this.Particles.Clear();
    this.ClearLinks();
    this.ClearOverlay();
    this.Shadows.Clear();
    this.ClearNormals();
    this.Viewport.Clear();
    this.Meshes = [];
    for (const Texture of this.Textures.values()) Texture.dispose();
    this.Textures.clear();
    for (const Key of ['LitTexture', 'DynTexture']) if (this.Uniforms[Key].value) { this.Uniforms[Key].value.dispose(); this.Uniforms[Key].value = null; }
    this.Hidden = new Set();
    for (const Entry of this.Animated) if (Entry.Clone) Entry.Map.dispose();
    this.Animated = [];
    this.Lighting = null;
    for (const Icon of [...this.LightIcons.children]) { this.LightIcons.remove(Icon); Icon.material.dispose(); }
    this.LightIconOf = new Map();
    this.Selected = null;
    this.ClearCells();
    this.Cells = null;
    this.CellsKey = null;
  }

  BuildMeshes(Scene, Buffer) {
    const ByModel = new Map();
    this.InstanceSlots = new Map();   // PT: instância -> [[malha, slot]] / EN: instance -> [[mesh, slot]]
    Scene.Instances.forEach((Instance, Number) => { if (!ByModel.has(Instance[0])) ByModel.set(Instance[0], []); ByModel.get(Instance[0]).push(Number); });
    const Matrix = new THREE.Matrix4();
    for (const [Key, List] of ByModel) {
      const Groups = Scene.Models[Key];
      if (!Groups) continue;
      const ClassName = Scene.Instances[List[0]][4];
      for (const Group of Groups) {
        if (!Group.n) continue;
        const Geometry = new THREE.BufferGeometry();
        Geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Buffer, Group.po, Group.n * 3), 3));
        Geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Int8Array(Buffer, Group.no, Group.n * 4), 4), 3, 0, true));
        if (Group.uo >= 0) Geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(Buffer, Group.uo, Group.n * 2), 2));
        Geometry.setAttribute('vidx', new THREE.BufferAttribute(Group.vo >= 0 ? new Float32Array(Buffer, Group.vo, Group.n) : new Float32Array(Group.n), 1));
        Geometry.setAttribute('LitOffset', new THREE.InstancedBufferAttribute(new Float32Array(List.map(Number => Scene.Instances[Number][5])), 1));
        Geometry.setAttribute('DynOffset', new THREE.InstancedBufferAttribute(new Float32Array(List.map(Number => Scene.Instances[Number][7])), 1));
        // PT: 1 = caster (não recebe a própria sombra); atualizado por RiotShadows.Build / EN: 1 = caster, set by RiotShadows.Build
        Geometry.setAttribute('ShadowSelf', new THREE.InstancedBufferAttribute(new Float32Array(List.length), 1));
        if (Group.ao >= 0) Geometry.setAttribute('SplatAlpha', new THREE.BufferAttribute(new Uint8Array(Buffer, Group.ao, Group.n), 1, true));
        const Material = this.MaterialFor(Group, ClassName);
        if (!Material) continue;
        if (Group.an && Group.b !== 'splat') this.AttachAnimation(Material, Group, Scene.Waves);
        const Mesh = new THREE.InstancedMesh(Geometry, Material, List.length);
        List.forEach((Number, Slot) => {
          Mesh.setMatrixAt(Slot, this.InstanceMatrix(Scene.Instances[Number], Matrix));
          if (!this.InstanceSlots.has(Number)) this.InstanceSlots.set(Number, []);
          this.InstanceSlots.get(Number).push([Mesh, Slot]);
        });
        if (Group.b === 'splat') Mesh.renderOrder = 1 + (Group.order || 0);
        Mesh.userData = { List, ClassName, Key, Group, MakePlain: () => this.Lightify(this.Grey.clone()) };
        this.UpdateCullSphere(Mesh);
        this.Viewport.Scene.add(Mesh);
        this.Viewport.Pickables.push(Mesh);
        this.Meshes.push(Mesh);
      }
    }
    this.Viewport.ApplyRenderMode();
  }


  /**
   * PT: Esfera que cobre todas as instâncias da malha, para o descarte por frustum (o three r147 só olha a esfera da
   *     geometria, sem as instâncias; ver o remendo em RiotViewport.js). Malhas fora da tela não são desenhadas.
   * EN: Sphere around every instance of the mesh, for frustum culling (three r147 ignores instances; see the
   *     patch in RiotViewport.js). Off-screen meshes are not drawn.
   */
  UpdateCullSphere(Mesh) {
    const Geometry = Mesh.geometry;
    if (!Geometry.boundingSphere) Geometry.computeBoundingSphere();
    const Local = Geometry.boundingSphere, Matrix = new THREE.Matrix4(), Part = new THREE.Sphere(), Box = new THREE.Box3();
    let First = true;
    for (let Slot = 0; Slot < Mesh.count; Slot++) {
      Mesh.getMatrixAt(Slot, Matrix);
      Part.copy(Local).applyMatrix4(Matrix);
      if (First) { Box.setFromCenterAndSize(Part.center, new THREE.Vector3()).expandByScalar(Part.radius); First = false; }
      else Box.union(new THREE.Box3().setFromCenterAndSize(Part.center, new THREE.Vector3()).expandByScalar(Part.radius));
    }
    const Sphere = Mesh.userData.CullSphere || new THREE.Sphere();
    if (First) Sphere.set(new THREE.Vector3(), 0); else Box.getBoundingSphere(Sphere);
    Mesh.userData.CullSphere = Sphere;
    Mesh.frustumCulled = true;
  }

  // ------------------------------------------------------------------ normais / normals
  /**
   * PT: Desenha as normais como linhas, como o "Display Vertex Normals" do menu de debug do jogo e o overlay do Blender:
   *       azul = normal do vértice (a que está no arquivo, pedaço 0x0203; é a usada na iluminação);
   *       ciano = normal da face (calculada aqui; o jogo não guarda normal de face).
   *     Com um objeto selecionado, mostra só ele; sem seleção, mostra os objetos perto do centro da câmera.
   * EN: Draws normals as lines (vertex normals from the file in blue, computed face normals in cyan),
   *     for the selected object, or for objects near the camera target when nothing is selected.
   */
  ShowNormals(Visible) {
    this.NormalsOn = Visible;
    if (Visible) this.DrawNormals(); else this.ClearNormals();
  }

  ClearNormals() {
    if (!this.NormalLines) return;
    this.Viewport.Scene.remove(this.NormalLines);
    this.NormalLines.traverse(Item => { if (Item.geometry) Item.geometry.dispose(); if (Item.material) Item.material.dispose(); });
    this.NormalLines = null;
  }

  DrawNormals() {
    this.ClearNormals();
    if (!this.Scene || !this.ModelVerts) return;
    const Targets = [];
    if (this.Selected) {
      const Number = this.Selected.Mesh.userData.List[this.Selected.Slot];
      const Key = this.Scene.Instances[Number][0];
      Targets.push({ Number, Groups: Key === 'terrain' ? [] : this.Scene.Models[Key] });
    } else {
      const Center = this.Viewport.Pivot(), Radius = 12;
      this.Scene.Instances.forEach((Instance, Number) => {
        if (Instance[0] === 'terrain') return;
        const Visible = this.Meshes.some(Mesh => Mesh.visible && Mesh.userData.Key === Instance[0]);
        if (!Visible) return;
        const Dx = Instance[1][0] - Center.x, Dy = Instance[1][1] - Center.y, Dz = Instance[1][2] - Center.z;
        if (Dx * Dx + Dy * Dy + Dz * Dz < Radius * Radius) Targets.push({ Number, Groups: this.Scene.Models[Instance[0]] });
      });
    }
    const VertexLines = [], FaceLines = [], Limit = 200000;
    const Matrix = new THREE.Matrix4(), Normal3 = new THREE.Matrix3(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), Probe = new THREE.Vector3();
    for (const Target of Targets) {
      const Instance = this.Scene.Instances[Target.Number], Verts = this.ModelVerts.get(Instance[0]);
      if (!Verts || !Verts.Count) continue;
      this.InstanceMatrix(Instance, Matrix);
      Normal3.setFromMatrix4(Matrix);
      const Size = Verts.Box.getSize(new THREE.Vector3()).applyMatrix3(Normal3).length();
      const Length = Math.min(Math.max(Size * 0.06, 0.08), 1.5);
      const Used = new Set();
      for (const Group of Target.Groups) {
        if (Group.vo < 0) continue;
        const Indexes = new Float32Array(this.Geometry, Group.vo, Group.n);
        for (let Corner = 0; Corner < Group.n; Corner++) {
          const Index = Indexes[Corner];
          if (Used.has(Index) || VertexLines.length > Limit * 6) continue;
          Used.add(Index);
          A.fromArray(Verts.Positions, 3 * Index).applyMatrix4(Matrix);
          N.fromArray(Verts.Normals, 3 * Index).applyMatrix3(Normal3).normalize().multiplyScalar(Length);
          VertexLines.push(A.x, A.y, A.z, A.x + N.x, A.y + N.y, A.z + N.z);
        }
        for (let Corner = 0; Corner + 2 < Group.n && FaceLines.length < Limit * 6; Corner += 3) {
          A.fromArray(Verts.Positions, 3 * Indexes[Corner]).applyMatrix4(Matrix);
          B.fromArray(Verts.Positions, 3 * Indexes[Corner + 1]).applyMatrix4(Matrix);
          C.fromArray(Verts.Positions, 3 * Indexes[Corner + 2]).applyMatrix4(Matrix);
          N.subVectors(C, B).cross(new THREE.Vector3().subVectors(A, B)).normalize();
          // PT: o jogo não guarda a ordem dos cantos de forma confiável; orienta pela média das normais dos vértices
          // EN: corner order is not reliable; orient by the average vertex normal
          let Dot = 0;
          for (let Step = 0; Step < 3; Step++) {
            Probe.fromArray(Verts.Normals, 3 * Indexes[Corner + Step]).applyMatrix3(Normal3);
            Dot += N.dot(Probe);
          }
          N.multiplyScalar(Dot < 0 ? -Length : Length);
          const Mx = (A.x + B.x + C.x) / 3, My = (A.y + B.y + C.y) / 3, Mz = (A.z + B.z + C.z) / 3;
          FaceLines.push(Mx, My, Mz, Mx + N.x, My + N.y, Mz + N.z);
        }
      }
    }
    const Group = new THREE.Group();
    const AddLines = (Values, Color) => {
      if (!Values.length) return;
      const Geometry = new THREE.BufferGeometry();
      Geometry.setAttribute('position', new THREE.Float32BufferAttribute(Values, 3));
      Group.add(new THREE.LineSegments(Geometry, new THREE.LineBasicMaterial({ color: Color, transparent: true, opacity: 0.9 })));
    };
    AddLines(VertexLines, 0x4a7dff);
    AddLines(FaceLines, 0x37d0d8);
    this.NormalLines = Group;
    this.Viewport.Scene.add(Group);
  }

  // ------------------------------------------------------------------ classes
  /** PT: Contagem por classe e visibilidade inicial (marcadores do editor começam ocultos). EN: Class counts and default visibility. */
  ClassSummary() {
    const Helpers = RiotLevelView.HelperClasses;
    const Counts = new Map(), SystemOnly = new Map();
    const System = String(this.Scene.SystemPackage);
    for (const Instance of this.Scene.Instances) {
      const Name = Instance[4];
      Counts.set(Name, (Counts.get(Name) || 0) + 1);
      const IsSystem = Instance[0] !== 'terrain' && Instance[0].split('_')[0] === System;
      SystemOnly.set(Name, (SystemOnly.get(Name) !== false) && IsSystem);
    }
    return [...Counts].sort((A, B) => B[1] - A[1]).map(([Name, Count]) => ({ Name, Count, Visible: !Helpers.test(Name) && !SystemOnly.get(Name) }));
  }

  /** PT: Classes que o jogo não desenha (marcadores, volumes, colisão invisível). EN: Classes the game does not draw. */
  static get HelperClasses() {
    return /Node|Marker|Detector|Sound|Waypoint|Behavior|Controller|Trigger|Volumetric Fog|STOMP|Spawn|Camera|^Light$|^Portal$|Position$|^Sky|Light$|Fog \/ Sky|Invisible|Message Filter|Clamber|Flee|Cover/;
  }

  /**
   * PT: Instância é só marcador do editor (classe auxiliar ou modelo do pacote System)? Por instância, porque uma
   *     malha junta todas as instâncias do mesmo modelo, de classes diferentes.
   * EN: Is the instance an editor-only marker? Per instance: one mesh holds every instance of a model, any class.
   */
  IsHelperInstance(Instance) {
    const Key = Instance[0];
    return RiotLevelView.HelperClasses.test(Instance[4] || '') || Key === 'fxmarker' || (Key !== 'terrain' && Key.split('_')[0] === String(this.Scene.SystemPackage));
  }

  /** PT: Modo cinema liga/desliga (esconde marcadores). EN: Cinema mode on/off (hides markers). */
  SetCinema(On) {
    this.Cinema = On;
    this.Scene.Instances.forEach((Instance, Number) => { if (this.IsHelperInstance(Instance)) this.UpdateInstance(Number); });
  }

  SetClassVisible(Name, Visible) {
    for (const Mesh of this.Meshes) if (Mesh.userData.ClassName === Name) Mesh.visible = Visible;
    if (this.Selected && this.Selected.Mesh.userData.ClassName === Name && !Visible) this.Select(null);
  }

  // ------------------------------------------------------------------ câmera / camera
  FrameLevel() {
    const Points = this.Scene.Instances.filter(Instance => Instance[0] !== 'terrain').map(Instance => Instance[1]);
    if (!Points.length) { this.Center.set(0, 0, 0); this.Size.set(100, 20, 100); return; }
    const Percentile = (Axis, Quantile) => { const Values = Points.map(Point => Point[Axis]).sort((A, B) => A - B); return Values[Math.floor(Quantile * (Values.length - 1))]; };
    const Low = new THREE.Vector3(Percentile(0, 0.03), Percentile(1, 0.03), Percentile(2, 0.03));
    const High = new THREE.Vector3(Percentile(0, 0.97), Percentile(1, 0.97), Percentile(2, 0.97));
    this.Center.copy(Low).add(High).multiplyScalar(0.5);
    this.Size.copy(High).sub(Low);
    const Extent = Math.max(this.Size.x, this.Size.z);
    this.EditorFog = [Math.max(120, Extent * 0.6), Math.max(420, Extent * 2.2)];
    if (!this.GameFog) { this.Viewport.Scene.fog.near = this.EditorFog[0]; this.Viewport.Scene.fog.far = this.EditorFog[1]; }
  }

  /**
   * PT: Neblina do jogo (linear na profundidade, como no motor): {Start, End, Color:[r,g,b]} ou null para a do editor.
   *     A cor vai direto (r147 mistura a neblina depois da conversão sRGB) e o fundo acompanha, como no jogo.
   * EN: Game fog (linear in view depth): {Start, End, Color} or null for the editor's own; the clear colour follows.
   */
  SetFog(Fog) {
    const Scene = this.Viewport.Scene;
    this.GameFog = Fog && Fog.End > 0 ? Fog : null;
    if (this.GameFog) {
      Scene.fog.color.setRGB(Fog.Color[0], Fog.Color[1], Fog.Color[2]);
      Scene.fog.near = Math.max(0, Math.min(Fog.Start, Fog.End - 0.01));
      Scene.fog.far = Fog.End;
      Scene.background.copy(Scene.fog.color);
    } else {
      Scene.fog.color.setHex(0x0d0f0c);
      Scene.background.setHex(0x0d0f0c);
      const [Near, Far] = this.EditorFog || [120, 420];
      Scene.fog.near = Near; Scene.fog.far = Far;
    }
  }

  Overview() {
    const Camera = this.Viewport.Camera, Center = this.Center, Size = this.Size;
    this.Viewport.SetView(new THREE.Vector3(Center.x + Size.x * 0.45, Center.y + Math.max(Size.x, Size.z) * 0.75, Center.z + Size.z * 0.75), Center);
  }

  StartView() {
    const Start = (this.Scene && this.Scene.Start) || [this.Center.x, this.Center.y, this.Center.z];
    this.Viewport.SetView(new THREE.Vector3(Start[0] + 4, Start[1] + 9, Start[2] + 10), new THREE.Vector3(Start[0], Start[1] + 2, Start[2] - 6));
  }

  // ------------------------------------------------------------------ seleção / selection
  Pick(Hit) {
    if (!Hit || !this.Scene) { this.Select(null, true); return; }
    if (Hit.object.isSprite) {
      const Slots = this.InstanceSlots.get(Hit.object.userData.Number);
      if (Slots && Slots.length) this.Select({ Mesh: Slots[0][0], Slot: Slots[0][1], Point: Hit.point });
      return;
    }
    this.Select({ Mesh: Hit.object, Slot: Hit.instanceId, Point: Hit.point });
  }

  Select(Selection, Missed, Quiet) {
    this.Selected = Selection;
    if (this.NormalsOn && !Quiet) this.DrawNormals();
    if (!Selection) { this.ClearLinks(); this.ClearOverlay(); this.Viewport.SetHighlight(null); this.Ui.ShowSelection(null, Missed); this.Ui.ShowProperties(null); this.Ui.SelectionChanged(null); return; }
    const { Mesh, Slot, Point } = Selection;
    const Number = Mesh.userData.List[Slot], Instance = this.Scene.Instances[Number];
    const TextureName = Code => Code ? (() => { const Info = this.TextureInfo.get(Code); return Code + (Info ? ` (${Info.Width}×${Info.Height} ${Info.FormatName})` : ''); })() : Text('SelNoTexture');
    const Scale = this.Scene.Game === 'TTB' ? 1 : 2048;
    let Lines;
    if (Instance[0] === 'terrain') {
      Lines = [Text('SelTerrain'), `${Text('SelPoint').padEnd(11)}${['x', 'y', 'z'].map(Axis => NumberText(Point[Axis] * Scale, 0)).join(', ')}`,
        `${Text('SelTexture').padEnd(11)}${TextureName(Mesh.userData.Group.tex)}`];
      this.Viewport.SetHighlight(null);
    } else {
      const Group = Mesh.userData.Group;
      Lines = [
        `${Text('SelClass').padEnd(11)}${Instance[4]}`,
        `${Text('SelInstance').padEnd(11)}${Instance[6]}`,
        `${Text('SelModel').padEnd(11)}${Instance[0]}`,
        `${Text('SelPosition').padEnd(11)}${Instance[1].map(Value => NumberText(Value * Scale, 0)).join(', ')}`,
        `${Text('SelRotation').padEnd(11)}${Instance[2].join('°, ')}°`,
        `${Text('SelScale').padEnd(11)}${Instance[3].join(' × ')}`,
        `${Text('SelTexture').padEnd(11)}${TextureName(Group.tex)}${Group.b ? `  (${Text('SelBlend')}: ${Group.b})` : ''}`,
        `${Text('SelLight').padEnd(11)}${Instance[5] >= 0 ? Text('SelBaked') : Text('SelNoBaked')}`,
        `${Text('SelGroups')}: ${this.Scene.Models[Instance[0]].map(Item => Item.tex || '—').join(' | ')}`,
      ];
      this.HighlightInstance(Number);
    }
    if (Instance[0] === 'terrain') this.ClearOverlay();
    this.Ui.ShowSelection(Lines.join('\n'));
    if (Quiet) return;   // PT: só atualiza o texto (durante a edição) / EN: text refresh only (while editing)
    this.Ui.ShowProperties(Instance[0] === 'terrain' ? 'terrain' : this.Scene.Key, Instance[6]);
    this.Ui.SelectionChanged(Instance[0] === 'terrain' ? null : Number);
  }

  // ------------------------------------------------------------------ copiar / apagar · copy / delete
  /**
   * PT: Cria no visor uma cópia da instância (ainda sem id do arquivo: TempId < 0). Cada malha do original ganha uma
   *     malha de 1 instância que reaproveita a geometria e o material; a luz (se for Point Light) é copiada também.
   * EN: Adds a viewport copy of an instance (TempId < 0): one single-instance mesh per original mesh, sharing
   *     geometry and material; Point Lights are copied too.
   */
  AddCopy(SourceNumber, TempId, Offset) {
    const Scene = this.Scene, Source = Scene.Instances[SourceNumber];
    const Instance = JSON.parse(JSON.stringify(Source));
    Instance[6] = TempId;
    Instance[1] = Source[1].map((Value, Axis) => Value + (Offset ? Offset[Axis] : 0));
    const Number = Scene.Instances.push(Instance) - 1;
    if (this.Lighting) this.Lighting.Offsets[Number] = -1;
    const Matrix = this.InstanceMatrix(Instance, new THREE.Matrix4());
    this.InstanceSlots.set(Number, []);
    for (const [Mesh, Slot] of this.InstanceSlots.get(SourceNumber) || []) {
      const Geometry = new THREE.BufferGeometry();
      for (const [Name, Attribute] of Object.entries(Mesh.geometry.attributes)) {
        if (Attribute.isInstancedBufferAttribute) Geometry.setAttribute(Name, new THREE.InstancedBufferAttribute(new Float32Array([Attribute.getX(Slot)]), 1));
        else Geometry.setAttribute(Name, Attribute);
      }
      const Copy = new THREE.InstancedMesh(Geometry, Mesh.userData.OriginalMaterial || Mesh.material, 1);
      Copy.setMatrixAt(0, Matrix);
      Copy.renderOrder = Mesh.renderOrder;
      Copy.visible = Mesh.visible;
      Copy.userData = { List: [Number], ClassName: Mesh.userData.ClassName, Key: Mesh.userData.Key, Group: Mesh.userData.Group, MakePlain: Mesh.userData.MakePlain };
      this.UpdateCullSphere(Copy);
      this.Viewport.Scene.add(Copy);
      this.Viewport.Pickables.push(Copy);
      this.Meshes.push(Copy);
      this.InstanceSlots.get(Number).push([Copy, 0]);
    }
    this.Viewport.ApplyRenderMode();
    const Light = this.LightOf(Source[6]);
    if (Light) {
      const Copy = Light.slice();
      [Copy[0], Copy[1], Copy[2]] = Instance[1];
      Copy[7] = TempId;
      Scene.Lights.push(Copy);
      this.Relight([[new THREE.Vector3(Copy[0], Copy[1], Copy[2]), this.LightCut(Copy) + 0.01]]);
    }
    if (Instance[4] === 'Point Light') this.AddLightIcon(Number);
    else if (Instance[0] === 'fxmarker') this.AddEffectIcon(Number);
    this.Particles.Copied(SourceNumber, Number);
    return Number;
  }

  IsHidden(Number) {
    const Instance = this.Scene && this.Scene.Instances[Number];
    if (this.Hidden.has(Number)) return true;
    if (this.ForceShown.has(Number)) return false;   // PT: objeto de uma cena STOMP tocando / EN: object of a playing STOMP scene
    if (this.Cinema && Instance && this.IsHelperInstance(Instance)) return true;
    if (this.SkyOn && Instance && Instance[4] === 'Sky / Sun') return true;   // PT: desenhado no céu / EN: drawn in the sky pass
    return Boolean(Instance && (Instance[9] || Instance[10]) && !this.ShowDormant);
  }

  /** PT: Mostra/esconde os objetos que o jogo não cria no início (flag 0x8). EN: Shows/hides flag-0x8 objects. */
  SetShowDormant(Show) {
    this.ShowDormant = Show;
    if (!this.Scene) return;
    this.Scene.Instances.forEach((Instance, Number) => { if (Instance[9] || Instance[10]) this.UpdateInstance(Number); });
    this.RelightAll();
    if (this.Shadows) this.Shadows.Build();
    if (this.Selected && this.IsHidden(this.SelectedNumber())) this.Select(null);
  }

  // ------------------------------------------------------------------ céu / sky
  /**
   * PT: Camadas Sky / Sun desenhadas em volta da câmera, numa passada antes da fase (sem profundidade, sem neblina),
   *     com o deslocamento de cada uma em relação ao centro (a cúpula p6 = 1, senão a primeira). A textura da cúpula é
   *     escrita pelo jogo a partir da Sky Properties (Suffering.rfl 0x1012AD70): p4 = horizonte (e neblina), p5 = céu,
   *     p6 = faixa do horizonte, p7 = degradê, como frações de altura (fatos do the-suffering-engine).
   * EN: Sky / Sun layers drawn around the camera in a pass before the level; the dome (p6 = 1) shows the Sky
   *     Properties strip: p4 horizon, p5 sky, p6 horizon band, p7 blend.
   */
  BuildSky() {
    if (this.SkyScene) this.SkyScene.traverse(Object_ => { if (Object_.material && Object_.userData.Own) Object_.material.dispose(); });
    this.SkyScene = null;
    this.Viewport.SkyScene = null;
    const Scene = this.Scene;
    if (!Scene || !Scene.Sky || !Scene.Sky.length) return;
    const ById = new Map(Scene.Instances.map((Instance, Number) => [Instance[6], Number]));
    const Entries = Scene.Sky.map(Item => ({ ...Item, Number: ById.get(Item.Id) })).filter(Item => Item.Number !== undefined);
    const Centre = Entries.find(Item => Item.Dome) || Entries[0];
    if (!Centre) return;
    const Origin = Scene.Instances[Centre.Number][1];
    const Sky = new THREE.Scene();
    let Order = 1;
    this.DomeUniforms = { Horizon: { value: new THREE.Color(0x202020) }, Top: { value: new THREE.Color(0x101010) }, Band: { value: 0.1 }, Blend: { value: 0.2 }, Height: { value: 1 } };
    for (const Item of Entries) {
      if (!Item.Shown) continue;
      const Instance = Scene.Instances[Item.Number], Matrix = this.InstanceMatrix(Instance, new THREE.Matrix4());
      Matrix.setPosition(Instance[1][0] - Origin[0], Instance[1][1] - Origin[1], Instance[1][2] - Origin[2]);
      // PT: toda camada p6 = 1 é cúpula (o 10 Docks põe duas; a textura delas é só um molde que o jogo reescreve)
      // EN: every p6 = 1 layer is a dome (10 Docks has two; their texture is a placeholder the game rewrites)
      const IsDome = Item.Dome;
      for (const [Mesh] of this.InstanceSlots.get(Item.Number) || []) {
        let Material;
        if (IsDome) {
          Mesh.geometry.computeBoundingBox();
          this.DomeUniforms.Height.value = Math.max(1e-3, Mesh.geometry.boundingBox.max.y);
          Material = new THREE.ShaderMaterial({
            uniforms: this.DomeUniforms, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
            vertexShader: 'varying float vHeight; void main() { vHeight = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
            fragmentShader: `uniform vec3 Horizon; uniform vec3 Top; uniform float Band; uniform float Blend; uniform float Height; varying float vHeight;
void main() { float S = clamp(vHeight / Height, 0.0, 1.0); float T = clamp((S - Band) / max(Blend, 1.0 / 448.0), 0.0, 1.0); gl_FragColor = vec4(mix(Horizon, Top, T), 1.0); }`,
          });
        } else {
          const Group = Mesh.userData.Group, Map = this.Texture(Group.tex), Info = this.TextureInfo.get(Group.tex);
          const Alpha = Info ? Info.AlphaKind : 0;
          if (Map && Group.tint) Material = this.TintedMaterial(Group, Map, Info, Alpha);
          else if (Map && Group.b && Group.b !== 'opaque' && Group.b !== 'cutout' && Group.b !== 'alpha') Material = this.BlendMaterial(Group, true);
          if (!Material) Material = new THREE.MeshBasicMaterial({ map: Map, side: THREE.DoubleSide, transparent: Boolean(Alpha) || Group.b === 'alpha', alphaTest: Group.b === 'cutout' ? 200 / 255 : 0, color: Map ? 0xffffff : 0x303030 });
          // PT: camadas se ordenam pela profundidade entre si (a passada do céu limpa a profundidade depois)
          // EN: layers depth-sort among themselves (the sky pass clears depth afterwards)
          Material.depthTest = true; Material.depthWrite = !Material.transparent; Material.fog = false;
          if (Group.an && Material.map) this.AttachAnimation(Material, Group, Scene.Waves);   // PT: nuvens que rolam / EN: scrolling clouds
        }
        const Part = new THREE.Mesh(Mesh.geometry, Material);
        Part.matrixAutoUpdate = false;
        Part.matrix.copy(Matrix);
        Part.frustumCulled = false;
        Part.renderOrder = IsDome ? 0 : Order++;
        Part.userData.Own = true;
        Sky.add(Part);
      }
    }
    Sky.visible = this.SkyOn;
    this.SkyScene = Sky;
    this.Viewport.SkyScene = Sky;
    this.Scene.Instances.forEach((Instance, Number) => { if (Instance[4] === 'Sky / Sun') this.UpdateInstance(Number); });
  }

  /** PT: Cores da cúpula a partir da Sky Properties (valores brutos p4..p7). EN: Dome colours from Sky Properties. */
  SetDome(Raw) {
    if (!this.DomeUniforms || !Raw) return;
    const Float = Bits => { const View = new DataView(new ArrayBuffer(4)); View.setUint32(0, Bits >>> 0, true); return View.getFloat32(0, true); };
    const Color = Bits => new THREE.Color(((Bits >> 16) & 255) / 255, ((Bits >> 8) & 255) / 255, (Bits & 255) / 255);
    const Horizon = Raw[4] & 0xFFFFFF, Top = Raw[5] & 0xFFFFFF;
    this.DomeUniforms.Horizon.value.copy(Color(Horizon));
    this.DomeUniforms.Top.value.copy(Color(Horizon === Top ? Horizon : Top));
    const Band = Float(Raw[6]), Blend = Float(Raw[7]);
    this.DomeUniforms.Band.value = Band === Band ? Math.min(1, Math.max(0, Band)) : 0.1;
    this.DomeUniforms.Blend.value = Blend === Blend ? Math.min(1, Math.max(0, Blend)) : 0.2;
  }

  SetSkyOn(On) {
    this.SkyOn = On;
    if (this.SkyScene) this.SkyScene.visible = On;
    if (this.Scene) this.Scene.Instances.forEach((Instance, Number) => { if (Instance[4] === 'Sky / Sun') this.UpdateInstance(Number); });
  }

  // ------------------------------------------------------------------ ícones de luz / light icons
  /** PT: Ícone clicável (tamanho fixo na tela) para cada Point Light. EN: Clickable fixed-size icon per Point Light. */
  BuildLightIcons() {
    for (const Icon of [...this.LightIcons.children]) { this.LightIcons.remove(Icon); Icon.material.dispose(); }
    this.LightIconOf = new Map();
    if (!this.IconTexture) {
      const Canvas = document.createElement('canvas');
      Canvas.width = Canvas.height = 64;
      const Paint = Canvas.getContext('2d');
      Paint.fillStyle = '#ffffff'; Paint.strokeStyle = '#000000c0'; Paint.lineWidth = 5;
      Paint.beginPath(); Paint.arc(32, 26, 17, 0, Math.PI * 2); Paint.fill(); Paint.stroke();
      Paint.fillRect(24, 42, 16, 12); Paint.strokeRect(24, 42, 16, 12);
      this.IconTexture = new THREE.CanvasTexture(Canvas);
    }
    if (!this.EffectTexture) {
      // PT: estrela de 8 pontas para efeitos / EN: 8-point star for effects
      const Canvas = document.createElement('canvas');
      Canvas.width = Canvas.height = 64;
      const Paint = Canvas.getContext('2d');
      Paint.fillStyle = '#ffffff'; Paint.strokeStyle = '#000000c0'; Paint.lineWidth = 4;
      Paint.beginPath();
      for (let Point = 0; Point < 16; Point++) {
        const Angle = Point * Math.PI / 8 - Math.PI / 2, Radius = Point % 2 ? 11 : 28;
        Paint.lineTo(32 + Radius * Math.cos(Angle), 32 + Radius * Math.sin(Angle));
      }
      Paint.closePath(); Paint.fill(); Paint.stroke();
      this.EffectTexture = new THREE.CanvasTexture(Canvas);
    }
    this.Scene.Instances.forEach((Instance, Number) => {
      if (Instance[4] === 'Point Light') this.AddLightIcon(Number);
      else if (Instance[0] === 'fxmarker') this.AddEffectIcon(Number);
    });
  }

  /** PT: Muda o tamanho de todos os ícones. EN: Resizes every icon. */
  SetIconSize(Size) {
    this.IconSize = Size;
    try { localStorage.setItem('SurrealEdIconSize', String(Size)); } catch (Error) { /* sem armazenamento / no storage */ }
    for (const Icon of this.LightIcons.children) Icon.scale.set(Size, Size, 1);
  }

  /** PT: Ícone clicável para efeitos sem modelo. EN: Clickable icon for model-less effects. */
  AddEffectIcon(Number) {
    const Instance = this.Scene.Instances[Number];
    const Material = new THREE.SpriteMaterial({ map: this.EffectTexture, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, color: 0xffa040 });
    const Icon = new THREE.Sprite(Material);
    Icon.scale.set(this.IconSize, this.IconSize, 1);
    Icon.position.fromArray(Instance[1]);
    Icon.userData = { Number };
    Icon.visible = !this.IsHidden(Number);
    this.LightIcons.add(Icon);
    this.LightIconOf.set(Number, Icon);
  }

  AddLightIcon(Number) {
    const Instance = this.Scene.Instances[Number], Light = this.LightOf(Instance[6]);
    const Material = new THREE.SpriteMaterial({ map: this.IconTexture, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
    const Icon = new THREE.Sprite(Material);
    Icon.scale.set(this.IconSize, this.IconSize, 1);
    Icon.position.fromArray(Instance[1]);
    Icon.userData = { Number };
    Icon.visible = !this.IsHidden(Number);
    this.LightIcons.add(Icon);
    this.LightIconOf.set(Number, Icon);
    this.TintLightIcon(Number, Light);
  }

  /** PT: Ícones aparecem por cima de tudo, então só os próximos (25 m) ficam visíveis. EN: Only icons within 25 m show. */
  UpdateLightIcons() {
    if (!this.LightIcons.visible || !this.Scene) return;
    const Cinema = this.Stomp && this.Stomp.Active && this.Stomp.SceneCamera && this.Stomp.CameraTrack;
    const Camera = this.Viewport.Camera.position;
    if (Cinema) { for (const Icon of this.LightIconOf.values()) Icon.visible = false; return; }
    for (const [Number, Icon] of this.LightIconOf) Icon.visible = !this.IsHidden(Number) && Icon.position.distanceToSquared(Camera) < 625;
  }

  TintLightIcon(Number, Light) {
    const Icon = this.LightIconOf && this.LightIconOf.get(Number);
    if (!Icon || !Light) return;
    const Peak = Math.max(Light[3], Light[4], Light[5], 0.001);
    Icon.material.color.setRGB(0.35 + 0.65 * Light[3] / Peak, 0.35 + 0.65 * Light[4] / Peak, 0.35 + 0.65 * Light[5] / Peak);
    Icon.material.opacity = Light[8] ? 1 : 0.45;
  }

  /** PT: Esconde/mostra uma instância (apagada ou desfeita). EN: Hides/shows an instance (deleted or undone). */
  SetHidden(Number, Hidden) {
    if (Hidden) this.Hidden.add(Number); else this.Hidden.delete(Number);
    this.UpdateInstance(Number);
    const Instance = this.Scene.Instances[Number], Light = this.LightOf(Instance[6]);
    if (Light) {
      if (Hidden) { Light[10] = Light[8]; Light[8] = 0; } else if (Light[10] !== undefined) { Light[8] = Light[10]; delete Light[10]; }
      this.Relight([[new THREE.Vector3(Light[0], Light[1], Light[2]), this.LightCut(Light) + 0.01]]);
    }
    if (Hidden && this.SelectedNumber() === Number) this.Select(null);
    if (this.Shadows) this.Shadows.Build();
  }

  /** PT: Reaplica a matriz de uma instância em todas as malhas dela. EN: Re-applies one instance matrix to all its meshes. */
  UpdateInstance(Number) {
    const Matrix = this.InstanceMatrix(this.Scene.Instances[Number], new THREE.Matrix4());
    if (this.IsHidden(Number)) Matrix.makeScale(0, 0, 0);
    const Icon = this.LightIconOf.get(Number);
    if (Icon) { Icon.position.fromArray(this.Scene.Instances[Number][1]); Icon.visible = !this.IsHidden(Number); }
    for (const [Mesh, Slot] of this.InstanceSlots.get(Number) || []) {
      Mesh.setMatrixAt(Slot, Matrix); Mesh.instanceMatrix.needsUpdate = true;
      // PT: a esfera só cresce aqui (barato); refeita inteira no fim do arrasto / EN: only grows here (cheap)
      const Sphere = Mesh.userData.CullSphere;
      if (Sphere && !this.IsHidden(Number)) {
        const Geometry = Mesh.geometry, Part = Geometry.boundingSphere.clone().applyMatrix4(Matrix);
        Sphere.union(Part);
      }
    }
    if (this.Particles) this.Particles.Moved(Number);
    if (this.Selected && this.Selected.Mesh.userData.List[this.Selected.Slot] === Number) this.HighlightInstance(Number);
  }

  /**
   * PT: Destaca o objeto inteiro: caixa de todas as malhas da instância (não só do material clicado) e um contorno
   *     em wireframe por cima de todas elas.
   * EN: Highlights the whole object: box over every mesh of the instance (not just the clicked material) and a
   *     wireframe overlay on all of them.
   */
  HighlightInstance(Number) {
    const Matrix = this.InstanceMatrix(this.Scene.Instances[Number], new THREE.Matrix4());
    const Slots = this.InstanceSlots.get(Number) || [];
    const Box = new THREE.Box3();
    this.ClearOverlay();
    this.Overlay = new THREE.Group();
    this.Overlay.matrixAutoUpdate = false;
    this.Overlay.matrix.copy(Matrix);
    this.Overlay.renderOrder = 5;
    for (const [Mesh] of Slots) {
      if (!Mesh.geometry.boundingBox) Mesh.geometry.computeBoundingBox();
      Box.union(Mesh.geometry.boundingBox);
      const Part = new THREE.Mesh(Mesh.geometry, this.OverlayMaterial);
      Part.frustumCulled = false;
      this.Overlay.add(Part);
    }
    this.Viewport.Scene.add(this.Overlay);
    this.Viewport.SetHighlight(Box.isEmpty() ? null : Box.applyMatrix4(Matrix));
  }

  /** PT: Linhas até os objetos ligados (âmbar = saídas, azul = entradas). EN: Lines to linked objects. */
  ShowLinks(Details) {
    this.ClearLinks();
    if (!Details || !Details.Position) return;
    const From = new THREE.Vector3(...Details.Position);
    const Points = [], Colors = [];
    const Add = (Rows, Color) => {
      for (const Row of Rows || []) {
        if (!Row.Position) continue;
        Points.push(From.x, From.y, From.z, ...Row.Position);
        const Faded = Row.Heard && Row.Heard.length ? 1 : 0.35;
        Colors.push(...Color.map(Value => Value * Faded), ...Color.map(Value => Value * Faded));
      }
    };
    Add(Details.LinkOut, [0.88, 0.64, 0.24]);
    Add(Details.LinkIn, [0.45, 0.7, 0.95]);
    if (!Points.length) return;
    const Geometry = new THREE.BufferGeometry();
    Geometry.setAttribute('position', new THREE.Float32BufferAttribute(Points, 3));
    Geometry.setAttribute('color', new THREE.Float32BufferAttribute(Colors, 3));
    this.LinkLines = new THREE.LineSegments(Geometry, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    this.LinkLines.renderOrder = 9;
    this.Viewport.Scene.add(this.LinkLines);
  }

  ClearLinks() {
    if (this.LinkLines) { this.Viewport.Scene.remove(this.LinkLines); this.LinkLines.geometry.dispose(); this.LinkLines.material.dispose(); this.LinkLines = null; }
  }

  ClearOverlay() {
    if (this.Overlay) { this.Viewport.Scene.remove(this.Overlay); this.Overlay = null; }
  }

  SelectedNumber() { return this.Selected ? this.Selected.Mesh.userData.List[this.Selected.Slot] : null; }

  FocusSelection() {
    if (!this.Selected || !this.Viewport.Highlight.visible) return;
    this.Viewport.FrameBox(this.Viewport.Highlight.box, 2.2);
  }

  // ------------------------------------------------------------------ salas e portais / rooms and portals
  ClearCells() {
    while (this.CellGroup.children.length) {
      const Child = this.CellGroup.children.pop();
      if (Child.geometry) Child.geometry.dispose();
      if (Child.material) Child.material.dispose();
    }
  }

  async LoadCells(Key) {
    if (this.CellsKey === Key && this.Cells) { this.DrawCells(); return; }
    this.CellsKey = Key;
    try { this.Cells = await this.Ui.FetchJson('/api/LevelCells/' + encodeURIComponent(Key)); } catch (Error) { this.Cells = null; }
    if (!this.Cells || !this.Cells.Cells) this.Cells = { Nodes: {}, Cells: [] };
    const ByNode = {};
    this.Cells.Cells.forEach((Cell, Number) => { ByNode[Cell.node] = Number; });
    this.Cells.ByNode = ByNode;
    this.Ui.FillCells(this.Cells);
    this.DrawCells();
  }

  DrawCells() {
    this.ClearCells();
    const Data = this.Cells;
    if (!Data) return;
    const Chosen = this.Ui.ChosenCellNode();
    const CellNumber = Chosen !== null && Data.ByNode[Chosen] !== undefined ? Data.ByNode[Chosen] : null;
    const Visible = new Set(CellNumber !== null ? Data.Cells[CellNumber].vis : []);
    const AddBox = (Node, Color, Opacity) => {
      const Box = new THREE.Box3(new THREE.Vector3(...Node.mn), new THREE.Vector3(...Node.mx));
      const Helper = new THREE.Box3Helper(Box, Color);
      Helper.material.transparent = true; Helper.material.opacity = Opacity; Helper.material.depthTest = false;
      this.CellGroup.add(Helper);
    };
    for (const [Number, Node] of Object.entries(Data.Nodes)) {
      if (Node.k !== 1) continue;
      const IsChosen = String(Number) === String(Chosen);
      AddBox(Node, IsChosen ? 0xe0a33c : 0x8a8f98, IsChosen ? 0.95 : 0.25);
    }
    if (CellNumber !== null) Data.Cells.forEach((Cell, Number) => {
      const Node = Data.Nodes[Cell.node];
      if (Node && Visible.has(Number)) AddBox(Node, Number === CellNumber ? 0xe0a33c : 0x4aa3ff, 0.85);
    });
    const Sphere = new THREE.SphereGeometry(0.35, 8, 6);
    Data.Cells.forEach((Cell, Number) => Cell.pt.forEach(Point => {
      if (Point[0] === null) return;
      const Mesh = new THREE.Mesh(Sphere.clone(), new THREE.MeshBasicMaterial({ color: Number === CellNumber ? 0xffd27a : 0x56e39f, depthTest: false, transparent: true, opacity: 0.9 }));
      Mesh.position.set(Point[0], Point[1], Point[2]);
      Mesh.renderOrder = 999;
      this.CellGroup.add(Mesh);
    }));
    Sphere.dispose();
  }

  ShowCells(Visible) {
    this.CellGroup.visible = Visible;
    if (Visible && this.Scene) this.LoadCells(this.Scene.Key);
  }

  GoToCell(NodeNumber) {
    if (!this.Cells) return;
    const Node = this.Cells.Nodes[NodeNumber];
    if (!Node) return;
    this.Viewport.FrameBox(new THREE.Box3(new THREE.Vector3(...Node.mn), new THREE.Vector3(...Node.mx)), 1.4);
  }
}
