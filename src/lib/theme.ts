/** Colour theme: dark is the default; the choice persists per browser. */
export type Theme = "dark" | "light";

export const THEME_KEY = "caveman-theme";
const listeners = new Set<(theme: Theme) => void>();

export function getTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light") root.dataset.theme = "light";
  else delete root.dataset.theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f3ef" : "#07080b");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode: the choice just won't persist */
  }
  listeners.forEach((l) => l(theme));
}

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Runs in <head> before first paint, so a saved light theme never flashes dark. */
export const THEME_BOOT = `try{if(localStorage.getItem("${THEME_KEY}")==="light"){document.documentElement.dataset.theme="light";document.documentElement.style.colorScheme="light"}}catch(e){}`;
