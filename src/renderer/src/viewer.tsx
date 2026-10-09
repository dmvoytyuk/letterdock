// Entry of the message window (viewer.html). Main opens it with `#msg=<messageId>` in the URL.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ViewerApp } from './features/viewer/ViewerApp';
import './styles/app.css';
import './styles/mail-actions.css';

/** Reads the message id main put in the URL hash. Returns null when it is missing or invalid. */
export function readViewerMessageId(hash: string = location.hash): number | null {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('msg');
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function start(): Promise<void> {
  // Dev only: ?fake=1 in a plain browser uses the fake backend (tree-shaken from production builds).
  if (import.meta.env.DEV && !('api' in window) && location.search.includes('fake')) {
    const { installFakeApi } = await import('./dev/fakeApi');
    installFakeApi();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ViewerApp messageId={readViewerMessageId()} />
    </StrictMode>,
  );
}

void start();
