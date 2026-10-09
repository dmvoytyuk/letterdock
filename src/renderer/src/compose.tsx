// Entry of the compose window (compose.html). The window is opened by main with
// `#req=<json of PrepareComposeReq>` in the URL; the form asks the engine to prepare the draft itself.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PrepareComposeReq } from '../../shared/ipc';
import { ComposeApp } from './features/compose/ComposeApp';
import './styles/app.css';
import './styles/compose.css';

/** Reads the request main put in the URL hash. */
export function readComposeRequest(hash: string = location.hash): PrepareComposeReq {
  try {
    const raw = new URLSearchParams(hash.replace(/^#/, '')).get('req');
    if (raw) return JSON.parse(raw) as PrepareComposeReq;
  } catch {
    /* fall through */
  }
  return { mode: 'new' };
}

async function start(): Promise<void> {
  // Dev only: ?fake=1 in a plain browser uses the fake backend (tree-shaken from production builds).
  if (import.meta.env.DEV && !('api' in window) && location.search.includes('fake')) {
    const { installFakeApi } = await import('./dev/fakeApi');
    installFakeApi();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ComposeApp request={readComposeRequest()} />
    </StrictMode>,
  );
}

void start();
