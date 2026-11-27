import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { cssVariables } from './lib/tokens';
import './styles.css';

for (const [name, value] of Object.entries(cssVariables())) document.documentElement.style.setProperty(name, value);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
