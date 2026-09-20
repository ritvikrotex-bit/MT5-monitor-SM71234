import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "mt5-theme";

export const themeScript = `(function(){try{var t=localStorage.getItem('${KEY}')||'dark';document.documentElement.classList.toggle('dark',t!=='light');document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.classList.add('dark');}})();`;

function current(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(current());
  }, []);

  const set = useCallback((next: Theme) => {
    applyTheme(next);
    setTheme(next);
  }, []);

  const toggle = useCallback(() => {
    set(current() === "dark" ? "light" : "dark");
  }, [set]);

  return { theme, setTheme: set, toggle };
}
