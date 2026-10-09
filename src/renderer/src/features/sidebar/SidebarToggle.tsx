import type { ButtonHTMLAttributes } from 'react';
import { IconButton } from '../../components/ui';
import { useUi } from '../../store/ui';

/** Ctrl+B and the sidebar buttons: collapse/expand in wide mode, open/close the drawer otherwise. */
export function toggleSidebar(): void {
  const ui = useUi.getState();
  if (ui.mode === 'wide') ui.set({ sidebarCollapsed: !ui.sidebarCollapsed });
  else ui.set({ drawerOpen: !ui.drawerOpen });
}

/** True while the full sidebar (wide mode) or the drawer is showing. */
export function useSidebarExpanded(): boolean {
  return useUi((s) => (s.mode === 'wide' ? !s.sidebarCollapsed : s.drawerOpen));
}

/** Sidebar-panel icon button: panel-left-close while open, panel-left-open while collapsed. */
export function SidebarToggle({
  forceExpanded,
  ...rest
}: { forceExpanded?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>) {
  const live = useSidebarExpanded();
  const expanded = forceExpanded ?? live;
  return (
    <IconButton
      icon={expanded ? 'panel-left-close' : 'panel-left-open'}
      label={expanded ? 'Hide sidebar (Ctrl+B)' : 'Show sidebar (Ctrl+B)'}
      aria-expanded={expanded}
      onClick={toggleSidebar}
      {...rest}
    />
  );
}
