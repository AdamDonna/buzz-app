import type { CustomPalette } from "./palette-runtime.js";
import "./palette-runtime.js";
export type {
  CustomPalette,
  PaletteColors,
} from "./palette-runtime.js";
export const paletteRuntime = globalThis.BuzzPalette;
export const DEFAULT_CUSTOM_PALETTE: CustomPalette = {
  version: 1,
  light: {
    window: "#f1f1f2",
    sidebar: "#ffffff",
    selection: "#bae629",
    accent: "#bae629",
  },
  dark: {
    window: "#191919",
    sidebar: "#232323",
    selection: "#bae629",
    accent: "#bae629",
  },
};
