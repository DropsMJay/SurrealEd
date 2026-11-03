/*
 * RiotTextureEncoder — compressão DXT1/DXT5 no navegador / DXT1/DXT5 compression in the browser
 *
 * PT: Usado na importação de texturas: a imagem (RGBA, linhas de cima para baixo) é virada na vertical (o jogo grava
 *     de baixo para cima), comprimida bloco a bloco (4×4) e, se a textura original tinha mipmaps (só na TTB), os níveis
 *     menores são gerados por média 2×2 e comprimidos em seguida.
 *     Cor: os extremos saem do eixo principal das cores do bloco (iteração de potência na covariância), com recuo de
 *     1/16 para dentro, quantizados em 5:6:5; cada pixel recebe o índice da cor mais próxima.
 *     DXT1 com recorte: blocos com pixels de alfa < 128 usam o modo de 3 cores (índice 3 = transparente).
 *     DXT5: alfa com os 8 níveis entre o mínimo e o máximo do bloco.
 * EN: Used by texture import: flips the image (the game stores bottom-up), compresses 4×4 blocks (principal-axis
 *     endpoints, 5:6:5, nearest index; DXT1 punch-through mode for alpha < 128; DXT5 8-level alpha) and, when the
 *     original carried mipmaps (TTB only), box-filters and compresses the smaller levels too.
 */
const RiotTextureEncoder = (() => {
  const Pack565 = (R, G, B) => ((Math.round(R * 31 / 255) & 31) << 11) | ((Math.round(G * 63 / 255) & 63) << 5) | (Math.round(B * 31 / 255) & 31);
  const Unpack565 = Value => {
    const R = (Value >> 11) & 31, G = (Value >> 5) & 63, B = Value & 31;
    return [(R << 3) | (R >> 2), (G << 2) | (G >> 4), (B << 3) | (B >> 2)];
  };

  /** PT: Bloco de cor (8 bytes). EN: Colour block (8 bytes). */
  function ColorBlock(Block, Out, Offset, Punch) {
    // Block: Uint8Array(64) RGBA
    const Used = [];
    for (let P = 0; P < 16; P++) if (!Punch || Block[4 * P + 3] >= 128) Used.push(P);
    const Transparent = Punch && Used.length < 16;
    if (!Used.length) { Out[Offset] = 0; Out[Offset + 1] = 0; Out[Offset + 2] = 0; Out[Offset + 3] = 0; Out[Offset + 4] = Out[Offset + 5] = Out[Offset + 6] = Out[Offset + 7] = 0xFF; return; }
    let Mr = 0, Mg = 0, Mb = 0;
    for (const P of Used) { Mr += Block[4 * P]; Mg += Block[4 * P + 1]; Mb += Block[4 * P + 2]; }
    Mr /= Used.length; Mg /= Used.length; Mb /= Used.length;
    let Crr = 0, Crg = 0, Crb = 0, Cgg = 0, Cgb = 0, Cbb = 0;
    for (const P of Used) {
      const R = Block[4 * P] - Mr, G = Block[4 * P + 1] - Mg, B = Block[4 * P + 2] - Mb;
      Crr += R * R; Crg += R * G; Crb += R * B; Cgg += G * G; Cgb += G * B; Cbb += B * B;
    }
    let Ax = 1, Ay = 1, Az = 1;
    for (let Step = 0; Step < 6; Step++) {
      const X = Crr * Ax + Crg * Ay + Crb * Az, Y = Crg * Ax + Cgg * Ay + Cgb * Az, Z = Crb * Ax + Cgb * Ay + Cbb * Az;
      const Length = Math.hypot(X, Y, Z);
      if (Length < 1e-6) break;
      Ax = X / Length; Ay = Y / Length; Az = Z / Length;
    }
    let Low = Infinity, High = -Infinity;
    for (const P of Used) {
      const T = (Block[4 * P] - Mr) * Ax + (Block[4 * P + 1] - Mg) * Ay + (Block[4 * P + 2] - Mb) * Az;
      if (T < Low) Low = T; if (T > High) High = T;
    }
    const Inset = (High - Low) / 16;
    Low += Inset; High -= Inset;
    const Clamp = Value => Math.max(0, Math.min(255, Value));
    let C0 = Pack565(Clamp(Mr + Ax * High), Clamp(Mg + Ay * High), Clamp(Mb + Az * High));
    let C1 = Pack565(Clamp(Mr + Ax * Low), Clamp(Mg + Ay * Low), Clamp(Mb + Az * Low));
    // PT: 4 cores exige C0 > C1; 3 cores (recorte) exige C0 <= C1 / EN: mode is chosen by endpoint order
    if (Transparent ? C0 > C1 : C0 < C1) [C0, C1] = [C1, C0];
    if (!Transparent && C0 === C1) {
      Out[Offset] = C0 & 255; Out[Offset + 1] = C0 >> 8; Out[Offset + 2] = C1 & 255; Out[Offset + 3] = C1 >> 8;
      Out[Offset + 4] = Out[Offset + 5] = Out[Offset + 6] = Out[Offset + 7] = 0; return;
    }
    const E0 = Unpack565(C0), E1 = Unpack565(C1);
    const Palette = Transparent
      ? [E0, E1, E0.map((V, I) => (V + E1[I]) >> 1)]
      : [E0, E1, E0.map((V, I) => (2 * V + E1[I] + 1) / 3 | 0), E0.map((V, I) => (V + 2 * E1[I] + 1) / 3 | 0)];
    let Indexes = 0;
    for (let P = 0; P < 16; P++) {
      let Best = 0;
      if (Transparent && Block[4 * P + 3] < 128) Best = 3;
      else {
        let BestError = Infinity;
        for (let I = 0; I < Palette.length; I++) {
          const Dr = Block[4 * P] - Palette[I][0], Dg = Block[4 * P + 1] - Palette[I][1], Db = Block[4 * P + 2] - Palette[I][2];
          const Error = Dr * Dr * 3 + Dg * Dg * 4 + Db * Db * 2;
          if (Error < BestError) { BestError = Error; Best = I; }
        }
      }
      Indexes |= Best << (2 * P);
    }
    Out[Offset] = C0 & 255; Out[Offset + 1] = C0 >> 8; Out[Offset + 2] = C1 & 255; Out[Offset + 3] = C1 >> 8;
    Out[Offset + 4] = Indexes & 255; Out[Offset + 5] = (Indexes >>> 8) & 255; Out[Offset + 6] = (Indexes >>> 16) & 255; Out[Offset + 7] = (Indexes >>> 24) & 255;
  }

  /** PT: Bloco de alfa do DXT5 (8 bytes). EN: DXT5 alpha block (8 bytes). */
  function AlphaBlock(Block, Out, Offset) {
    let A0 = 0, A1 = 255;
    for (let P = 0; P < 16; P++) { const A = Block[4 * P + 3]; if (A > A0) A0 = A; if (A < A1) A1 = A; }
    Out[Offset] = A0; Out[Offset + 1] = A1;
    const Table = [A0, A1];
    for (let Step = 1; Step < 7; Step++) Table.push(((7 - Step) * A0 + Step * A1) / 7 | 0);
    let Low = 0, High = 0;
    for (let P = 0; P < 16; P++) {
      let Best = 0;
      if (A0 !== A1) {
        let BestError = Infinity;
        for (let I = 0; I < 8; I++) { const Error = Math.abs(Block[4 * P + 3] - Table[I]); if (Error < BestError) { BestError = Error; Best = I; } }
      }
      if (P < 8) Low |= Best << (3 * P); else High |= Best << (3 * (P - 8));
    }
    Out[Offset + 2] = Low & 255; Out[Offset + 3] = (Low >> 8) & 255; Out[Offset + 4] = (Low >> 16) & 255;
    Out[Offset + 5] = High & 255; Out[Offset + 6] = (High >> 8) & 255; Out[Offset + 7] = (High >> 16) & 255;
  }

  /** PT: Um nível (Pixels já na ordem do jogo). EN: One level (pixels already in game row order). */
  function EncodeLevel(Pixels, Width, Height, Format, Punch) {
    const BlocksX = Math.max(1, (Width + 3) >> 2), BlocksY = Math.max(1, (Height + 3) >> 2);
    const Size = Format === 'dxt1' ? 8 : 16;
    const Out = new Uint8Array(BlocksX * BlocksY * Size);
    const Block = new Uint8Array(64);
    for (let BY = 0; BY < BlocksY; BY++) {
      for (let BX = 0; BX < BlocksX; BX++) {
        for (let Row = 0; Row < 4; Row++) for (let Column = 0; Column < 4; Column++) {
          const X = Math.min(Width - 1, BX * 4 + Column), Y = Math.min(Height - 1, BY * 4 + Row);
          const Source = 4 * (Y * Width + X), Target = 4 * (Row * 4 + Column);
          Block[Target] = Pixels[Source]; Block[Target + 1] = Pixels[Source + 1]; Block[Target + 2] = Pixels[Source + 2]; Block[Target + 3] = Pixels[Source + 3];
        }
        const Offset = (BY * BlocksX + BX) * Size;
        if (Format === 'dxt1') ColorBlock(Block, Out, Offset, Punch);
        else { AlphaBlock(Block, Out, Offset); ColorBlock(Block, Out, Offset + 8, false); }
      }
    }
    return Out;
  }

  function FlipRows(Pixels, Width, Height) {
    const Out = new Uint8Array(Pixels.length), Stride = Width * 4;
    for (let Y = 0; Y < Height; Y++) Out.set(Pixels.subarray(Y * Stride, (Y + 1) * Stride), (Height - 1 - Y) * Stride);
    return Out;
  }

  function Half(Pixels, Width, Height) {
    const W = Math.max(1, Width >> 1), H = Math.max(1, Height >> 1), Out = new Uint8Array(W * H * 4);
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) for (let C = 0; C < 4; C++) {
      let Sum = 0;
      for (let Dy = 0; Dy < 2; Dy++) for (let Dx = 0; Dx < 2; Dx++) Sum += Pixels[4 * (Math.min(Height - 1, 2 * Y + Dy) * Width + Math.min(Width - 1, 2 * X + Dx)) + C];
      Out[4 * (Y * W + X) + C] = (Sum + 2) >> 2;
    }
    return { Pixels: Out, Width: W, Height: H };
  }

  /** PT: Tipo de alfa da imagem: 0 opaca, 1 recorte, 2 suave. EN: Alpha kind: 0 opaque, 1 cut-out, 2 smooth. */
  function AlphaKind(Pixels) {
    let Cut = 0, Soft = 0;
    for (let I = 3; I < Pixels.length; I += 4) { const A = Pixels[I]; if (A < 250) Cut++; if (A > 12 && A < 243) Soft++; }
    if (!Cut) return 0;
    return Soft > Pixels.length / 4 * 0.01 ? 2 : 1;
  }

  /**
   * PT: Codifica a imagem (RGBA de cima para baixo). Devolve Uint8Array com o nível principal e os mipmaps.
   * EN: Encodes a top-down RGBA image; returns the main level followed by the mipmaps.
   */
  function Encode(Pixels, Width, Height, Format, Punch, Mips) {
    let Level = { Pixels: FlipRows(Pixels, Width, Height), Width, Height };
    const Parts = [];
    for (let Number = 0; Number <= Mips; Number++) {
      Parts.push(EncodeLevel(Level.Pixels, Level.Width, Level.Height, Format, Punch));
      if (Number < Mips) Level = Half(Level.Pixels, Level.Width, Level.Height);
    }
    const Out = new Uint8Array(Parts.reduce((Sum, Part) => Sum + Part.length, 0));
    let Cursor = 0;
    for (const Part of Parts) { Out.set(Part, Cursor); Cursor += Part.length; }
    return Out;
  }

  return { Encode, AlphaKind, FlipRows };
})();
if (typeof module !== 'undefined') module.exports = RiotTextureEncoder;
