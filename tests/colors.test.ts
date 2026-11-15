import { expect, it } from "vite-plus/test";
import { palette, themeVariables } from "../src/web/colors";
function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(left: string, right: string): number {
  const [low, high] = [luminance(left), luminance(right)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}
for (const theme of ["light", "dark"] as const)
  it(`keeps core ${theme} text and accent-button colors readable`, () => {
    const colors = palette[theme];
    const pairs = [
      [colors.fg, colors.bg],
      [colors.fg, colors.canvas],
      [colors.fg, colors.selected],
      [colors.muted, colors.bg],
      [colors.muted, colors.canvas],
      [colors.changed, colors.bg],
      [colors.changed, colors.canvas],
      [colors.changed, colors.selected],
      [colors.accent, colors.bg],
      [colors.accent, colors.canvas],
      [colors.onAccent, colors.accent],
      [colors.fg, colors.added],
      [colors.fg, colors.removed],
    ];
    for (const [foreground, background] of pairs)
      expect(
        contrast(foreground, background),
        `${theme}: ${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    expect(themeVariables(theme)).toContain(`--onAccent:${colors.onAccent}`);
  });
