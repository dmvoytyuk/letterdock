import type { UpdateStatus } from '../../../shared/ipc';

/** One plain-words line for the Updates section. */
export function updateLine(s: UpdateStatus | null): string {
  if (!s) return '';
  switch (s.state) {
    case 'checking':
      return 'Checking for updates...';
    case 'upToDate':
      return `Mailroom is up to date (${s.currentVersion})`;
    case 'available':
      return `Version ${s.newVersion} was found. Starting the download...`;
    case 'downloading':
      return `Downloading ${s.newVersion}... ${s.percent}%`;
    case 'ready':
      return `Version ${s.newVersion} is ready. It installs when you restart.`;
    case 'error':
      return s.error.message;
    case 'idle':
      return `You have Mailroom ${s.currentVersion}.`;
    default:
      return '';
  }
}
