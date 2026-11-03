/*
 * RiotShadows — sombras dinâmicas como no jogo / dynamic shadows the way the game does them
 *
 * PT: Reprodução do sistema de sombras do Suffering.exe (veja Docs/RiotEngineNotes.md, "Shadows"):
 *       - projeta sombra quem tem a flag efetiva: com 0x1000 (sobrescrever) vale o bit 0x400 da instância; sem ela,
 *         o bit 0 das flags do template (lvl_ReadInstance 0x45A5C0 copia para o objeto +8 bit 0x1000000);
 *       - cada caster tem a sua textura 256×256 com a silhueta vista da luz (ShadowMgr::Add 0x4CEEA0);
 *       - a luz é a primeira luz do conjunto do objeto que tem posição (aqui: a Point Light de maior influência,
 *         (0,212 r + 0,701 g + 0,087 b) × I / d² dentro do raio R' = √(10 × (0,33 r + 0,45 g + 0,22 b) × I)); se ela
 *         estiver abaixo de 45° de elevação, sobe para 45° (0x4CC020: y < sen 45° → y = comprimento horizontal), então
 *         a sombra sempre cai para baixo; sem luz, sem sombra;
 *       - a textura é projetada nos receptores; a opacidade cai com N·L (c56 = (0,3; 1/0,7) do xvsShadowBackfaceCull.vsh;
 *         o shader faz add c56.x, mul c56.y: alfa = (N·L + 0,3) / 0,7, vezes três planos de corte)
 *         e com a distância da câmera entre Level Properties p14 e p15 (0x4084A0 / 0x4CF1E5); cor preta com alfa
 *         0,66 (0x595B60), que cai com a distância do receptor ao caster (inteira até 2 raios, zero em 4);
 *       - personagens não recebem a própria sombra (como nas capturas do jogo).
 *     Conferido também com o projeto "the-suffering-engine" (docs/re/renderer.md §4).
 *     Até 16 casters ao mesmo tempo (os mais perto da câmera), num atlas de 4×4 texturas.
 * EN: Re-creation of the game's projected shadows (one 256² silhouette texture per caster, rendered from the caster's
 *     strongest point light with the elevation clamped to 45°, projected on receivers, faded by N·L and camera distance).
 */
class RiotShadows {
  constructor(LevelView) {
    this.LevelView = LevelView;
    this.Max = 16;
    this.Tile = 256;
    this.Atlas = new THREE.WebGLRenderTarget(this.Tile * 4, this.Tile * 4, { depthBuffer: true });
    this.Atlas.texture.generateMipmaps = false;
    this.Atlas.texture.minFilter = this.Atlas.texture.magFilter = THREE.LinearFilter;
    this.Enabled = false;
    this.Highlight = false;
    this.FadeStart = 15;
    this.FadeEnd = 30;
    this.Overrides = new Map();     // PT: instância -> sombra ligada/desligada no editor / EN: editor-side toggles
    this.Casters = [];
    this.Active = [];
    this.Key = '';
    this.Scene = new THREE.Scene();
    this.Camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    const U = LevelView.Uniforms;
    U.ShadowCount = { value: 0 };
    U.ShadowDebug = { value: 0 };
    U.ShadowAtlas = { value: this.Atlas.texture };
    U.ShadowMatrix = { value: Array.from({ length: this.Max }, () => new THREE.Matrix4()) };
    U.ShadowDir = { value: Array.from({ length: this.Max }, () => new THREE.Vector4()) };      // xyz = para a luz, w = opacidade
    U.ShadowCenter = { value: Array.from({ length: this.Max }, () => new THREE.Vector4()) };   // xyz = centro, w = alcance
    U.ShadowTile = { value: Array.from({ length: this.Max }, () => new THREE.Vector2()) };
    this.Marker = null;
  }

  // ------------------------------------------------------------------ casters
  /** PT: Flag efetiva (veja o topo). EN: Effective flag. */
  Casts(Number) {
    if (this.LevelView.IsHidden && this.LevelView.IsHidden(Number)) return false;
    if (this.Overrides.has(Number)) return this.Overrides.get(Number);
    return Boolean((this.LevelView.Scene.Instances[Number][8] || 0) & 1);
  }

  SetOverride(Number, Value) {
    const Original = Boolean((this.LevelView.Scene.Instances[Number][8] || 0) & 1);
    if (Value === Original) this.Overrides.delete(Number); else this.Overrides.set(Number, Value);
    this.Build();
  }

  /** PT: Monta a lista de casters e as malhas de silhueta (chamado ao carregar a fase). EN: Builds the caster list. */
  Build() {
    for (const Caster of this.Casters) this.Scene.remove(Caster.Group);
    this.Casters = [];
    this.Key = '';
    const View = this.LevelView, Scene = View.Scene;
    if (!Scene) return;
    const Lights = Scene.Lights.filter(Light => Light[8] !== 0 && Light[6] > 0 && (View.ShowDormant || !Light[9])).map(Light => ({ P: new THREE.Vector3(Light[0], Light[1], Light[2]), I: Light[6],
      Rank: (0.212 * Light[3] + 0.701 * Light[4] + 0.087 * Light[5]) * Light[6],
      Cut: Math.sqrt(Math.max(0, 10 * (0.33 * Light[3] + 0.45 * Light[4] + 0.22 * Light[5]) * Light[6])) }));
    Scene.Instances.forEach((Instance, Number) => {
      if (Instance[0] === 'terrain' || !this.Casts(Number)) return;
      const Vertices = View.ModelVerts && View.ModelVerts.get(Instance[0]);
      const Slots = View.InstanceSlots.get(Number);
      if (!Vertices || !Slots) return;
      const Group = new THREE.Group();
      Group.matrixAutoUpdate = false;
      for (const [Mesh] of Slots) {
        const Source = Mesh.userData.OriginalMaterial || Mesh.material;
        if (Source.blending === THREE.CustomBlending || (Source.transparent && !Source.alphaTest && Mesh.userData.Group.b)) continue;
        const Material = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, map: Source.alphaTest ? Source.map : null, alphaTest: Source.alphaTest || 0 });
        const Part = new THREE.Mesh(Mesh.geometry, Material);
        Part.frustumCulled = false;
        Group.add(Part);
      }
      if (!Group.children.length) return;
      Group.visible = false;
      this.Scene.add(Group);
      const Sphere = Vertices.Box.getBoundingSphere(new THREE.Sphere());
      this.Casters.push({ Number, Group, Sphere, Slots, Lights, Matrix: new THREE.Matrix4(), Center: new THREE.Vector3(), Radius: 1, Dir: new THREE.Vector3(), HasLight: false });
    });
    // PT: casters não recebem a própria sombra / EN: casters do not receive their own shadow
    for (const Mesh of View.Meshes || []) {
      const Attribute = Mesh.geometry.attributes.ShadowSelf;
      if (Attribute) { Attribute.array.fill(0); Attribute.needsUpdate = true; }
    }
    for (const Caster of this.Casters) for (const [Mesh, Slot] of Caster.Slots) {
      const Attribute = Mesh.geometry.attributes.ShadowSelf;
      if (Attribute) { Attribute.array[Slot] = 1; Attribute.needsUpdate = true; }
    }
    this.UpdateMarker();
  }

  /** PT: Posição, raio e direção da luz atual de um caster. EN: Caster position, radius and light direction. */
  Place(Caster) {
    const Instance = this.LevelView.Scene.Instances[Caster.Number];
    this.LevelView.InstanceMatrix(Instance, Caster.Matrix);
    Caster.Group.matrix.copy(Caster.Matrix);
    Caster.Group.matrixWorldNeedsUpdate = true;
    Caster.Center.copy(Caster.Sphere.center).applyMatrix4(Caster.Matrix);
    Caster.Radius = Math.max(0.05, Caster.Sphere.radius * Math.max(...Instance[3].map(Math.abs)));
    let Best = null, Strength = 0;
    for (const Light of Caster.Lights) {
      const D2 = Light.P.distanceToSquared(Caster.Center);
      if (D2 >= Light.Cut * Light.Cut) continue;
      const Value = Light.Rank / (D2 + 1e-6);
      if (Value > Strength) { Strength = Value; Best = Light; }
    }
    Caster.HasLight = Boolean(Best);
    if (!Best) return;
    Caster.Dir.subVectors(Best.P, Caster.Center);
    if (Caster.Dir.lengthSq() < 1e-8) { Caster.HasLight = false; return; }
    Caster.Dir.normalize();
    // PT: luz abaixo de 45° sobe para 45° (0x4CC020) / EN: a light below 45° is raised to 45°
    if (Caster.Dir.y < Math.SQRT1_2) {
      const Flat = Math.hypot(Caster.Dir.x, Caster.Dir.z);
      Caster.Dir.set(Caster.Dir.x / Flat * Math.SQRT1_2, Math.SQRT1_2, Caster.Dir.z / Flat * Math.SQRT1_2);
    }
  }

  // ------------------------------------------------------------------ por quadro / per frame
  Update(Renderer, Camera) {
    const U = this.LevelView.Uniforms;
    if ((!this.Enabled && !this.Marker) || !this.Casters.length) { U.ShadowCount.value = 0; return; }
    for (const Caster of this.Casters) this.Place(Caster);
    if (this.Marker) {
      const Points = this.Marker.geometry.attributes.position;
      this.Casters.forEach((Caster, Index) => Points.setXYZ(Index, Caster.Center.x, Caster.Center.y + Caster.Radius * 1.1, Caster.Center.z));
      Points.needsUpdate = true;
    }
    if (!this.Enabled) { U.ShadowCount.value = 0; return; }
    const Eye = Camera.position, Cull = this.FadeEnd * 1.1;
    const Near = [];
    for (const Caster of this.Casters) {
      // PT: escondido pelo filtro de classes = não existe na cena / EN: hidden by the class filter = not in the scene
      if (!Caster.HasLight || !Caster.Slots[0][0].visible) continue;
      const Distance = Caster.Center.distanceTo(Eye);
      if (Distance > Cull) continue;
      Near.push([Distance, Caster]);
    }
    Near.sort((A, B) => A[0] - B[0]);
    this.Active = Near.slice(0, this.Max);
    U.ShadowCount.value = this.Active.length;
    if (!this.Active.length) return;
    const Previous = Renderer.getRenderTarget(), Color = Renderer.getClearColor(new THREE.Color()), Alpha = Renderer.getClearAlpha();
    const Bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    Renderer.setRenderTarget(this.Atlas);
    Renderer.setClearColor(0xffffff, 1);
    this.Atlas.scissorTest = true;   // PT: viewport/scissor do próprio alvo, sem mexer no do canvas / EN: target's own viewport
    this.Active.forEach(([Distance, Caster], Slot) => {
      const X = (Slot % 4) * this.Tile, Y = Math.floor(Slot / 4) * this.Tile, R = Caster.Radius * 1.05;
      this.Camera.left = -R; this.Camera.right = R; this.Camera.top = R; this.Camera.bottom = -R;
      this.Camera.near = 0.01; this.Camera.far = R * 6;
      this.Camera.position.copy(Caster.Center).addScaledVector(Caster.Dir, R * 3);
      this.Camera.up.set(0, 1, 0);
      if (Math.abs(Caster.Dir.y) > 0.99) this.Camera.up.set(0, 0, 1);
      this.Camera.lookAt(Caster.Center);
      this.Camera.updateProjectionMatrix();
      this.Camera.updateMatrixWorld();
      for (const Other of this.Casters) Other.Group.visible = Other === Caster;
      this.Atlas.viewport.set(X, Y, this.Tile, this.Tile);
      this.Atlas.scissor.set(X, Y, this.Tile, this.Tile);
      Renderer.setRenderTarget(this.Atlas);
      Renderer.clear(true, true, false);
      Renderer.render(this.Scene, this.Camera);
      U.ShadowMatrix.value[Slot].multiplyMatrices(Bias, this.Camera.projectionMatrix).multiply(this.Camera.matrixWorldInverse);
      const Fade = Distance <= this.FadeStart ? 1 : Math.max(0, 1 - (Distance - this.FadeStart) / Math.max(1e-3, this.FadeEnd - this.FadeStart));
      U.ShadowDir.value[Slot].set(Caster.Dir.x, Caster.Dir.y, Caster.Dir.z, Fade);
      U.ShadowCenter.value[Slot].set(Caster.Center.x, Caster.Center.y, Caster.Center.z, Caster.Radius * 4);
      U.ShadowTile.value[Slot].set((Slot % 4) * 0.25, Math.floor(Slot / 4) * 0.25);
    });
    for (const Caster of this.Casters) Caster.Group.visible = false;
    Renderer.setRenderTarget(Previous);
    Renderer.setClearColor(Color, Alpha);
  }

  // ------------------------------------------------------------------ destaque / highlight
  UpdateMarker() {
    const View = this.LevelView;
    if (this.Marker) { View.Viewport.Scene.remove(this.Marker); this.Marker.geometry.dispose(); this.Marker = null; }
    if (!this.Highlight || !this.Casters.length) return;
    const Points = [];
    for (const Caster of this.Casters) {
      this.Place(Caster);
      Points.push(Caster.Center.x, Caster.Center.y + Caster.Radius * 1.1, Caster.Center.z);
    }
    const Geometry = new THREE.BufferGeometry();
    Geometry.setAttribute('position', new THREE.Float32BufferAttribute(Points, 3));
    this.Marker = new THREE.Points(Geometry, new THREE.PointsMaterial({ color: 0xe0a33c, size: 7, sizeAttenuation: false, depthTest: false }));
    this.Marker.renderOrder = 10;
    View.Viewport.Scene.add(this.Marker);
  }

  Clear() {
    for (const Caster of this.Casters) {
      this.Scene.remove(Caster.Group);
      for (const Part of Caster.Group.children) Part.material.dispose();
    }
    this.Casters = [];
    this.Overrides.clear();
    if (this.Marker) { this.LevelView.Viewport.Scene.remove(this.Marker); this.Marker = null; }
    this.LevelView.Uniforms.ShadowCount.value = 0;
  }

  /** PT: Trecho GLSL dos receptores (entra no Lightify). EN: Receiver GLSL (injected by Lightify). */
  static get Vertex() {
    return `
vec4 RiotWorld = vec4(transformed, 1.0);
vec3 RiotNormal = objectNormal;
#ifdef USE_INSTANCING
RiotWorld = instanceMatrix * RiotWorld;
RiotNormal = mat3(instanceMatrix) * RiotNormal;
#endif
vShadowWorld = (modelMatrix * RiotWorld).xyz;
vShadowNormal = normalize(mat3(modelMatrix) * RiotNormal);
vShadowReceive = 1.0 - ShadowSelf;`;
  }

  static get Fragment() {
    return `
float RiotShadow = 1.0; vec3 RiotTint = vec3(0.0);
for (int Slot = 0; Slot < 16; Slot++) {
  if (Slot >= ShadowCount) break;
  vec3 ToCaster = vShadowWorld - ShadowCenter[Slot].xyz;
  if (dot(ToCaster, ToCaster) > ShadowCenter[Slot].w * ShadowCenter[Slot].w) continue;
  float Along = dot(ToCaster, ShadowDir[Slot].xyz);
  if (Along > 0.0 || -Along > ShadowCenter[Slot].w) continue;
  vec4 P = ShadowMatrix[Slot] * vec4(vShadowWorld, 1.0);
  if (P.x <= 0.0 || P.x >= 1.0 || P.y <= 0.0 || P.y >= 1.0) continue;
  float Facing = clamp((dot(normalize(vShadowNormal), ShadowDir[Slot].xyz) + 0.3) / 0.7, 0.0, 1.0);
  float Reach = clamp(2.0 - 2.0 * length(ToCaster) / ShadowCenter[Slot].w, 0.0, 1.0);
  float Silhouette = texture2D(ShadowAtlas, ShadowTile[Slot] + P.xy * 0.25).r;
  RiotShadow = min(RiotShadow, mix(1.0, Silhouette, 0.66 * Facing * Reach * ShadowDir[Slot].w * vShadowReceive));
  if (ShadowDebug > 0.5) RiotTint += vec3(0.25, 0.0, 0.0) + vec3(0.0, 0.0, 1.0 - Silhouette) + vec3(0.0, Facing * 0.3, 0.0);
}
outgoingLight *= RiotShadow;
outgoingLight += RiotTint;`;
  }
}
