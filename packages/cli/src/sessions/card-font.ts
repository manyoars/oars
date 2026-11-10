// A 5x7 bitmap font for the card's PNG, so the picture needs no renderer dependency, no font file, and no system font. Each glyph is five column bytes
// (ten hex digits), bit 0 the top row; bit 7 is the one descender row. ASCII 32 to 126 only: a model or harness name the card prints is always inside that range.
const COLUMNS: readonly string[] = [
  // space ! " # $ % & ' ( ) * + , - . /
  '0000000000', '00005f0000', '0007000700', '147f147f14', '242a7f2a12', '2313086462', '3649562050', '0008070300',
  '001c224100', '0041221c00', '2a1c7f1c2a', '08083e0808', '0080703000', '0808080808', '0000606000', '2010080402',
  // 0 to 9
  '3e5149453e', '00427f4000', '7249494946', '2141494d33', '1814127f10', '2745454539', '3c4a494931', '4121110907',
  '3649494936', '464949291e',
  // : ; < = > ? @
  '0000140000', '0040340000', '0008142241', '1414141414', '0041221408', '0201590906', '3e415d594e',
  // A to Z
  '7c1211127c', '7f49494936', '3e41414122', '7f4141413e', '7f49494941', '7f09090901', '3e41415173', '7f0808087f',
  '00417f4100', '2040413f01', '7f08142241', '7f40404040', '7f021c027f', '7f0408107f', '3e4141413e', '7f09090906',
  '3e4151215e', '7f09192946', '2649494932', '03017f0103', '3f4040403f', '1f2040201f', '3f4038403f', '6314081463',
  '0304780403', '6159494d43',
  // [ \ ] ^ _ `
  '007f414141', '0204081020', '004141417f', '0402010204', '4040404040', '0003070800',
  // a to z
  '2054547840', '7f28444438', '3844444428', '384444287f', '3854545418', '00087e0902', '18a4a49c78', '7f08040478',
  '00447d4000', '2040403d00', '7f10284400', '00417f4000', '7c04780478', '7c08040478', '3844444438', 'fc18242418',
  '18242418fc', '7c08040408', '4854545424', '04043f4424', '3c40402078', '1c2040201c', '3c4030403c', '4428102844',
  '4c9090907c', '4464544c44',
  // { | } ~
  '0008364100', '0000770000', '0041360800', '0201020402',
];

/** The glyphs from ASCII 32 on, each as five column bytes. */
export const GLYPHS: readonly (readonly number[])[] = COLUMNS.map((hex) => Array.from({ length: 5 }, (_, column) => Number.parseInt(hex.slice(column * 2, column * 2 + 2), 16)));

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 8;

/** Whether the pixel at (column, row) of a character is lit; any character outside ASCII 32 to 126 draws as `?`. */
export const lit = (char: string, column: number, row: number): boolean => {
  const code = char.charCodeAt(0);
  const glyph = GLYPHS[code >= 32 && code <= 126 ? code - 32 : 31] ?? [];
  return (((glyph[column] ?? 0) >> row) & 1) === 1;
};
