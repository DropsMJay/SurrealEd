/*
 * RiotColorPicker — seletor de cor em roda / colour wheel picker
 *
 * PT: No estilo do Color Picker do UMG: roda de matiz/saturação, barra de valor (brilho), cores antiga e nova,
 *     controles R, G, B e H, S, V de 0 a 1 com o degradê de cada canal, e campo hexadecimal.
 *     new RiotColorPicker(Container, { Color: [r, g, b], OnChange(rgb, Final), Labels })
 * EN: UMG-style picker: hue/saturation wheel, value bar, old/new swatches, R G B / H S V controls (0..1) with
 *     per-channel gradients and a hex field.
 */
class RiotColorPicker {
  constructor(Container, Options) {
    this.Options = Options || {};
    this.Old = (this.Options.Color || [1, 1, 1]).slice();
    this.Hsv = RiotColorPicker.ToHsv(this.Old);
    this.Root = document.createElement('div');
    this.Root.className = 'ColorPicker';
    this.Root.innerHTML = `
      <div class="CpTop">
        <canvas class="CpWheel" width="180" height="180" aria-label="Hue and saturation"></canvas>
        <canvas class="CpValue" width="18" height="180" aria-label="Value"></canvas>
        <div class="CpSwatches"><span>${this.Label('Old')}</span><button type="button" class="CpOld" title="${this.Label('Restore')}"></button>
          <button type="button" class="CpNew" disabled></button><span>${this.Label('New')}</span></div>
      </div>
      <div class="CpSliders"></div>
      <label class="CpHex">Hex <input type="text" maxlength="7" spellcheck="false"></label>`;
    Container.appendChild(this.Root);
    this.Wheel = this.Root.querySelector('.CpWheel');
    this.ValueBar = this.Root.querySelector('.CpValue');
    this.Sliders = {};
    const Box = this.Root.querySelector('.CpSliders');
    for (const Key of ['R', 'G', 'B', 'H', 'S', 'V']) {
      const Row = document.createElement('label');
      Row.className = 'CpRow';
      Row.innerHTML = `<b>${Key}</b><span class="CpTrack"><input type="range" min="0" max="1" step="0.001"></span><input type="number" min="0" max="1" step="0.01">`;
      Box.appendChild(Row);
      const [Range, Number] = Row.querySelectorAll('input');
      const Update = Value => this.SetChannel(Key, Math.max(0, Math.min(1, +Value || 0)), false);
      Range.addEventListener('input', () => Update(Range.value));
      Range.addEventListener('change', () => this.Emit(true));
      Number.addEventListener('change', () => { Update(Number.value); this.Emit(true); });
      this.Sliders[Key] = { Row, Range, Number, Track: Row.querySelector('.CpTrack') };
    }
    this.Hex = this.Root.querySelector('.CpHex input');
    this.Hex.addEventListener('change', () => {
      const Match = /^#?([0-9a-f]{6})$/i.exec(this.Hex.value.trim());
      if (Match) { const Value = parseInt(Match[1], 16); this.SetRgb([(Value >> 16 & 255) / 255, (Value >> 8 & 255) / 255, (Value & 255) / 255], true); }
    });
    this.Root.querySelector('.CpOld').addEventListener('click', () => this.SetRgb(this.Old, true));
    this.Drag(this.Wheel, (X, Y) => {
      const Radius = this.Wheel.width / 2, Dx = X - Radius, Dy = Y - Radius;
      this.Hsv[0] = ((Math.atan2(Dy, Dx) / (2 * Math.PI)) + 1) % 1;
      this.Hsv[1] = Math.min(1, Math.hypot(Dx, Dy) / (Radius - 2));
      this.Refresh();
      this.Emit(false);
    });
    this.Drag(this.ValueBar, (_X, Y) => { this.Hsv[2] = 1 - Math.max(0, Math.min(1, Y / this.ValueBar.height)); this.Refresh(); this.Emit(false); });
    this.DrawWheel();
    this.Refresh();
  }

  Label(Key) { return (this.Options.Labels && this.Options.Labels[Key]) || Key; }

  Drag(Canvas, OnMove) {
    const Move = Event => {
      const Box = Canvas.getBoundingClientRect();
      OnMove((Event.clientX - Box.left) * Canvas.width / Box.width, (Event.clientY - Box.top) * Canvas.height / Box.height);
    };
    Canvas.addEventListener('pointerdown', Event => {
      Canvas.setPointerCapture(Event.pointerId);
      Move(Event);
      const Up = () => { Canvas.removeEventListener('pointermove', Move); Canvas.removeEventListener('pointerup', Up); this.Emit(true); };
      Canvas.addEventListener('pointermove', Move);
      Canvas.addEventListener('pointerup', Up);
    });
  }

  get Rgb() { return RiotColorPicker.ToRgb(this.Hsv); }

  SetRgb(Rgb, Final) { this.Hsv = RiotColorPicker.ToHsv(Rgb, this.Hsv[0]); this.Refresh(); this.Emit(Final); }

  /** PT: Muda a cor sem avisar (ex.: outra luz selecionada). EN: Sets the colour silently. */
  Set(Rgb, ResetOld) { if (ResetOld) this.Old = Rgb.slice(); this.Hsv = RiotColorPicker.ToHsv(Rgb, this.Hsv[0]); this.Refresh(); }

  SetChannel(Key, Value, Final) {
    if ('RGB'.includes(Key)) { const Rgb = this.Rgb; Rgb['RGB'.indexOf(Key)] = Value; this.Hsv = RiotColorPicker.ToHsv(Rgb, this.Hsv[0]); }
    else this.Hsv['HSV'.indexOf(Key)] = Key === 'H' ? Value % 1 : Value;
    this.Refresh();
    this.Emit(Final);
  }

  Emit(Final) { if (this.Options.OnChange) this.Options.OnChange(this.Rgb, Final); }

  DrawWheel() {
    const Context = this.Wheel.getContext('2d'), Size = this.Wheel.width, Radius = Size / 2 - 2;
    const Image = Context.createImageData(Size, Size);
    for (let Y = 0; Y < Size; Y++) for (let X = 0; X < Size; X++) {
      const Dx = X - Size / 2, Dy = Y - Size / 2, Distance = Math.hypot(Dx, Dy), Target = 4 * (Y * Size + X);
      if (Distance > Radius + 1) continue;
      const [R, G, B] = RiotColorPicker.ToRgb([((Math.atan2(Dy, Dx) / (2 * Math.PI)) + 1) % 1, Math.min(1, Distance / Radius), 1]);
      Image.data[Target] = R * 255; Image.data[Target + 1] = G * 255; Image.data[Target + 2] = B * 255;
      Image.data[Target + 3] = 255 * Math.max(0, Math.min(1, Radius + 1 - Distance));
    }
    this.WheelImage = Image;
  }

  Refresh() {
    const [H, S, V] = this.Hsv, Rgb = this.Rgb;
    // PT: roda escurecida pelo valor, como no UMG / EN: wheel dimmed by the value, as in UMG
    const Context = this.Wheel.getContext('2d'), Size = this.Wheel.width;
    Context.clearRect(0, 0, Size, Size);
    Context.putImageData(this.WheelImage, 0, 0);
    Context.fillStyle = `rgba(0,0,0,${1 - V})`;
    Context.beginPath(); Context.arc(Size / 2, Size / 2, Size / 2 - 1, 0, Math.PI * 2); Context.fill();
    const Angle = H * 2 * Math.PI, Radius = S * (Size / 2 - 2);
    Context.strokeStyle = V > 0.5 ? '#000' : '#fff';
    Context.lineWidth = 2;
    Context.beginPath(); Context.arc(Size / 2 + Math.cos(Angle) * Radius, Size / 2 + Math.sin(Angle) * Radius, 5, 0, Math.PI * 2); Context.stroke();
    const Bar = this.ValueBar.getContext('2d'), Height = this.ValueBar.height;
    const Full = RiotColorPicker.ToRgb([H, S, 1]).map(Value => Math.round(Value * 255));
    const Gradient = Bar.createLinearGradient(0, 0, 0, Height);
    Gradient.addColorStop(0, `rgb(${Full})`); Gradient.addColorStop(1, '#000');
    Bar.fillStyle = Gradient; Bar.fillRect(0, 0, this.ValueBar.width, Height);
    Bar.strokeStyle = V > 0.5 ? '#000' : '#fff'; Bar.lineWidth = 2; Bar.strokeRect(1, (1 - V) * Height - 2, this.ValueBar.width - 2, 4);
    const Css = Color => `rgb(${Color.map(Value => Math.round(Value * 255)).join(',')})`;
    this.Root.querySelector('.CpOld').style.background = Css(this.Old);
    this.Root.querySelector('.CpNew').style.background = Css(Rgb);
    const Values = { R: Rgb[0], G: Rgb[1], B: Rgb[2], H, S, V };
    const Gradients = {
      R: [[0, Rgb[1], Rgb[2]], [1, Rgb[1], Rgb[2]]], G: [[Rgb[0], 0, Rgb[2]], [Rgb[0], 1, Rgb[2]]], B: [[Rgb[0], Rgb[1], 0], [Rgb[0], Rgb[1], 1]],
      S: [RiotColorPicker.ToRgb([H, 0, V]), RiotColorPicker.ToRgb([H, 1, V])], V: [[0, 0, 0], RiotColorPicker.ToRgb([H, S, 1])],
    };
    for (const [Key, Slider] of Object.entries(this.Sliders)) {
      Slider.Range.value = Values[Key];
      if (document.activeElement !== Slider.Number) Slider.Number.value = Values[Key].toFixed(3);
      Slider.Track.style.background = Key === 'H'
        ? 'linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)'
        : `linear-gradient(90deg, ${Css(Gradients[Key][0])}, ${Css(Gradients[Key][1])})`;
    }
    if (document.activeElement !== this.Hex) this.Hex.value = RiotColorPicker.Hex(Rgb);
  }

  static Hex(Rgb) { return Rgb.map(Value => Math.round(Math.max(0, Math.min(1, Value)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase(); }

  static ToHsv([R, G, B], KeepHue) {
    const Max = Math.max(R, G, B), Min = Math.min(R, G, B), Delta = Max - Min;
    let H = KeepHue || 0;
    if (Delta > 1e-6) {
      if (Max === R) H = ((G - B) / Delta) % 6; else if (Max === G) H = (B - R) / Delta + 2; else H = (R - G) / Delta + 4;
      H = ((H / 6) + 1) % 1;
    }
    return [H, Max > 0 ? Delta / Max : 0, Max];
  }

  static ToRgb([H, S, V]) {
    const I = Math.floor(H * 6), F = H * 6 - I, P = V * (1 - S), Q = V * (1 - F * S), T = V * (1 - (1 - F) * S);
    return [[V, T, P], [Q, V, P], [P, V, T], [P, Q, V], [T, P, V], [V, P, Q]][((I % 6) + 6) % 6];
  }
}
