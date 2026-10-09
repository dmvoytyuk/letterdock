import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { TitleBar } from './features/shell/TitleBar';
import { MailPanes } from './features/shell/AppShell';
import { WelcomeScreen } from './features/shell/Welcome';
import { SettingsPage } from './features/settings/SettingsPage';
import { AddAccountDialog } from './features/account/AddAccountDialog';
import { CheatsheetDialog, FolderDialogHost, RemoveAccountDialogHost } from './features/dialogs/Dialogs';
import { MailDialogsHost } from './features/dialogs/MailDialogs';
import { useGlobalShortcuts } from './features/shell/useGlobalShortcuts';
import { Banner, Button, MenuHost, ToastHost } from './components/ui';
import { useApp } from './store/app';
import { useUi } from './store/ui';
import { UpdateBanner } from './features/shell/UpdateBanner';
import { useAppEvents, useLayoutModeEffect, useThemeEffect } from './lib/hooks';
import { logRenderer } from './lib/api';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    logRenderer('error', `${error.message}\n${info.componentStack ?? ''}`);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="err-boundary" role="alert">
        <h2 style={{ marginBottom: 12 }}>Something went wrong</h2>
        <p style={{ marginBottom: 16 }}>The screen could not be shown. Your mail is safe.</p>
        <Button variant="primary" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}

export function App() {
  useThemeEffect();
  useLayoutModeEffect();
  useAppEvents();
  useGlobalShortcuts();

  const loaded = useApp((s) => s.loaded);
  const loadError = useApp((s) => s.loadError);
  const accountCount = useApp((s) => s.accounts.length);
  const page = useUi((s) => s.page);
  const addAccount = useUi((s) => s.addAccount);

  // Keep the page title useful for screen readers.
  useEffect(() => {
    document.title = 'Mailroom';
  }, []);

  let body: ReactNode;
  if (!loaded) body = <div className="wel" aria-busy="true"><i className="spin big" /></div>;
  else if (loadError)
    body = (
      <div className="err-boundary">
        <Banner
          tone="danger"
          actions={
            <>
              <Button size="sm" onClick={() => void useApp.getState().loadAll()}>Retry</Button>
              <button type="button" className="link" onClick={() => void window.api.invoke('app.openLogs')}>Open log folder</button>
            </>
          }
        >
          Mailroom can&apos;t read its data. {loadError.message}
        </Banner>
      </div>
    );
  else if (page === 'settings') body = <SettingsPage />;
  else if (accountCount === 0) body = <WelcomeScreen />;
  else body = <MailPanes />;

  return (
    <ErrorBoundary>
      <div className="app">
        <TitleBar />
        <UpdateBanner />
        {body}
        {addAccount ? <AddAccountDialog request={addAccount} /> : null}
        <FolderDialogHost />
        <RemoveAccountDialogHost />
        <CheatsheetDialog />
        <MailDialogsHost />
        <MenuHost />
        <ToastHost />
      </div>
    </ErrorBoundary>
  );
}
