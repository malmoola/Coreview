import { useEffect, useState } from 'react';

import { ipc, type CredentialSummary } from '../lib/ipc';

/**
 * Choose a saved credential, or type one for this run.
 *
 * Typed is the default and always available: the vault is a convenience, and a
 * discovery run should never be blocked because someone has not set one up.
 *
 * When a saved credential is chosen the typed fields disappear rather than
 * being ignored — a form that shows a password box which does nothing is how
 * people end up certain they typed the right thing.
 */
export function CredentialPicker({
  kind,
  disabled,
  chosen,
  onChoose,
  children,
}: {
  kind: 'ssh' | 'snmp';
  disabled: boolean;
  chosen: string | null;
  onChoose: (id: string | null) => void;
  /** The typed fields, shown only when nothing is chosen. */
  children: React.ReactNode;
}) {
  const [saved, setSaved] = useState<CredentialSummary[]>([]);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    void ipc.vaultStatus().then((s) => setUnlocked(s.unlocked));
    void ipc
      .listCredentials()
      .then((all) => setSaved(all.filter((c) => c.kind === kind)))
      .catch(() => setSaved([]));
  }, [kind]);

  const usable = unlocked && saved.length > 0;

  return (
    <>
      {usable && (
        <label className="cv-field cv-field-narrow">
          <span>Credentials</span>
          <select
            className="cv-input"
            value={chosen ?? ''}
            disabled={disabled}
            onChange={(e) => onChoose(e.target.value || null)}
          >
            <option value="">Type them below</option>
            {saved.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* Hidden rather than ignored when a saved credential is in use. */}
      {!chosen && children}
    </>
  );
}
