import type { ContactInfo } from '../../../shared/ipc';

/** "Remove from suggestions" is offered for other people only; your own addresses are never removable (DESIGN-SPEC 3.7.1). */
export function showsForget(info: Pick<ContactInfo, 'isOwn'> | null | undefined): boolean {
  return !info?.isOwn;
}
