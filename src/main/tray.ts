// Notification-area (tray) icon: tooltip with the unread count and a small menu.
import { Menu, Tray, nativeImage } from 'electron';
import { appIconPath } from './appIcon';
import { trayTooltip } from './background';

export interface TrayActions {
  open: () => void;
  newMail: () => void;
  checkMail: () => void;
  quit: () => void;
}

export class AppTray {
  private tray: Tray | null = null;
  private unread = 0;

  /** Returns false if Windows would not give us a tray icon. */
  create(actions: TrayActions): boolean {
    try {
      const image = nativeImage.createFromPath(appIconPath());
      if (image.isEmpty()) return false;
      const tray = new Tray(image);
      tray.setToolTip(trayTooltip(this.unread));
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Open Mailroom', click: actions.open },
          { label: 'New mail', click: actions.newMail },
          { label: 'Check mail now', click: actions.checkMail },
          { type: 'separator' },
          { label: 'Quit', click: actions.quit },
        ]),
      );
      tray.on('click', actions.open);
      tray.on('double-click', actions.open);
      this.tray = tray;
      return true;
    } catch {
      this.tray = null;
      return false;
    }
  }

  get available(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  setUnread(n: number): void {
    this.unread = n;
    if (this.available) this.tray!.setToolTip(trayTooltip(n));
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
