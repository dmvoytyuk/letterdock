import { Icon, MsLogo } from '../../components/Icon';
import { Button } from '../../components/ui';
import { useUi } from '../../store/ui';

export function WelcomeScreen() {
  const open = (hintProvider?: 'gmail' | 'microsoft') => useUi.getState().set({ addAccount: { hintProvider } });
  return (
    <div className="wel">
      <div className="logo" aria-hidden="true">
        <Icon name="mail" />
      </div>
      <h1>Welcome to Mailroom</h1>
      <div className="sub">All your email accounts in one place. No limits.</div>
      <div className="btns">
        <Button onClick={() => open('gmail')}>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#4285F4' }} aria-hidden="true">G</span>
          Add a Gmail account
        </Button>
        <Button onClick={() => open('microsoft')}>
          <MsLogo />
          Add an Outlook or Microsoft account
        </Button>
        <Button onClick={() => open()}>
          <Icon name="at" />
          Other email (IMAP)
        </Button>
      </div>
      <div className="cap">Free. Unlimited accounts. Your mail stays on your PC.</div>
      <div className="links">
        <button type="button" className="link" onClick={() => useUi.getState().openSettings('general')}>
          Settings
        </button>
        <span aria-hidden="true">|</span>
        <button type="button" className="link" onClick={() => useUi.getState().openSettings('about')}>
          About
        </button>
      </div>
    </div>
  );
}
