/*
 * RiotCameraControls — câmera no estilo do Unreal Editor / Unreal Editor-style viewport camera
 *
 * PT: Mesmo esquema do visor em perspectiva do Unreal Engine:
 *       Botão direito + arrastar ........ olhar em volta
 *       Botão direito + W A S D ......... andar (Q desce, E sobe); a roda do mouse muda a velocidade
 *       Botão direito + Z / C ........... zoom (campo de visão) enquanto segura; solta e volta
 *       Botão esquerdo + arrastar ....... girar para os lados e andar para frente/trás no plano
 *       Botão do meio + arrastar ........ deslizar (lados e altura)
 *       Esquerdo + direito + arrastar ... subir/descer e deslizar para os lados
 *       Alt + esquerdo .................. orbitar em volta do ponto focado
 *       Alt + direito ................... aproximar/afastar do ponto focado
 *       Alt + meio ...................... deslizar
 *       Roda do mouse ................... andar para frente/trás
 *       Setas / PageUp / PageDown ....... andar sem segurar o mouse
 *       F ............................... enquadrar a seleção (feito pela aba)
 *       Shift ........................... 3× mais rápido
 *     Clique simples com o botão esquerdo (sem arrastar) continua selecionando objetos.
 * EN: Same scheme as the Unreal Engine perspective viewport (list above). A plain left click (no drag)
 *     still selects objects.
 */
class RiotCameraControls {
  constructor(Camera, Element) {
    this.Camera = Camera;
    this.Element = Element;
    this.Yaw = 0;
    this.Pitch = 0;
    this.FocusDistance = 20;
    this.SpeedLevels = [1, 2, 4, 8, 16, 32, 64, 128];
    this.SpeedIndex = 4;
    this.BaseFov = Camera.fov;
    this.Buttons = 0;
    this.Alt = false;
    this.Keys = {};
    this.Dragged = 0;
    this.OnSpeedChange = null;
    this.IsBlocked = () => false;
    this.LockRotation = false;     // PT: menu View → travar rotação / EN: View menu → lock rotation
    this.OnRotate = null;          // PT: avisado quando o usuário gira a vista / EN: called when the user turns the view   // PT: o gizmo bloqueia a câmera enquanto arrasta / EN: the gizmo blocks the camera while dragging
    this.Camera.rotation.order = 'YXZ';
    this.Bind();
  }

  get Speed() { return this.SpeedLevels[this.SpeedIndex]; }

  Forward(Out = new THREE.Vector3()) { return Out.set(0, 0, -1).applyEuler(this.Camera.rotation); }

  /** PT: Ponto focado (usado para orbitar). EN: Focus point (orbit pivot). */
  Pivot(Out = new THREE.Vector3()) { return this.Forward(Out).multiplyScalar(this.FocusDistance).add(this.Camera.position); }

  /** PT: Coloca a câmera em Position olhando para Target. EN: Places the camera at Position looking at Target. */
  SetView(Position, Target) {
    this.Camera.position.copy(Position);
    const Direction = new THREE.Vector3().subVectors(Target, Position);
    this.FocusDistance = Math.max(Direction.length(), 0.5);
    Direction.normalize();
    this.Yaw = Math.atan2(-Direction.x, -Direction.z);
    this.Pitch = Math.asin(THREE.MathUtils.clamp(Direction.y, -1, 1));
    this.ApplyRotation();
  }

  ApplyRotation(Exact) {
    const Limit = Exact ? Math.PI / 2 : Math.PI / 2 - 0.01;
    this.Pitch = THREE.MathUtils.clamp(this.Pitch, -Limit, Limit);
    this.Camera.rotation.set(this.Pitch, this.Yaw, 0, 'YXZ');
  }

  /** PT: Gira a vista pelo usuário (respeita a trava). EN: User rotation (honours the lock). */
  Turn(DeltaYaw, DeltaPitch) {
    if (this.LockRotation) return false;
    this.Yaw += DeltaYaw;
    this.Pitch += DeltaPitch;
    this.ApplyRotation();
    if (this.OnRotate) this.OnRotate();
    return true;
  }

  /**
   * PT: Vista de eixo (Top/Bottom/Front/Rear/Left/Right), mantendo o ponto focado e a distância.
   * EN: Axis view, keeping the focus point and distance.
   */
  SetAxisView(Name) {
    const Angles = { Top: [0, -Math.PI / 2], Bottom: [0, Math.PI / 2], Front: [0, 0], Rear: [Math.PI, 0], Right: [Math.PI / 2, 0], Left: [-Math.PI / 2, 0] }[Name];
    if (!Angles) return;
    const Pivot = this.Pivot();
    [this.Yaw, this.Pitch] = Angles;
    this.ApplyRotation(true);
    this.Camera.position.copy(Pivot).addScaledVector(this.Forward(), -this.FocusDistance);
  }

  Bind() {
    const Element = this.Element;
    Element.addEventListener('contextmenu', Event => Event.preventDefault());
    Element.addEventListener('pointerdown', Event => {
      Element.setPointerCapture(Event.pointerId);
      this.Buttons = Event.buttons;
      this.Alt = Event.altKey;
      this.Dragged = 0;
      if (Event.button === 1) Event.preventDefault();
    });
    Element.addEventListener('pointermove', Event => {
      if (!Event.buttons || this.IsBlocked()) return;
      this.Buttons = Event.buttons;
      this.Alt = Event.altKey;
      const Dx = Event.movementX || 0, Dy = Event.movementY || 0;
      this.Dragged += Math.abs(Dx) + Math.abs(Dy);
      this.Drag(Event.buttons, Dx, Dy, Event.altKey, Event.shiftKey);
    });
    const Release = Event => {
      this.Buttons = Event.buttons || 0;
      if (!(this.Buttons & 2)) this.Camera.fov !== this.BaseFov && this.SetFov(this.BaseFov);
    };
    Element.addEventListener('pointerup', Release);
    Element.addEventListener('pointercancel', Release);
    Element.addEventListener('wheel', Event => {
      Event.preventDefault();
      const Steps = Math.sign(Event.deltaY);
      if (this.Buttons & 2) {
        this.SpeedIndex = THREE.MathUtils.clamp(this.SpeedIndex - Steps, 0, this.SpeedLevels.length - 1);
        if (this.OnSpeedChange) this.OnSpeedChange(this.SpeedIndex + 1, this.Speed);
        return;
      }
      if (this.Viewport && this.Viewport.Orthographic) {
        // PT: na ortográfica a roda aproxima (muda o tamanho da vista) em volta do foco / EN: ortho: wheel zooms the view size
        const Pivot = this.Pivot();
        this.FocusDistance = THREE.MathUtils.clamp(this.FocusDistance * Math.pow(1.15, Steps), 0.3, 5000);
        this.Camera.position.copy(Pivot).addScaledVector(this.Forward(), -this.FocusDistance);
        return;
      }
      const Distance = -Steps * Math.max(this.Speed * 0.25, 0.5);
      this.Camera.position.addScaledVector(this.Forward(), Distance);
      this.FocusDistance = Math.max(this.FocusDistance - Distance, 0.5);
    }, { passive: false });
    const IsTyping = Target => /INPUT|SELECT|TEXTAREA/.test(Target.tagName);
    window.addEventListener('keydown', Event => {
      if (IsTyping(Event.target)) return;
      this.Keys[Event.key.toLowerCase()] = true;
      if ((this.Buttons & 2) && /^[wasdqezc]$/i.test(Event.key)) Event.preventDefault();
      if (/^(arrow|page)/i.test(Event.key)) Event.preventDefault();
    });
    window.addEventListener('keyup', Event => { this.Keys[Event.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => { this.Keys = {}; this.Buttons = 0; });
  }

  SetFov(Fov) {
    this.Camera.fov = Fov;
    this.Camera.updateProjectionMatrix();
  }

  Drag(Buttons, Dx, Dy, Alt, Shift) {
    const Left = Buttons & 1, Right = Buttons & 2, Middle = Buttons & 4;
    const Look = 0.0035, Move = Math.max(this.Speed * 0.02, 0.02) * (Shift ? 3 : 1);
    const Camera = this.Camera;
    const RightVector = new THREE.Vector3(1, 0, 0).applyEuler(Camera.rotation);
    if (Alt && Left && !Right) {                                    // orbitar / orbit
      const Pivot = this.Pivot();
      if (this.Turn(-Dx * Look, -Dy * Look)) Camera.position.copy(Pivot).addScaledVector(this.Forward(), -this.FocusDistance);
    } else if (Alt && Right && !Left) {                             // aproximar / dolly
      const Pivot = this.Pivot();
      this.FocusDistance = Math.max(this.FocusDistance * Math.exp((Dy - Dx) * 0.01), 0.3);
      Camera.position.copy(Pivot).addScaledVector(this.Forward(), -this.FocusDistance);
    } else if (Middle || (Left && Right) || (Alt && Middle)) {      // deslizar / pan (vertical + lateral)
      Camera.position.addScaledVector(RightVector, Dx * Move);
      Camera.position.y -= Dy * Move;
    } else if (Right) {                                            // olhar / look
      this.Turn(-Dx * Look, -Dy * Look);
    } else if (Left) {                                             // girar + andar no plano / yaw + move on ground
      this.Turn(-Dx * Look, 0);
      const Ground = this.Forward();
      Ground.y = 0;
      if (Ground.lengthSq() > 1e-6) Camera.position.addScaledVector(Ground.normalize(), -Dy * Move);
    }
  }

  /** PT: Chamado a cada quadro: teclado e zoom. EN: Called every frame: keyboard and zoom. */
  Update(Delta) {
    const Keys = this.Keys, Flying = this.Buttons & 2;
    const Step = this.Speed * (Keys.shift ? 3 : 1) * Delta;
    const Forward = this.Forward(), RightVector = new THREE.Vector3(1, 0, 0).applyEuler(this.Camera.rotation);
    const Move = new THREE.Vector3();
    if (Flying) {
      if (Keys.w) Move.add(Forward);
      if (Keys.s) Move.sub(Forward);
      if (Keys.d) Move.add(RightVector);
      if (Keys.a) Move.sub(RightVector);
      if (Keys.e) Move.y += 1;
      if (Keys.q) Move.y -= 1;
      const Target = Keys.z ? this.BaseFov * 0.35 : Keys.c ? Math.min(this.BaseFov * 1.6, 120) : this.BaseFov;
      if (Math.abs(this.Camera.fov - Target) > 0.05) this.SetFov(this.Camera.fov + (Target - this.Camera.fov) * Math.min(1, Delta * 8));
    }
    const Ground = Forward.clone();
    Ground.y = 0;
    if (Ground.lengthSq() > 1e-6) Ground.normalize();
    if (Keys.arrowup) Move.add(Ground);
    if (Keys.arrowdown) Move.sub(Ground);
    if (Keys.arrowright) Move.add(RightVector);
    if (Keys.arrowleft) Move.sub(RightVector);
    if (Keys.pageup) Move.y += 1;
    if (Keys.pagedown) Move.y -= 1;
    if (Move.lengthSq()) this.Camera.position.addScaledVector(Move.normalize(), Step);
  }
}
