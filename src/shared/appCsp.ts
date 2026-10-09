// The one Content-Security-Policy of the app shell (the renderer page). Used by the build
// (index.html meta tag) and by main (response header). They must never differ: the browser applies
// every policy it finds, so a stale copy in one place silently blocks what the other allows.
import { IMAGE_SCHEME } from './imageProxy';

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${IMAGE_SCHEME}:`,
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' about: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
