import { useEffect, useRef, useState } from 'react';

import { useStore, type ProjectDocument } from '../state/store';
import { SAMPLES } from '../lib/samples';
import { ipc } from '../lib/ipc';
import { FolderSettings } from './FolderSettings';
import { HostKeySettings } from './HostKeySettings';
import type { ProjectMeta } from '../types/domain';

export function ProjectScreen() {
  const projects = useStore((s) => s.projects);
  const store = useStore();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ProjectMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void store.refreshProjects();
    // The chosen folders live in the database, so they have to be read back
    // before anything can use them.
    void store.loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = projects.filter((p) => p.archived === showArchived);

  const importPackage = async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      const pkg = JSON.parse(text) as { meta: ProjectMeta; document: ProjectDocument };
      if (!pkg?.meta?.name || !pkg.document) throw new Error('missing project metadata');
      await store.createProject(
        { ...pkg.meta, name: `${pkg.meta.name} (imported)` },
        pkg.document as ProjectDocument,
      );
    } catch (err) {
      setError(
        `That file could not be read as a Coreview project (${
          err instanceof Error ? err.message : String(err)
        }). Choose a .coreview file exported from Coreview (.livetopo files from\n        before the rename still work).`,
      );
    }
  };

  return (
    <div className="cv-welcome">
      <div className="cv-welcome-inner">
        <header className="cv-welcome-head">
          <h1>Coreview</h1>
          <p>
            Draw the topology you are actually working on, point it at real addresses, and watch
            the links while you work. Everything stays on this machine.
          </p>
        </header>

        <div className="cv-welcome-actions">
          <button type="button" className="cv-btn cv-btn-start" onClick={() => setCreating(true)}>
            Create project
          </button>
          <button type="button" className="cv-btn" onClick={() => fileRef.current?.click()}>
            Import project
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".coreview,.livetopo,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importPackage(f);
              e.target.value = '';
            }}
          />
          <label className="cv-check cv-check-inline">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>

        {error && <p className="cv-error">{error}</p>}

        <section className="cv-welcome-section">
          <h2>{showArchived ? 'Archived projects' : 'Recent projects'}</h2>
          {visible.length === 0 ? (
            <p className="cv-help">
              {showArchived
                ? 'Nothing archived.'
                : 'No projects yet. Create one, or open a sample below to see how validation works.'}
            </p>
          ) : (
            <ul className="cv-project-list">
              {visible.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="cv-project-open"
                    onClick={() => void store.openProject(p.id)}
                  >
                    <span className="cv-project-title">{p.name}</span>
                    <span className="cv-project-meta">
                      {[p.customer, p.site, p.ticket].filter(Boolean).join(' · ') || 'No metadata'}
                    </span>
                    <span className="cv-project-date">
                      Modified {new Date(p.updatedAt).toLocaleString()}
                    </span>
                  </button>
                  <div className="cv-project-tools">
                    <button
                      type="button"
                      className="cv-btn cv-btn-small"
                      onClick={() => void store.duplicateProject(p.id)}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="cv-btn cv-btn-small"
                      onClick={() =>
                        void ipc
                          .setArchived(p.id, !p.archived)
                          .then(() => store.refreshProjects())
                      }
                    >
                      {p.archived ? 'Restore' : 'Archive'}
                    </button>
                    <button
                      type="button"
                      className="cv-btn cv-btn-small is-danger"
                      onClick={() => setConfirmDelete(p)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="cv-welcome-section">
          <h2>Start from a sample</h2>
          <p className="cv-help">
            Samples use documentation address ranges. Only the loopback target will answer, so you
            can see healthy and failing states side by side without touching a live network.
          </p>
          <div className="cv-sample-grid">
            {SAMPLES.map((s) => (
              <button
                key={s.name}
                type="button"
                className="cv-sample"
                onClick={() =>
                  void store.createProject(
                    { name: s.name, customer: 'Example Customer', site: 'Example site', engineer: '' },
                    s.build(),
                  )
                }
              >
                <span className="cv-sample-title">{s.name.replace('Sample — ', '')}</span>
                <span className="cv-sample-desc">{s.description}</span>
              </button>
            ))}
          </div>
        </section>

        <FolderSettings />

        <HostKeySettings />

        <footer className="cv-welcome-foot">
          Coreview runs every check from this machine. It has no account, no cloud sync and no
          telemetry.
        </footer>
      </div>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {confirmDelete && (
        <div className="cv-modal-backdrop" role="presentation">
          <div className="cv-modal" role="dialog" aria-label="Confirm delete">
            <h2>Delete “{confirmDelete.name}”?</h2>
            <p>
              This removes the diagram, probe configuration and event history for this project from
              local storage. It cannot be undone.
            </p>
            <div className="cv-modal-actions">
              <button type="button" className="cv-btn" onClick={() => setConfirmDelete(null)}>
                Keep project
              </button>
              <button
                type="button"
                className="cv-btn is-danger"
                onClick={() => {
                  void store.deleteProject(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const create = useStore((s) => s.createProject);
  const [form, setForm] = useState({
    name: '',
    customer: '',
    site: '',
    ticket: '',
    engineer: '',
    description: '',
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="cv-modal-backdrop" onClick={onClose} role="presentation">
      <div className="cv-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create project">
        <h2>New project</h2>
        <label className="cv-field">
          <span className="cv-field-label">Project name</span>
          <input className="cv-input" autoFocus value={form.name} onChange={set('name')} />
        </label>
        <div className="cv-row">
          <label className="cv-field">
            <span className="cv-field-label">Customer</span>
            <input className="cv-input" value={form.customer} onChange={set('customer')} />
          </label>
          <label className="cv-field">
            <span className="cv-field-label">Site</span>
            <input className="cv-input" value={form.site} onChange={set('site')} />
          </label>
        </div>
        <div className="cv-row">
          <label className="cv-field">
            <span className="cv-field-label">Change ticket</span>
            <input className="cv-input" value={form.ticket} onChange={set('ticket')} />
          </label>
          <label className="cv-field">
            <span className="cv-field-label">Engineer</span>
            <input className="cv-input" value={form.engineer} onChange={set('engineer')} />
          </label>
        </div>
        <label className="cv-field">
          <span className="cv-field-label">Description</span>
          <textarea className="cv-input" rows={3} value={form.description} onChange={set('description')} />
        </label>
        <div className="cv-modal-actions">
          <button type="button" className="cv-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cv-btn cv-btn-start"
            disabled={!form.name.trim()}
            onClick={() => {
              void create(form);
              onClose();
            }}
          >
            Create project
          </button>
        </div>
      </div>
    </div>
  );
}
