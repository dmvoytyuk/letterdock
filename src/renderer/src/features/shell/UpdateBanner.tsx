import { useState } from 'react';
import { Banner, Button } from '../../components/ui';
import { call } from '../../lib/api';
import { reportActionError } from '../../store/toasts';
import { useUpdates } from '../../store/updates';

/** Small banner under the title bar when an update is downloaded: "Restart to update" / "Later". */
export function UpdateBanner() {
  const status = useUpdates((s) => s.status);
  const dismissed = useUpdates((s) => s.dismissedVersion);
  const dismiss = useUpdates((s) => s.dismissBanner);
  const [busy, setBusy] = useState(false);
  if (status?.state !== 'ready' || dismissed === status.newVersion) return null;
  return (
    <Banner
      tone="info"
      role="status"
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              call('updates.install').catch((e) => {
                setBusy(false);
                reportActionError(e);
              });
            }}
          >
            Restart
          </Button>
          <Button size="sm" variant="subtle" disabled={busy} onClick={dismiss}>
            Later
          </Button>
        </>
      }
    >
      Mailroom {status.newVersion} is ready &mdash; Restart to update
    </Banner>
  );
}
