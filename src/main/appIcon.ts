// Path of the app icon (DESIGN-SPEC 1.8). Packaged builds copy it to resources/ (extraResources);
// in dev it is read from build/.
import { join } from 'node:path';
import { app } from 'electron';

export function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build', 'icon.ico');
}
