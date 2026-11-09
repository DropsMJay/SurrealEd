/*
 * RiotScreenOverlay — títulos e flashes por cima do visor / titles and flashes over the viewport
 *
 * PT: Desenha, num canvas 2D por cima do visor, o que as mensagens de uma sequência põem na tela na TTB (o servidor
 *     descreve em Event.Screen, Riot/RiotScreenFx.py — tudo lido no SufferingTTB.rfl, nota 9z9):
 *       • 'hud' (GUI Launcher → Simple Text HUD → HUD Texture): cada textura num retângulo em % da tela; fica
 *         Timing.Hold s (o menor entre o widget e o filho); com Slide > 0 entra e sai deslizando de From (%).
 *       • 'fade' (Screen Fader): tela cheia, textura (ou só a cor) × cor; alfa = Alpha × (1 − t/In), depois Alpha por
 *         Hold s, depois Alpha × t/Out. A mistura do jogo não foi lida: aqui é alfa comum.
 *     As texturas vêm da aba Textures (RiotAssetTabs.Shared.TextureImage, já desviradas).
 * EN: Draws, on a 2D canvas over the viewport, the on-screen effects described by the server in Event.Screen.
 */
class RiotScreenOverlay {
  constructor(Host) {
    this.Host = Host;
    this.Canvas = document.createElement('canvas');
    this.Canvas.className = 'ScreenOverlay';
    this.Host.appendChild(this.Canvas);
    this.Images = new Map();   // PT: textura → canvas (ou Promise) / EN: texture → canvas (or Promise)
    this.Events = [];
  }

  /** PT: Eventos de tela da sequência, em ordem. EN: The sequence's screen events, in time order. */
  SetSequence(Sequence) {
    this.Events = [];
    for (const Track of Sequence.Tracks) for (const Event of Track.Events) {
      for (const Screen of Event.Screen || []) this.Events.push({ Time: Event.Time, Screen });
    }
    this.Events.sort((A, B) => A.Time - B.Time);
    for (const { Screen } of this.Events) {
      if (Screen.Texture) this.Image(Screen.Texture);
      for (const Item of Screen.Items || []) if (Item.Texture) this.Image(Item.Texture);
    }
  }

  Image(Code) {
    if (this.Images.has(Code)) return this.Images.get(Code);
    const Pending = RiotAssetTabs.Shared.TextureImage(Code).then(Data => {
      if (!Data) { this.Images.set(Code, null); return null; }
      const Canvas = document.createElement('canvas');
      Canvas.width = Data.width; Canvas.height = Data.height;
      Canvas.getContext('2d').putImageData(Data, 0, 0);
      this.Images.set(Code, Canvas);
      if (this.LastTime !== undefined) this.Draw(this.LastTime);
      return Canvas;
    }).catch(() => { this.Images.set(Code, null); return null; });
    this.Images.set(Code, Pending);
    return Pending;
  }

  Ready(Code) { const Image_ = this.Images.get(Code); return Image_ instanceof HTMLCanvasElement ? Image_ : null; }

  /** PT: Posição deslizando (entra de From até Rect, sai de volta). EN: Slide in from From, slide back out. */
  static Placed(Rect, Timing, Elapsed, Hold) {
    const Slide = Timing && Timing.Slide > 0 ? Timing.Slide : 0;
    if (!Slide) return Rect;
    let Factor = 1;
    if (Elapsed < Slide) Factor = Elapsed / Slide;
    else if (Hold !== null && Elapsed > Slide + Hold) Factor = Math.max(0, 1 - (Elapsed - Slide - Hold) / Slide);
    return [Timing.From[0] + (Rect[0] - Timing.From[0]) * Factor, Timing.From[1] + (Rect[1] - Timing.From[1]) * Factor, Rect[2], Rect[3]];
  }

  static Lifetime(Timing) {
    if (!Timing || Timing.Hold === null || Timing.Hold === undefined) return null;
    return Timing.Hold + 2 * (Timing.Slide > 0 ? Timing.Slide : 0);
  }

  Draw(Time) {
    this.LastTime = Time;
    const Width = this.Host.clientWidth, Height = this.Host.clientHeight, Ratio = window.devicePixelRatio || 1;
    if (this.Canvas.width !== Math.round(Width * Ratio) || this.Canvas.height !== Math.round(Height * Ratio)) {
      this.Canvas.width = Math.round(Width * Ratio); this.Canvas.height = Math.round(Height * Ratio);
    }
    const Context = this.Canvas.getContext('2d');
    Context.setTransform(Ratio, 0, 0, Ratio, 0, 0);
    Context.clearRect(0, 0, Width, Height);
    let Drawn = 0;
    for (const { Time: Start, Screen } of this.Events) {
      const Elapsed = Time - Start;
      if (Elapsed < 0) break;
      if (Screen.Kind === 'fade') {
        const In = Screen.In || 0, Hold = Screen.Hold || 0, Out = Screen.Out || 0;
        let Alpha;
        if (Elapsed < In) Alpha = Screen.Alpha * (Elapsed / In);
        else if (Elapsed < In + Hold) Alpha = Screen.Alpha;
        else if (Elapsed < In + Hold + Out) Alpha = Screen.Alpha * (1 - (Elapsed - In - Hold) / Out);
        else continue;
        Context.globalAlpha = Math.max(0, Math.min(1, Alpha));
        const Image_ = Screen.Texture ? this.Ready(Screen.Texture) : null;
        if (Image_) {
          Context.drawImage(Image_, 0, 0, Width, Height);
          if (Screen.Color && Screen.Color.toLowerCase() !== '#ffffff') {
            Context.globalCompositeOperation = 'multiply'; Context.fillStyle = Screen.Color; Context.fillRect(0, 0, Width, Height);
            Context.globalCompositeOperation = 'source-over';
          }
        } else if (!Screen.Texture) { Context.fillStyle = Screen.Color || '#000'; Context.fillRect(0, 0, Width, Height); }
        Drawn++;
      } else if (Screen.Kind === 'hud') {
        const Life = RiotScreenOverlay.Lifetime(Screen.Timing);
        if (Life !== null && Elapsed >= Life) continue;
        for (const Item of Screen.Items) {
          const ItemLife = RiotScreenOverlay.Lifetime(Item.Timing);
          if (ItemLife !== null && Elapsed >= ItemLife) continue;
          const Image_ = this.Ready(Item.Texture);
          if (!Image_) continue;
          const Hold = Item.Timing ? Item.Timing.Hold : null;
          const [X, Y, W, H] = RiotScreenOverlay.Placed(Item.Rect, Item.Timing, Elapsed, Hold);
          const [U, V, Uw, Vh] = Item.Region;
          Context.globalAlpha = 1;
          Context.drawImage(Image_, U, V, Uw > 0 ? Uw : Image_.width, Vh > 0 ? Vh : Image_.height,
            X / 100 * Width, Y / 100 * Height, W / 100 * Width, H / 100 * Height);
          Drawn++;
        }
      }
    }
    Context.globalAlpha = 1;
    this.Canvas.hidden = !Drawn;
  }

  Clear() { this.Events = []; this.LastTime = undefined; this.Canvas.hidden = true; }
}
