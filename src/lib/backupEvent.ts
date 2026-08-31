import type { BackupEvent } from './ipc';

/**
 * Flatten a backup event from the wire (LT-073).
 *
 * The Rust side tags its enum adjacently — `{ kind, value: { … } }` — while
 * every reader here expects the fields alongside the kind. Nothing noticed
 * until a real backup succeeded: `bytes` was `undefined`, rendering it called
 * `.toLocaleString()` on nothing, and the throw took the whole window down.
 *
 * Kept pure and separate so the shape can be tested without a backend.
 */
export function normaliseBackupEvent(raw: unknown): BackupEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as { kind?: unknown; value?: unknown };
  if (typeof e.kind !== 'string') return null;
  // Already flat (an older backend, or an event with no payload).
  if (e.value === undefined || e.value === null) return raw as BackupEvent;
  if (typeof e.value !== 'object') {
    return { ...(raw as object), kind: e.kind } as BackupEvent;
  }
  const { value, ...rest } = e as { value: object };
  return { ...rest, ...value, kind: e.kind } as unknown as BackupEvent;
}
