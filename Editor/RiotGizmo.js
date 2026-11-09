/*
 * RiotGizmo — gizmos de mover, girar e escalar / move, rotate and scale gizmos
 *
 * PT: Usa o TransformControls do three.js num objeto "procurador" posicionado na instância selecionada e, a cada
 *     mudança, recalcula a matriz da instância do jeito do jogo (FUN_0045A5C0). Respeita o que o .lvl guarda:
 *       • posição: livre (ponto flutuante; no TS1 é gravada × 2048);
 *       • rotação: só GRAUS INTEIROS por eixo (3 × i16), na ordem Y·X·Z com yaw = arquivo − 90° → o gizmo encaixa
 *         em 1° no mínimo e os valores são arredondados;
 *       • escala: nos eixos do MUNDO (o motor escala as colunas da matriz) → o gizmo de escala usa sempre o espaço
 *         do mundo. Instâncias sem o bloco de escala (flag 0x100) vão precisar ganhar esse bloco ao salvar.
 *     Atalhos como no Unreal Editor (sem o botão direito apertado): Q selecionar, W mover, E girar, R escalar,
 *     espaço alterna, ` (crase) alterna local/mundo, Ctrl+Z / Ctrl+Y desfazer/refazer.
 *     Nada é gravado nos arquivos: as mudanças ficam só na memória do editor até existir a gravação do .lvl.
 * EN: three.js TransformControls on a proxy placed at the selected instance; every change rebuilds the instance
 *     matrix the game's way. Rotation is snapped to whole degrees (the .lvl stores 3 × i16 degrees), scale works on
 *     world axes. Unreal-style shortcuts (Q/W/E/R, space, `, Ctrl+Z/Y). Nothing is written to the files yet.
 */
class RiotGizmo {
  constructor(Viewport, LevelView, Ui) {
    this.Viewport = Viewport;
    this.LevelView = LevelView;
    this.Ui = Ui;
    this.Proxy = new THREE.Object3D();
    this.Proxy.rotation.order = 'YXZ';
    Viewport.Scene.add(this.Proxy);
    this.Controls = new THREE.TransformControls(Viewport.Camera, Viewport.Renderer.domElement);
    this.Controls.setSize(0.9);
    this.Controls.visible = false;
    this.Controls.enabled = false;
    Viewport.Scene.add(this.Controls);
    this.Mode = 'select';
    this.Shown = true;                  // PT: menu View → gizmo de transformação / EN: View menu → transform gizmo
    this.Space = 'world';
    this.TranslationSnap = 0;
    this.RotationSnap = 1;
    this.ScaleSnap = 0;
    this.Number = null;
    this.Before = null;
    this.UndoStack = [];
    this.RedoStack = [];
    this.Modified = new Map();          // PT: instância -> valores originais / EN: instance -> original values
    Viewport.Controls.IsBlocked = () => this.Controls.dragging;
    Viewport.IsPickBlocked = () => this.Controls.enabled && this.Controls.visible && !!this.Controls.axis;
    this.Controls.addEventListener('mouseDown', () => { this.Before = this.Values(this.Number); });
    this.Controls.addEventListener('objectChange', () => this.ApplyProxy());
    this.Controls.addEventListener('mouseUp', () => this.Commit());
    this.ApplySettings();
  }

  // ------------------------------------------------------------------ valores da instância / instance values
  Values(Number) {
    const Instance = this.LevelView.Scene.Instances[Number];
    return { Position: Instance[1].slice(), Rotation: Instance[2].slice(), Scale: Instance[3].slice() };
  }

  SetValues(Number, Values) {
    const Instance = this.LevelView.Scene.Instances[Number];
    Instance[1] = Values.Position.slice();
    Instance[2] = Values.Rotation.slice();
    Instance[3] = Values.Scale.slice();
    this.LevelView.UpdateInstance(Number);
    if (Number === this.Number) this.PlaceProxy();
    this.Ui.TransformChanged(Number, Instance, this.ModifiedCount());
  }

  ModifiedCount() {
    let Count = 0;
    for (const [Number, Original] of this.Modified) {
      const Now = this.Values(Number);
      if (JSON.stringify(Now) !== JSON.stringify(Original)) Count++;
    }
    return Count;
  }

  PlaceProxy() {
    const Instance = this.LevelView.Scene.Instances[this.Number], DegreesToRadians = Math.PI / 180;
    this.Proxy.position.set(Instance[1][0], Instance[1][1], Instance[1][2]);
    this.Proxy.rotation.set(Instance[2][0] * DegreesToRadians, (Instance[2][1] - 90) * DegreesToRadians, Instance[2][2] * DegreesToRadians, 'YXZ');
    this.Proxy.scale.set(Instance[3][0], Instance[3][1], Instance[3][2]);
    this.Proxy.updateMatrixWorld(true);
  }

  /** PT: Lê o procurador e grava na instância (rotação em graus inteiros). EN: Reads the proxy into the instance. */
  ApplyProxy() {
    if (this.Number === null) return;
    const Instance = this.LevelView.Scene.Instances[this.Number], RadiansToDegrees = 180 / Math.PI;
    const Euler = new THREE.Euler().setFromQuaternion(this.Proxy.quaternion, 'YXZ');
    const Wrap = Value => { let Degrees = Math.round(Value); while (Degrees > 180) Degrees -= 360; while (Degrees <= -180) Degrees += 360; return Degrees; };
    Instance[1] = [this.Proxy.position.x, this.Proxy.position.y, this.Proxy.position.z];
    Instance[2] = [Wrap(Euler.x * RadiansToDegrees), Wrap(Euler.y * RadiansToDegrees + 90), Wrap(Euler.z * RadiansToDegrees)];
    Instance[3] = [this.Proxy.scale.x, this.Proxy.scale.y, this.Proxy.scale.z].map(Value => Math.max(Math.abs(Value), 0.001) * Math.sign(Value || 1));
    if (!this.Modified.has(this.Number)) this.Modified.set(this.Number, this.Before || this.Values(this.Number));
    this.LevelView.UpdateInstance(this.Number);
    this.Ui.TransformChanged(this.Number, Instance, this.ModifiedCount());
  }

  /**
   * PT: Alinha o objeto selecionado à câmera (posição + rotação, ou só rotação), com desfazer.
   * EN: Aligns the selected object with the camera (position + rotation, or rotation only), undoable.
   */
  AlignToView(Camera, WithPosition) {
    if (this.Number === null) return false;
    this.Before = this.Values(this.Number);
    if (WithPosition) this.Proxy.position.copy(Camera.position);
    this.Proxy.quaternion.copy(Camera.quaternion);
    this.Proxy.updateMatrixWorld(true);
    this.ApplyProxy();
    this.Commit();
    return true;
  }

  Commit() {
    if (this.Number === null || !this.Before) return;
    const After = this.Values(this.Number);
    if (JSON.stringify(After) !== JSON.stringify(this.Before)) {
      this.UndoStack.push({ Number: this.Number, Before: this.Before, After });
      this.RedoStack = [];
      if (this.UndoStack.length > 200) this.UndoStack.shift();
    }
    this.Before = null;
    this.PlaceProxy();
    this.Ui.TransformChanged(this.Number, this.LevelView.Scene.Instances[this.Number], this.ModifiedCount());
  }

  Undo() {
    const Step = this.UndoStack.pop();
    if (!Step) return false;
    this.RedoStack.push(Step);
    if (Step.Kind) this.Ui.StructureStep(Step, true);    // PT: colar / apagar / EN: paste / delete
    else this.SetValues(Step.Number, Step.Before);
    return true;
  }

  Redo() {
    const Step = this.RedoStack.pop();
    if (!Step) return false;
    this.UndoStack.push(Step);
    if (Step.Kind) this.Ui.StructureStep(Step, false);
    else this.SetValues(Step.Number, Step.After);
    return true;
  }

  /** PT: Registra um passo de colar/apagar no desfazer. EN: Records a paste/delete step for undo. */
  PushStep(Step) {
    this.UndoStack.push(Step);
    this.RedoStack = [];
    if (this.UndoStack.length > 200) this.UndoStack.shift();
  }

  // ------------------------------------------------------------------ seleção e modos / selection and modes
  /** PT: Prende o gizmo na instância (ou solta, com null). EN: Attaches the gizmo to an instance (or detaches with null). */
  Attach(Number) {
    const Instances = this.LevelView.Scene ? this.LevelView.Scene.Instances : null;
    if (Number === null || !Instances || Instances[Number][0] === 'terrain') {
      this.Number = null;
      this.Controls.detach();
      this.ApplySettings();
      return;
    }
    this.Number = Number;
    this.PlaceProxy();
    this.Controls.attach(this.Proxy);
    this.ApplySettings();
  }

  SetMode(Mode) {
    this.Mode = Mode;
    this.ApplySettings();
    this.Ui.GizmoChanged(this);
  }

  CycleMode() {
    const Order = ['translate', 'rotate', 'scale'];
    this.SetMode(Order[(Order.indexOf(this.Mode) + 1) % Order.length]);
  }

  ToggleSpace() {
    this.Space = this.Space === 'world' ? 'local' : 'world';
    this.ApplySettings();
    this.Ui.GizmoChanged(this);
  }

  ApplySettings() {
    const Active = this.Mode !== 'select' && this.Number !== null;
    this.Controls.enabled = Active;
    this.Controls.visible = Active && this.Shown;
    if (this.Mode !== 'select') this.Controls.setMode(this.Mode);
    this.Controls.setSpace(this.Mode === 'scale' ? 'world' : this.Space);
    this.Controls.setTranslationSnap(this.TranslationSnap || null);
    this.Controls.setRotationSnap(THREE.MathUtils.degToRad(Math.max(1, this.RotationSnap)));
    this.Controls.setScaleSnap(this.ScaleSnap || null);
  }

  /** PT: Esquece tudo ao trocar de fase. EN: Forgets everything when the level changes. */
  Reset() {
    this.Attach(null);
    this.UndoStack = [];
    this.RedoStack = [];
    this.Modified = new Map();
  }
}
