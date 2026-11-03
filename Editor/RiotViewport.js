/*
 * RiotViewport — visor 3D compartilhado pelas abas / 3D viewport shared by the tabs.
 *
 * PT: Cria o renderizador three.js, a câmera (controles no estilo do Unreal Editor, ver RiotCameraControls.js),
 *     o clique para selecionar e os modos de renderização (com/sem textura, wireframe).
 *     As normais são desenhadas como linhas pela aba (RiotLevelView.ShowNormals), como no Blender.
 * EN: three.js renderer, camera (Unreal Editor-style controls, see RiotCameraControls.js), click picking and
 *     render modes (textured / untextured, wireframe).
 */
/*
 * PT: Remendo do three r147: se o objeto tem userData.CullSphere (esfera de todas as instâncias de uma InstancedMesh),
 *     o descarte por frustum usa ela em vez da esfera da geometria.
 * EN: three r147 patch: frustum culling uses userData.CullSphere (all instances of an InstancedMesh) when present.
 */
(() => {
  const Original = THREE.Frustum.prototype.intersectsObject;
  THREE.Frustum.prototype.intersectsObject = function (Object_) {
    const Sphere = Object_.userData && Object_.userData.CullSphere;
    return Sphere ? this.intersectsSphere(Sphere) : Original.call(this, Object_);
  };
})();

class RiotViewport {
  constructor(Container) {
    this.Container = Container;
    // PT: pede a placa de vídeo dedicada (notebooks com duas GPUs) / EN: asks for the discrete GPU (dual-GPU laptops)
    this.Renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.ResolutionScale = 1;
    try { this.ResolutionScale = Number(localStorage.getItem('SurrealEdResolution') || 1) || 1; } catch (Error) { /* sem armazenamento / no storage */ }
    this.Renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * this.ResolutionScale);
    this.Stats = { Frames: 0, Logic: 0, Draw: 0, Since: performance.now(), Fps: 0, LogicMs: 0, DrawMs: 0 };
    this.Renderer.outputEncoding = THREE.sRGBEncoding;
    Container.appendChild(this.Renderer.domElement);
    this.Scene = new THREE.Scene();
    this.Scene.background = new THREE.Color(0x0d0f0c);
    this.Scene.fog = new THREE.Fog(0x0d0f0c, 120, 420);
    this.Scene.add(new THREE.HemisphereLight(0xfff3d6, 0x23281f, 0.9));
    const Sun = new THREE.DirectionalLight(0xffe2ad, 0.55);
    Sun.position.set(0.4, 1, 0.25);
    this.Scene.add(Sun);
    this.Camera = new THREE.PerspectiveCamera(60, 1, 0.05, 4000);
    this.Controls = new RiotCameraControls(this.Camera, this.Renderer.domElement);
    this.Pickables = [];
    this.OnPick = null;
    this.OnFrame = null;
    this.RenderMode = { Textured: true, Wireframe: false };
    this.Clock = new THREE.Clock();
    this.Raycaster = new THREE.Raycaster();
    this.Pointer = new THREE.Vector2();
    this.Highlight = new THREE.Box3Helper(new THREE.Box3(), 0xe0a33c);
    this.Highlight.visible = false;
    this.Scene.add(this.Highlight);
    this.BindEvents();
    new ResizeObserver(() => this.Resize()).observe(Container);
    this.Resize();
    this.Loop();
  }

  Resize() {
    const Width = Math.max(1, this.Container.clientWidth), Height = Math.max(1, this.Container.clientHeight);
    this.Renderer.setSize(Width, Height, false);
    this.Camera.aspect = Width / Height;
    this.Camera.updateProjectionMatrix();
  }

  BindEvents() {
    const Canvas = this.Renderer.domElement;
    let Down = null;
    this.IsPickBlocked = () => false;   // PT: clique no gizmo não seleciona / EN: clicking the gizmo does not pick
    Canvas.addEventListener('pointerdown', Event => { Down = this.IsPickBlocked() ? null : [Event.clientX, Event.clientY]; });
    Canvas.addEventListener('pointerup', Event => {
      if (!Down || Math.hypot(Event.clientX - Down[0], Event.clientY - Down[1]) > 4 || Event.button !== 0 || Event.altKey) return;
      const Rect = Canvas.getBoundingClientRect();
      this.Pointer.set(((Event.clientX - Rect.left) / Rect.width) * 2 - 1, -((Event.clientY - Rect.top) / Rect.height) * 2 + 1);
      this.Raycaster.setFromCamera(this.Pointer, this.Camera);
      // PT: ícones (luzes) primeiro: ficam por cima de tudo / EN: icons (lights) first, they are drawn on top
      const Markers = (this.Markers || []).filter(Marker => Marker.visible && Marker.parent && Marker.parent.visible);
      const Hit = this.Raycaster.intersectObjects(Markers, false)[0] || this.Raycaster.intersectObjects(this.Pickables.filter(Mesh => Mesh.visible), false)[0] || null;
      if (this.OnPick) this.OnPick(Hit);
    });
  }

  Loop() {
    this.Active = true;
    const Step = () => {
      const Delta = Math.min(this.Clock.getDelta(), 0.1);
      if (!this.Active) { requestAnimationFrame(Step); return; }   // PT: aba escondida não desenha / EN: hidden tab does not render
      const LogicStart = performance.now();
      this.Controls.Update(Delta);
      if (this.OnFrame) this.OnFrame(Delta);
      const DrawStart = performance.now();
      if (this.SkyScene && this.SkyScene.visible) {
        // PT: céu primeiro, centrado na câmera e sem profundidade; depois a fase por cima
        // EN: sky first, centred on the camera without depth; then the level on top
        const Background = this.Scene.background;
        this.Renderer.autoClear = false;
        this.Renderer.setClearColor(Background || 0x000000);
        this.Renderer.clear();
        this.SkyCamera = this.SkyCamera || new THREE.PerspectiveCamera();
        this.SkyCamera.copy(this.Camera);
        this.SkyCamera.position.set(0, 0, 0);
        this.SkyCamera.updateMatrixWorld();
        this.Renderer.render(this.SkyScene, this.SkyCamera);
        this.Renderer.clearDepth();
        this.Scene.background = null;
        this.Renderer.render(this.Scene, this.Camera);
        this.Scene.background = Background;
        this.Renderer.autoClear = true;
      } else this.Renderer.render(this.Scene, this.Camera);
      this.CountFrame(DrawStart - LogicStart, performance.now() - DrawStart);
      requestAnimationFrame(Step);
    };
    requestAnimationFrame(Step);
  }

  /**
   * PT: Estatística de desempenho (média de ~1 s): quadros por segundo, tempo de lógica (JavaScript: partículas,
   *     ícones, sombras...) e de envio do desenho (CPU; o trabalho da GPU roda em paralelo e aparece no FPS).
   * EN: Performance stats (~1 s average): FPS, logic time (JavaScript) and draw submission time (CPU side).
   */
  CountFrame(LogicMs, DrawMs) {
    const S = this.Stats;
    S.Frames++; S.Logic += LogicMs; S.Draw += DrawMs;
    const Now = performance.now();
    if (Now - S.Since < 1000) return;
    S.Fps = S.Frames * 1000 / (Now - S.Since);
    S.LogicMs = S.Logic / S.Frames; S.DrawMs = S.Draw / S.Frames;
    S.Calls = this.Renderer.info.render.calls; S.Triangles = this.Renderer.info.render.triangles;
    S.Frames = 0; S.Logic = 0; S.Draw = 0; S.Since = Now;
    if (this.OnStats) this.OnStats(S);
  }

  /** PT: Nome da GPU que o navegador está usando (WEBGL_debug_renderer_info). EN: GPU the browser is using. */
  GpuName() {
    const Gl = this.Renderer.getContext();
    const Info = Gl.getExtension('WEBGL_debug_renderer_info');
    return String(Info ? Gl.getParameter(Info.UNMASKED_RENDERER_WEBGL) : Gl.getParameter(Gl.RENDERER));
  }

  /** PT: A GPU informada é um renderizador por software? EN: Is the reported GPU a software rasterizer? */
  IsSoftware() {
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render|WARP|Mesa OffScreen/i.test(this.GpuName());
  }

  /** PT: Resolução interna (1 = nativa). EN: Internal resolution (1 = native). */
  SetResolution(Scale) {
    this.ResolutionScale = Scale;
    try { localStorage.setItem('SurrealEdResolution', String(Scale)); } catch (Error) { /* sem armazenamento / no storage */ }
    this.Renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * Scale);
    this.Resize();
  }

  /** PT: Câmera em Position olhando para Target. EN: Camera at Position looking at Target. */
  SetView(Position, Target) { this.Controls.SetView(Position, Target); }

  /** PT: Ponto focado pela câmera. EN: Camera focus point. */
  Pivot() { return this.Controls.Pivot(); }

  /** PT: Aponta a câmera para uma caixa. EN: Frames a box. */
  FrameBox(Box, Distance = 1.6) {
    const Center = Box.getCenter(new THREE.Vector3()), Size = Box.getSize(new THREE.Vector3());
    const Radius = Math.max(Size.length() * 0.5, 1.5);
    this.SetView(new THREE.Vector3(Center.x + Radius * Distance * 0.6, Center.y + Radius * Distance * 0.7, Center.z + Radius * Distance * 0.9), Center);
  }

  /** PT: Mostra ou esconde a caixa de destaque. EN: Shows or hides the highlight box. */
  SetHighlight(Box) {
    if (!Box) { this.Highlight.visible = false; return; }
    this.Highlight.box.copy(Box);
    this.Highlight.visible = true;
  }

  /**
   * PT: Aplica os modos de renderização a todas as malhas registradas (guardando o material original).
   * EN: Applies render modes to every registered mesh (keeping the original material).
   */
  ApplyRenderMode() {
    for (const Mesh of this.Pickables) {
      if (!Mesh.userData.OriginalMaterial) Mesh.userData.OriginalMaterial = Mesh.material;
      const Original = Mesh.userData.OriginalMaterial;
      let Material = Original;
      if (!this.RenderMode.Textured) {
        if (!Mesh.userData.PlainMaterial) Mesh.userData.PlainMaterial = Mesh.userData.MakePlain ? Mesh.userData.MakePlain() : Original;
        Material = Mesh.userData.PlainMaterial;
      }
      Material.wireframe = this.RenderMode.Wireframe;
      Mesh.material = Material;
    }
  }

  /** PT: Remove e libera tudo o que foi registrado. EN: Removes and disposes everything registered. */
  Clear() {
    for (const Mesh of this.Pickables) {
      this.Scene.remove(Mesh);
      Mesh.geometry.dispose();
      for (const Key of ['OriginalMaterial', 'PlainMaterial']) if (Mesh.userData[Key]) Mesh.userData[Key].dispose();
      Mesh.material.dispose();
    }
    this.Pickables = [];
    this.SetHighlight(null);
  }
}
