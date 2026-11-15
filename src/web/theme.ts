import { element } from "./api";
import { palette, type Theme } from "./colors";
let theme: Theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
export const currentTheme = () => theme;
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  for (const [key, value] of Object.entries(palette[theme]))
    document.documentElement.style.setProperty(`--${key}`, value);
  document.documentElement.style.colorScheme = theme;
  const button = element<HTMLButtonElement>("theme");
  button.textContent = theme === "light" ? "◐ ダーク" : "☀ ライト";
  button.setAttribute(
    "aria-label",
    theme === "light" ? "ダークテーマに切り替え" : "ライトテーマに切り替え",
  );
}
export function toggleTheme() {
  theme = theme === "light" ? "dark" : "light";
  applyTheme();
}
applyTheme();
