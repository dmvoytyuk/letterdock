// Mount points for the pieces that load on first use (DESIGN-SPEC 3.13): the Snooze menu, the Unsubscribe
// dialogs and the command box. Nothing is imported until the user opens one of them.
import { Suspense, lazy } from 'react';
import { useUi } from '../../store/ui';

const SnoozeHost = lazy(() => import('./SnoozeHost'));
const UnsubscribeHost = lazy(() => import('./unsubscribeFlow'));
const CommandBox = lazy(() => import('./CommandBox'));

export function LightHosts() {
  const snooze = useUi((s) => s.snooze !== null);
  const unsubscribe = useUi((s) => s.unsubscribe !== null);
  const command = useUi((s) => s.commandBoxOpen);
  if (!snooze && !unsubscribe && !command) return null;
  return (
    <Suspense fallback={null}>
      {snooze ? <SnoozeHost /> : null}
      {unsubscribe ? <UnsubscribeHost /> : null}
      {command ? <CommandBox /> : null}
    </Suspense>
  );
}
