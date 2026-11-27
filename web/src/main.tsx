import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, themeById, type ThemeId } from './lib/tokens';
import './styles.css';

const THEME_KEY = 'shoal-theme';

/** The chosen theme is remembered per browser; storage can be unavailable (private mode), which is fine. */
function loadTheme(): ThemeId {
  try {
    return themeById(window.localStorage.getItem(THEME_KEY)).id;
  } catch {
    return themeById(null).id;
  }
}

function saveTheme(id: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_KEY, id);
  } catch {
    // Not persisting the choice only means the default theme on the next visit.
  }
}

const startTheme = loadTheme();
applyTheme(startTheme);

/** Holds the theme; switching remounts the app so canvases and the 3D scene repaint in the new colours. */
function Root() {
  const [theme, setTheme] = useState<ThemeId>(startTheme);
  const onTheme = (id: ThemeId): void => {
    applyTheme(id);
    saveTheme(id);
    setTheme(id);
  };
  return <App key={theme} theme={theme} onTheme={onTheme} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
