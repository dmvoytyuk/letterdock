import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import './styles/mail-actions.css';
import './styles/conversations.css';
import './styles/scheduled.css';
import './styles/rules.css';
import './styles/light.css';

async function start(): Promise<void> {
  // Dev only: ?fake=1 in a plain browser uses a fake backend (tree-shaken from production builds).
  if (import.meta.env.DEV && !('api' in window) && location.search.includes('fake')) {
    const { installFakeApi } = await import('./dev/fakeApi');
    installFakeApi();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
