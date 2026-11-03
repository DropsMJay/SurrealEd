/*
 * RiotTextureDecoder — decodifica as texturas do jogo no navegador / decodes game textures in the browser.
 *
 * PT: O servidor manda as texturas como estão nos .tdu (DXT1, DXT5 ou 8 bits com paleta) num bloco só
 *     (formato em Riot/RiotTextures.py → PackTextures). Aqui elas viram RGBA para o three.js.
 *     As linhas já vêm de baixo para cima, exatamente como o WebGL espera numa DataTexture: não precisa inverter.
 *     AlphaKind: 0 = sem transparência, 1 = recorte (alpha quase binário), 2 = transparência de verdade (vidro, fumaça).
 * EN: The server sends textures as stored in the .tdu (DXT1, DXT5 or 8-bit paletted) in one bundle; this turns
 *     them into RGBA for three.js. Rows are already bottom-up, as WebGL expects for a DataTexture.
 */
const RiotTextureDecoder = (() => {
  const FormatDXT1 = 1, FormatDXT5 = 5, FormatPalette8 = 8, FormatL8 = 9;

  function Color565(Value, Out) {
    const Red = (Value >> 11) & 31, Green = (Value >> 5) & 63, Blue = Value & 31;
    Out[0] = (Red << 3) | (Red >> 2); Out[1] = (Green << 2) | (Green >> 4); Out[2] = (Blue << 3) | (Blue >> 2);
  }

  function DecodeColorBlock(Bytes, Offset, Pixels, Width, Height, BlockX, BlockY, ForceFourColors, AlphaValues) {
    const C0 = Bytes[Offset] | (Bytes[Offset + 1] << 8), C1 = Bytes[Offset + 2] | (Bytes[Offset + 3] << 8);
    const Palette = [[0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]];
    Color565(C0, Palette[0]); Color565(C1, Palette[1]);
    if (ForceFourColors || C0 > C1) {
      for (let Channel = 0; Channel < 3; Channel++) {
        Palette[2][Channel] = (2 * Palette[0][Channel] + Palette[1][Channel] + 1) / 3 | 0;
        Palette[3][Channel] = (Palette[0][Channel] + 2 * Palette[1][Channel] + 1) / 3 | 0;
      }
    } else {
      for (let Channel = 0; Channel < 3; Channel++) Palette[2][Channel] = (Palette[0][Channel] + Palette[1][Channel]) >> 1;
      Palette[3] = [0, 0, 0, 0];
    }
    const Indexes = Bytes[Offset + 4] | (Bytes[Offset + 5] << 8) | (Bytes[Offset + 6] << 16) | (Bytes[Offset + 7] << 24);
    for (let Row = 0; Row < 4; Row++) {
      const Y = BlockY * 4 + Row;
      if (Y >= Height) break;
      for (let Column = 0; Column < 4; Column++) {
        const X = BlockX * 4 + Column;
        if (X >= Width) continue;
        const Pixel = Palette[(Indexes >>> (2 * (4 * Row + Column))) & 3];
        const Target = 4 * (Y * Width + X);
        Pixels[Target] = Pixel[0]; Pixels[Target + 1] = Pixel[1]; Pixels[Target + 2] = Pixel[2];
        Pixels[Target + 3] = AlphaValues ? AlphaValues[4 * Row + Column] : Pixel[3];
      }
    }
  }

  function DecodeAlphaBlock(Bytes, Offset, Out) {
    const A0 = Bytes[Offset], A1 = Bytes[Offset + 1];
    const Table = [A0, A1, 0, 0, 0, 0, 0, 0];
    if (A0 > A1) for (let Step = 1; Step < 7; Step++) Table[Step + 1] = ((7 - Step) * A0 + Step * A1) / 7 | 0;
    else { for (let Step = 1; Step < 5; Step++) Table[Step + 1] = ((5 - Step) * A0 + Step * A1) / 5 | 0; Table[6] = 0; Table[7] = 255; }
    let Low = Bytes[Offset + 2] | (Bytes[Offset + 3] << 8) | (Bytes[Offset + 4] << 16);
    let High = Bytes[Offset + 5] | (Bytes[Offset + 6] << 8) | (Bytes[Offset + 7] << 16);
    for (let Number = 0; Number < 8; Number++) { Out[Number] = Table[Low & 7]; Low >>= 3; }
    for (let Number = 8; Number < 16; Number++) { Out[Number] = Table[High & 7]; High >>= 3; }
  }

  function DecodeOne(Bytes, Offset, Width, Height, Format) {
    const Pixels = new Uint8Array(Width * Height * 4);
    const BlocksX = Math.max(1, (Width + 3) >> 2), BlocksY = Math.max(1, (Height + 3) >> 2);
    if (Format === FormatDXT1) {
      for (let BlockY = 0; BlockY < BlocksY; BlockY++)
        for (let BlockX = 0; BlockX < BlocksX; BlockX++)
          DecodeColorBlock(Bytes, Offset + 8 * (BlockY * BlocksX + BlockX), Pixels, Width, Height, BlockX, BlockY, false, null);
    } else if (Format === FormatDXT5) {
      const Alpha = new Uint8Array(16);
      for (let BlockY = 0; BlockY < BlocksY; BlockY++)
        for (let BlockX = 0; BlockX < BlocksX; BlockX++) {
          const Block = Offset + 16 * (BlockY * BlocksX + BlockX);
          DecodeAlphaBlock(Bytes, Block, Alpha);
          DecodeColorBlock(Bytes, Block + 8, Pixels, Width, Height, BlockX, BlockY, true, Alpha);
        }
    } else if (Format === FormatL8) {
      for (let Number = 0; Number < Width * Height; Number++) { const L = Bytes[Offset + Number], Target = 4 * Number; Pixels[Target] = Pixels[Target + 1] = Pixels[Target + 2] = Pixels[Target + 3] = L; }
    } else if (Format === FormatPalette8) {
      const Indexes = Offset + 1024;
      for (let Number = 0; Number < Width * Height; Number++) {
        const Entry = Offset + 4 * Bytes[Indexes + Number], Target = 4 * Number;
        Pixels[Target] = Bytes[Entry + 2]; Pixels[Target + 1] = Bytes[Entry + 1]; Pixels[Target + 2] = Bytes[Entry]; Pixels[Target + 3] = Bytes[Entry + 3];
      }
    }
    return Pixels;
  }

  function AlphaKind(Pixels) {
    let Transparent = 0, Partial = 0;
    const Count = Pixels.length / 4;
    for (let Number = 3; Number < Pixels.length; Number += 4) {
      const Value = Pixels[Number];
      if (Value < 250) Transparent++;
      if (Value > 15 && Value < 240) Partial++;
    }
    if (!Transparent) return 0;
    return Partial / Count > 0.2 ? 2 : 1;
  }

  /** PT: Decodifica o bloco inteiro: Map código → {Width, Height, Pixels, AlphaKind, FormatName}. EN: Decodes the whole bundle. */
  function DecodeBundle(Buffer) {
    const View = new DataView(Buffer), Bytes = new Uint8Array(Buffer);
    const Count = View.getUint32(0, true), Result = new Map();
    let Offset = 4;
    for (let Number = 0; Number < Count; Number++) {
      const Ref = View.getUint32(Offset, true), Width = View.getUint16(Offset + 4, true), Height = View.getUint16(Offset + 6, true);
      const Format = View.getUint8(Offset + 8), AlphaBits = View.getUint8(Offset + 9), Size = View.getUint32(Offset + 12, true);
      const Start = Offset + 16;
      const Pixels = DecodeOne(Bytes, Start, Width, Height, Format);
      const Code = (Ref >>> 16) + '_' + (Ref & 0xffff).toString(16).padStart(4, '0');
      Result.set(Code, { Width, Height, Pixels, AlphaBits, AlphaKind: AlphaKind(Pixels), FormatName: { 1: 'DXT1', 5: 'DXT5', 8: 'Palette 8-bit', 9: 'L8' }[Format] || '?' });
      Offset = Start + Size;
      while (Offset % 4) Offset++;
    }
    return Result;
  }

  return { DecodeBundle, DecodeOne };
})();
