import { useEffect, useState } from 'react';

import { ipc, isDesktop, type CredentialSummary, type VaultStatus } from '../lib/ipc';

/** The eye, drawn rather than imported so the app ships no third-party art. */
function Eye({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z" />
      <circle cx="12" cy="12" r="3.2" />
      {!open && <path d="M3 21 21 3" />}
    </svg>
  );
}

/**
 * Saved credentials, and the passphrase that protects them.
 *
 * Credentials are encrypted with a key derived from a passphrase that is never
 * stored, so forgetting it means re-entering them — there is no recovery path,
 * because a recovery path is a second way in.
 *
 * A stored secret can be revealed, deliberately and one at a time. That is a
 * real cost, and the copy says so rather than implying the value is unreachable
 * when it is one click away.
 */
export function VaultSettings() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, { secret: string; second: string | null }>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Adding a credential.
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'ssh' | 'snmp'>('ssh');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [secondSecret, setSecondSecret] = useState('');

  const refresh = () => {
    void ipc.vaultStatus().then(setStatus).catch(() => setStatus(null));
    void ipc.listCredentials().then(setCredentials).catch(() => setCredentials([]));
  };

  useEffect(refresh, []);

  const act = (p: Promise<unknown>, done: string) => {
    setProblem(null);
    void p
      .then(() => {
        setMessage(done);
        setPassphrase('');
        setConfirmPassphrase('');
        refresh();
      })
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const create = () => {
    if (passphrase !== confirmPassphrase) {
      setProblem('The two passphrases do not match.');
      return;
    }
    act(ipc.createVault(passphrase), 'Vault created and unlocked for this session.');
  };

  const toggleReveal = (id: string) => {
    if (revealed[id]) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setProblem(null);
    void ipc
      .revealCredential(id)
      .then((c) =>
        setRevealed((prev) => ({ ...prev, [id]: { secret: c.secret, second: c.secondSecret } })),
      )
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };

  const save = () => {
    act(
      ipc
        .saveCredential({
          label: label.trim(),
          kind,
          username: username.trim(),
          secret,
          secondSecret: secondSecret || undefined,
        })
        .then(() => {
          setAdding(false);
          setLabel('');
          setUsername('');
          setSecret('');
          setSecondSecret('');
        }),
      'Saved.',
    );
  };

  if (!isDesktop || !status) return null;

  return (
    <section className="cv-vault">
      <h2>Saved credentials</h2>

      {!status.exists ? (
        <>
          <p className="cv-help">
            Typing credentials for each run is the default and needs nothing set up. A vault is
            for the other case — backing up ninety devices without sitting through it, or not
            retyping the same enable password all day.
          </p>
          <p className="cv-help">
            Credentials are encrypted with a key derived from a passphrase that is never stored.
            Forget it and you re-enter the credentials; there is no recovery, because a recovery
            path is a second way in.
          </p>
          <div className="cv-discover-form">
            <label className="cv-field">
              <span>Passphrase (at least {status.minimumPassphrase} characters)</span>
              <input className="cv-input" type="password" value={passphrase} autoComplete="new-password"
                onChange={(e) => setPassphrase(e.target.value)} />
            </label>
            <label className="cv-field">
              <span>Again</span>
              <input className="cv-input" type="password" value={confirmPassphrase}
                autoComplete="new-password" onChange={(e) => setConfirmPassphrase(e.target.value)} />
            </label>
            <button type="button" className="cv-btn cv-btn-start" onClick={create}
              disabled={passphrase.length < status.minimumPassphrase}>
              Create vault
            </button>
          </div>
        </>
      ) : !status.unlocked ? (
        <>
          <p className="cv-help">
            Locked. {status.credentials} credential{status.credentials === 1 ? '' : 's'} saved.
          </p>
          <div className="cv-discover-form">
            <label className="cv-field">
              <span>Passphrase</span>
              <input className="cv-input" type="password" value={passphrase} autoComplete="current-password"
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && act(ipc.unlockVault(passphrase), 'Unlocked.')} />
            </label>
            <button type="button" className="cv-btn cv-btn-start"
              onClick={() => act(ipc.unlockVault(passphrase), 'Unlocked.')} disabled={!passphrase}>
              Unlock
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="cv-vault-bar">
            <span className="cv-help">
              Unlocked for this session. {credentials.length} saved.
            </span>
            <button type="button" className="cv-btn cv-btn-small"
              onClick={() => act(ipc.lockVault(), 'Locked.')}>
              Lock
            </button>
            <button type="button" className="cv-btn cv-btn-small" onClick={() => setAdding((a) => !a)}>
              {adding ? 'Cancel' : 'Add credential'}
            </button>
          </div>

          {adding && (
            <div className="cv-discover-form cv-vault-add">
              <label className="cv-field cv-field-narrow">
                <span>Name</span>
                <input className="cv-input" value={label} placeholder="Core switches"
                  onChange={(e) => setLabel(e.target.value)} />
              </label>
              <label className="cv-field cv-field-narrow">
                <span>For</span>
                <select className="cv-input" value={kind}
                  onChange={(e) => setKind(e.target.value as 'ssh' | 'snmp')}>
                  <option value="ssh">SSH</option>
                  <option value="snmp">SNMP</option>
                </select>
              </label>
              <label className="cv-field cv-field-narrow">
                <span>{kind === 'snmp' ? 'v3 user (blank for v2c)' : 'Username'}</span>
                <input className="cv-input" value={username} autoComplete="off"
                  onChange={(e) => setUsername(e.target.value)} />
              </label>
              <label className="cv-field cv-field-narrow">
                <span>{kind === 'snmp' ? 'Community or auth password' : 'Password'}</span>
                <input className="cv-input" type="password" value={secret} autoComplete="off"
                  onChange={(e) => setSecret(e.target.value)} />
              </label>
              <label className="cv-field cv-field-narrow">
                <span>{kind === 'snmp' ? 'Privacy password' : 'Enable password'}</span>
                <input className="cv-input" type="password" value={secondSecret} autoComplete="off"
                  onChange={(e) => setSecondSecret(e.target.value)} />
              </label>
              <button type="button" className="cv-btn cv-btn-start" onClick={save}
                disabled={!label.trim() || !secret}>
                Save
              </button>
            </div>
          )}

          {credentials.length > 0 && (
            <table className="cv-table cv-vault-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>For</th>
                  <th>User</th>
                  <th>Secret</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => {
                  const shown = revealed[c.id];
                  return (
                    <tr key={c.id}>
                      <td>{c.label}</td>
                      <td>{c.kind.toUpperCase()}</td>
                      <td className="cv-mono">{c.username || '—'}</td>
                      <td className="cv-mono cv-secret-cell">
                        <span>{shown ? shown.secret : '••••••••'}</span>
                        {shown?.second && <span className="cv-second-secret"> · {shown.second}</span>}
                        {!shown && c.hasSecondSecret && <span className="cv-second-secret"> · ••••••••</span>}
                        <button type="button" className="cv-eye" onClick={() => toggleReveal(c.id)}
                          title={shown ? 'Hide' : 'Show'}
                          aria-label={shown ? `Hide the secret for ${c.label}` : `Show the secret for ${c.label}`}>
                          <Eye open={!shown} />
                        </button>
                      </td>
                      <td>
                        <button type="button" className="cv-btn cv-btn-small"
                          onClick={() => act(ipc.deleteCredential(c.id), 'Deleted.')}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}

      {status.exists && (
        <div className="cv-hostkey-actions">
          {confirmDiscard ? (
            <>
              <span className="cv-help">
                Discard the vault and all {status.credentials} credential
                {status.credentials === 1 ? '' : 's'}? Without the passphrase they cannot be read,
                so there is nothing to keep. This cannot be undone.
              </span>
              <button type="button" className="cv-btn cv-btn-small" onClick={() => setConfirmDiscard(false)}>
                Keep them
              </button>
              <button type="button" className="cv-btn cv-btn-small cv-btn-danger"
                onClick={() => { setConfirmDiscard(false); act(ipc.discardVault(), 'Vault discarded.'); }}>
                Discard everything
              </button>
            </>
          ) : (
            <button type="button" className="cv-btn cv-btn-small"
              onClick={() => { setMessage(null); setConfirmDiscard(true); }}>
              Forgot the passphrase — start again
            </button>
          )}
        </div>
      )}

      {problem && <p className="cv-discover-problem cv-hostkey-message">{problem}</p>}
      {message && !problem && <p className="cv-help cv-hostkey-message">{message}</p>}
    </section>
  );
}
