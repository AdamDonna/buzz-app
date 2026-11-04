/* Shared by the parser-blocking bootstrap and the live appearance owner.
 * Data only: no CSS input, external resources, account state or DOM side effects.
 */
(() => {
  const key = "buzz-palette.v1";
  const fields = ["window", "sidebar", "selection", "accent"];
  function parse(value) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      const data = JSON.parse(value);
      if (data?.version !== 1) return null;
      const result = { version: 1 };
      for (const mode of ["light", "dark"]) {
        result[mode] = {};
        for (const field of fields) {
          const color = data[mode]?.[field];
          if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))
            return null;
          result[mode][field] = color.toLowerCase();
        }
      }
      return result;
    } catch {
      return null;
    }
  }
  const channels = (hex) =>
    [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  function mix(a, b, amount) {
    const end = channels(b);
    return `#${channels(a)
      .map((c, i) =>
        Math.round(c + (end[i] - c) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  }
  function compositedBound(fill, hoverInk, hover, ink, overlay) {
    const foreground = channels(ink);
    const hovered = channels(hoverInk);
    // CSS retains fractional channels between bubble and mention hover.
    // Bound the final composite toward the ink (the lower-contrast direction),
    // rather than round either intermediate blend to the nearest integer.
    return `#${channels(fill)
      .map((channel, index) => {
        const bubble = channel * (1 - hover) + hovered[index] * hover;
        const composite = bubble * (1 - overlay) + foreground[index] * overlay;
        const bounded =
          ink === "#000000" ? Math.floor(composite) : Math.ceil(composite);
        return bounded.toString(16).padStart(2, "0");
      })
      .join("")}`;
  }
  function luminance(hex, perceptual) {
    const weights = perceptual
      ? [0.2126729, 0.7151522, 0.072175]
      : [0.2126, 0.7152, 0.0722];
    return channels(hex).reduce((sum, channel, i) => {
      const v = channel / 255;
      const linear = perceptual
        ? v ** 2.4
        : v <= 0.03928
          ? v / 12.92
          : ((v + 0.055) / 1.055) ** 2.4;
      return sum + weights[i] * linear;
    }, 0);
  }
  function ratio(a, b) {
    const x = luminance(a, false),
      y = luminance(b, false);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function contrast(text, background) {
    // APCA 0.1.9, matching scripts/design-system/apca.mjs; parity tested.
    // biome-ignore lint/suspicious/noApproximativeNumericConstant: APCA specified constant, not Math.SQRT2.
    const clamp = (y) => (y < 0.022 ? y + (0.022 - y) ** 1.414 : y);
    const t = clamp(luminance(text, true)),
      b = clamp(luminance(background, true));
    if (Math.abs(b - t) < 0.1) return 0;
    const c =
      b > t ? (b ** 0.56 - t ** 0.57) * 1.14 : (b ** 0.65 - t ** 0.62) * 1.14;
    return Math.abs(c) < 0.1 ? 0 : (c + (b > t ? -0.027 : 0.027)) * 100;
  }
  const readable = (ink, fill) =>
    ratio(ink, fill) >= 4.5 && Math.abs(contrast(ink, fill)) >= 60;
  function strong(color) {
    const ink =
      Math.abs(contrast("#000000", color)) >=
      Math.abs(contrast("#ffffff", color))
        ? "#000000"
        : "#ffffff";
    const end = ink === "#000000" ? "#ffffff" : "#000000";
    for (let i = 0; i <= 100; i++) {
      const fill = mix(color, end, i / 100);
      // Measure real bubble hover (5% black/light or white/dark) stacked
      // with mention, reaction, highlight and quiet overlays on the fill.
      if (
        ["#000000", "#ffffff"].every((hoverInk) =>
          [0, 0.05].every((hover) =>
            [0, 0.08, 0.1, 0.16, 0.22].every((overlay) =>
              readable(
                ink,
                compositedBound(fill, hoverInk, hover, ink, overlay),
              ),
            ),
          ),
        )
      )
        return { fill, ink };
    }
    return { fill: end, ink };
  }
  function resolve(palette, mode) {
    const input = palette[mode];
    const dark = mode === "dark";
    const base = dark ? "#000000" : "#ffffff";
    const ink = dark ? "#ffffff" : "#000000";
    // Keep the shell's existing neutral controls and secondary text readable.
    // Color inputs are tint sources; surfaces intentionally stay near their mode.
    const surface = (value) => mix(base, value, 0.06);
    const accent = strong(input.accent);
    const selection = strong(input.selection);
    const soft = mix(base, input.accent, 0.1);
    const link = mix(ink, input.accent, 0.06);
    const effective = {
      window: surface(input.window),
      sidebar: surface(input.sidebar),
      selection: selection.fill,
      accent: accent.fill,
    };
    const style = {
      "--bg-app": effective.window,
      "--surface-sidebar": effective.sidebar,
      "--surface-sidebar-selected": selection.fill,
      "--text-sidebar-selected": selection.ink,
      "--affordance-sidebar-hover": soft,
      "--text-sidebar-hover": ink,
    };
    // Supply both mode halves so nested mode scopes never inherit a resolved ramp.
    for (let step = 1; step <= 12; step++) {
      style[`--accent-${step}-${mode}`] =
        step <= 8
          ? mix(base, input.accent, step / 80)
          : step <= 10
            ? accent.fill
            : link;
    }
    Object.assign(style, {
      [`--accent-contrast-${mode}`]: accent.ink,
      [`--accent-ink-${mode}`]: accent.ink,
      [`--accent-pressed-${mode}`]: accent.fill,
      [`--accent-link-${mode}`]: link,
      [`--accent-link-hover-${mode}`]: link,
    });
    // Overlays move toward the paired ink; strong() reserves contrast headroom.
    for (const [name, alpha] of Object.entries({
      overlay: 0.16,
      "overlay-hover": 0.22,
      "overlay-soft": 0.1,
      "overlay-quiet": 0.08,
      "overlay-highlight": 0.1,
    })) {
      style[`--accent-${name}-${mode}`] =
        `rgb(${channels(accent.ink).join(" ")} / ${alpha})`;
    }
    return { style, effective };
  }
  function properties(palette) {
    if (!palette) return {};
    const result = {};
    for (const mode of ["light", "dark"]) {
      const resolved = resolve(palette, mode);
      for (const [name, value] of Object.entries(resolved.style)) {
        // Per-mode palette roles are rebound by tokens.css, including nested scopes.
        result[name.startsWith("--accent-") ? name : `${name}-custom-${mode}`] =
          value;
      }
    }
    return result;
  }
  function apply(root, palette) {
    // Names are fixed by the schema, never derived from imported property names.
    const all = properties({
      version: 1,
      light: {
        window: "#ffffff",
        sidebar: "#ffffff",
        selection: "#ffffff",
        accent: "#ffffff",
      },
      dark: {
        window: "#000000",
        sidebar: "#000000",
        selection: "#000000",
        accent: "#000000",
      },
    });
    const values = properties(palette);
    for (const name of Object.keys(all)) {
      if (values[name]) root.style.setProperty(name, values[name]);
      else root.style.removeProperty(name);
    }
    if (palette) root.dataset.customPalette = "";
    else delete root.dataset.customPalette;
  }
  globalThis.BuzzPalette = {
    key,
    parse,
    resolve,
    properties,
    apply,
    contrast,
    ratio,
  };
})();
