export interface PaletteColors {
  window: string;
  sidebar: string;
  selection: string;
  accent: string;
}
export interface CustomPalette {
  version: 1;
  light: PaletteColors;
  dark: PaletteColors;
}
declare global {
  var BuzzPalette: {
    key: string;
    parse(value: unknown): CustomPalette | null;
    resolve(
      palette: CustomPalette,
      mode: "light" | "dark",
    ): {
      style: Record<string, string>;
      effective: PaletteColors;
    };
    properties(palette: CustomPalette | null): Record<string, string>;
    apply(root: HTMLElement, palette: CustomPalette | null): void;
    contrast(text: string, background: string): number;
    ratio(a: string, b: string): number;
  };
}
