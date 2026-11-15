export type Theme = "light" | "dark";
// GitHub-style semantic colors, shared by the shell, documents, diffs and diagrams.
export const palette = {
  light: {
    bg: "#ffffff",
    canvas: "#f6f8fa",
    fg: "#1f2328",
    muted: "#59636e",
    border: "#d1d9e0",
    accent: "#0969da",
    onAccent: "#ffffff",
    selected: "#ddf4ff",
    changed: "#7d4e00",
    added: "#dafbe1",
    removed: "#ffebe9",
  },
  dark: {
    bg: "#0d1117",
    canvas: "#151b23",
    fg: "#f0f6fc",
    muted: "#9198a1",
    border: "#3d444d",
    accent: "#4493f8",
    onAccent: "#0d1117",
    selected: "#132f4c",
    changed: "#d29922",
    added: "#12261e",
    removed: "#2d1619",
  },
} as const;
export function themeVariables(theme: Theme): string {
  return Object.entries(palette[theme])
    .map(([key, value]) => `--${key}:${value}`)
    .join(";");
}
