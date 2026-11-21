import { palette, type Theme } from "./colors";
let theme: Theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
export const currentTheme = () => theme;
export function setTheme(value: Theme) {
  theme = value;
  document.documentElement.dataset.theme = theme;
  for (const [key, color] of Object.entries(palette[theme]))
    document.documentElement.style.setProperty("--" + key, color);
  document.documentElement.style.colorScheme = theme;
}
setTheme(theme);
