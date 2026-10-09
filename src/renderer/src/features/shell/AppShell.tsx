import { useEffect, useRef, useState } from 'react';
import { Sidebar } from '../sidebar/Sidebar';
import { MessageList } from '../list/MessageList';
import { ReadingPane } from '../reading/ReadingPane';
import { OutboxPane } from '../outbox/OutboxPane';
import { ResizeHandle } from '../../components/ui';
import { LIMITS, useUi } from '../../store/ui';
import { useList } from '../../store/list';

export function MailPanes() {
  const mode = useUi((s) => s.mode);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const sidebarW = useUi((s) => s.sidebarW);
  const listW = useUi((s) => s.listW);
  const drawerOpen = useUi((s) => s.drawerOpen);
  const readerOpen = useUi((s) => s.readerOpen);
  const selectedCount = useList((s) => s.selectedIds.length);
  const outbox = useUi((s) => s.view.kind === 'outbox');
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(window.innerWidth);

  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const fullSidebar = mode === 'wide' && !collapsed;
  const railSidebar = mode !== 'narrow' && !fullSidebar;
  const sidebarEff = fullSidebar ? sidebarW : railSidebar ? 48 : 0;
  // Keep the reading pane at least 360px wide.
  const maxList = Math.max(LIMITS.list.min, width - sidebarEff - LIMITS.readingMin - 4);
  const listCap = mode === 'medium' ? Math.min(listW, 340) : listW;
  const listEff = Math.max(LIMITS.list.min, Math.min(listCap, maxList, LIMITS.list.max));

  // Narrow: only the list or only the reading pane is visible.
  const showReader = mode === 'narrow' && readerOpen && selectedCount >= 1;

  // Closing the drawer with Escape or a click outside.
  useEffect(() => {
    if (!drawerOpen) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useUi.setState({ drawerOpen: false });
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [drawerOpen]);

  return (
    <div className="panes" ref={ref}>
      <a href="#pane-list" className="skip-link" onClick={(e) => { e.preventDefault(); document.querySelector<HTMLElement>('#pane-list [role=listbox]')?.focus(); }}>
        Skip to message list
      </a>
      {fullSidebar ? (
        <>
          <Sidebar variant="full" />
          <ResizeHandle
            label="Resize sidebar"
            value={sidebarW}
            min={LIMITS.sidebar.min}
            max={LIMITS.sidebar.max}
            onChange={(v) => useUi.setState({ sidebarW: v })}
            onReset={() => useUi.setState({ sidebarW: LIMITS.sidebar.def })}
          />
        </>
      ) : railSidebar ? (
        <>
          <Sidebar variant="rail" />
          <div className="handle" style={{ cursor: 'default' }} aria-hidden="true" />
        </>
      ) : null}
      {outbox ? (
        <OutboxPane />
      ) : mode === 'narrow' ? (
        showReader ? (
          <ReadingPane />
        ) : (
          <MessageList className="fill" />
        )
      ) : (
        <>
          <div style={{ width: listEff, display: 'flex', flex: 'none', minWidth: 0 }}>
            <MessageList className="fill" />
          </div>
          <ResizeHandle
            label="Resize message list"
            value={listEff}
            min={LIMITS.list.min}
            max={Math.min(LIMITS.list.max, maxList)}
            onChange={(v) => useUi.setState({ listW: v })}
            onReset={() => useUi.setState({ listW: LIMITS.list.def })}
          />
          <ReadingPane />
        </>
      )}
      {drawerOpen ? (
        <>
          <div className="drawer-scrim" onClick={() => useUi.setState({ drawerOpen: false })} />
          <Sidebar variant="drawer" />
        </>
      ) : null}
    </div>
  );
}
