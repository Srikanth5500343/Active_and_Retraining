import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'racktrack:theme';
// Light is the default for first-time users. Anyone who has previously toggled
// keeps their stored preference (we read localStorage before falling back here).
const DEFAULT_THEME = 'light';

const ThemeContext = createContext({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  toggleTheme: () => {},
});

function readStoredTheme() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {}
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch {}
  }, [theme]);

  const setTheme = useCallback((t) => {
    if (t === 'light' || t === 'dark') setThemeState(t);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState(prev => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
