import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import { useStore } from '../state/store';
import { ipc } from '../lib/ipc';
import {
  buildMarkdownReport,
  canvasToSvg,
  saveExport,
  slug,
  svgToPng,
} from '../lib/exports';
import { eventsToCsv } from '../lib/csv';
import type { HealthStatus } from '../types/domain';
import { STATUS_LABEL } from '../types/domain';

const SESSION_LABEL: Record<string, string> = {
  stopped: 'Validation stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  error: 'Error',
};

export function TopBar({ onExit }: { onExit: () => void }) {
  const meta = useStore((s) => s.meta);
  const dirty = useStore((s) => s.dirty);
  const lastSavedAt = useStore((s) => s.lastSavedAt);
  const session = useStore((s) => s.session);
  const settings = useStore((s) => s.settings);
  const store = useStore();
  const rf = useReactFlow();
  const [about, setAbout] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Autosave. Runs only while a project is open and unsaved edits exist.
  useEffect(() => {
    if (!meta || !dirty) return;
    const t = setTimeout(() => void store.saveProject(), 2500);
    return () => clearTimeout(t);
  }, [meta, dirty, store]);

  if (!meta) return null;

  const counts = statusCounts();

  /** Runs an export and reports where it landed, or that it failed. */
  const runExport = async (filename: string, build: () => string | Uint8Array | null, mime: string) => {
    try {
      const content = build();
      if (content === null) return;
      const path = await saveExport(filename, content, mime);
      store.setStatusMessage(path ? `Saved ${path}` : null);
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const exportSvg = () => {
    void runExport(`${slug(meta.name)}-diagram.svg`, () => canvasToSvg(meta, true), 'image/svg+xml');
  };

  const exportPng = async () => {
    setBusy('png');
    try {
      const svg = canvasToSvg(meta, true);
      if (!svg) return;
      // svgToPng returns a data: URL; the payload after the comma is the PNG.
      const dataUrl = await svgToPng(svg);
      const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) =>
        c.charCodeAt(0),
      );
      await runExport(`${slug(meta.name)}-diagram.png`, () => bytes, 'image/png');
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = () => {
    void runExport(`${slug(meta.name)}-events.csv`, () => eventsToCsv(store.events), 'text/csv');
  };

  const exportReport = () => {
    const md = buildMarkdownReport({
      meta,
      events: store.events,
      counts,
      nodeCount: store.doc.nodes.filter((n) => n.type === 'device').length,
      linkCount: store.doc.edges.length,
      sessionStart: session.startedAt,
      sessionEnd: session.state === 'stopped' ? Date.now() : null,
    });
    void runExport(`${slug(meta.name)}-report.md`, () => md, 'text/markdown');
  };

  const exportPackage = async () => {
    const pkg = await ipc.loadProject(meta.id);
    if (!pkg) return;
    await runExport(
      `${slug(meta.name)}.livetopo`,
      () => JSON.stringify(pkg, null, 2),
      'application/json',
    );
  };

  return (
    <header className="lt-topbar">
      <div className="lt-topbar-left">
        <span className="lt-brand">LiveTopo</span>
        <span className="lt-project-name" title={meta.description}>
          {meta.name}
        </span>
        {meta.customer && <span className="lt-project-sub">{meta.customer}</span>}
        {meta.ticket && <span className="lt-ticket">{meta.ticket}</span>}
        <span className={`lt-save-state ${dirty ? 'is-dirty' : ''}`}>
          {dirty
            ? 'Unsaved changes'
            : lastSavedAt
              ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}`
              : 'Saved'}
        </span>
      </div>

      <div className="lt-topbar-actions">
        <button type="button" className="lt-btn" onClick={() => void store.saveProject()}>
          Save
        </button>
        <button type="button" className="lt-btn" onClick={store.undo} title="Ctrl+Z">
          Undo
        </button>
        <button type="button" className="lt-btn" onClick={store.redo} title="Ctrl+Y">
          Redo
        </button>
        <button type="button" className="lt-btn" onClick={() => rf.fitView({ padding: 0.2 })}>
          Fit view
        </button>

        <div className="lt-divider" />

        {session.state === 'running' || session.state === 'stopping' ? (
          <button
            type="button"
            className="lt-btn lt-btn-stop"
            onClick={() => void store.stopValidation()}
          >
            Stop validation
          </button>
        ) : (
          <button
            type="button"
            className="lt-btn lt-btn-start"
            onClick={() => void store.startValidation()}
            disabled={session.state === 'starting'}
          >
            Start validation
          </button>
        )}

        <span className={`lt-session-state is-${session.state}`}>
          <span className="lt-dot" aria-hidden />
          {SESSION_LABEL[session.state]}
        </span>

        <div className="lt-counts">
          {(['healthy', 'warning', 'down', 'unknown'] as HealthStatus[]).map((s) => (
            <span key={s} className={`lt-count is-${s}`} title={STATUS_LABEL[s]}>
              {STATUS_LABEL[s]} {counts[s]}
            </span>
          ))}
        </div>

        <div className="lt-divider" />

        <details className="lt-dropdown">
          <summary className="lt-btn">Export</summary>
          <div className="lt-dropdown-menu">
            <button type="button" onClick={exportPng} disabled={busy === 'png'}>
              Diagram as PNG
            </button>
            <button type="button" onClick={exportSvg}>
              Diagram as SVG
            </button>
            <button type="button" onClick={() => window.print()}>
              Print / save as PDF
            </button>
            <button type="button" onClick={exportCsv}>
              Events as CSV
            </button>
            <button type="button" onClick={exportReport}>
              Validation report (Markdown)
            </button>
            <button type="button" onClick={() => void exportPackage()}>
              Project package (.livetopo)
            </button>
          </div>
        </details>

        <label className="lt-check lt-check-inline" title="Stops all packet-dot animation">
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(e) => store.setSettings({ reduceMotion: e.target.checked })}
          />
          Reduce motion
        </label>

        <button type="button" className="lt-btn" onClick={() => setAbout(true)}>
          About
        </button>
        <button
          type="button"
          className="lt-btn"
          onClick={() => {
            void store.closeProject().then(onExit);
          }}
        >
          Close project
        </button>
      </div>

      {about && <AboutDialog onClose={() => setAbout(false)} />}
    </header>
  );
}

function statusCounts(): Record<HealthStatus, number> {
  const s = useStore.getState();
  const counts: Record<HealthStatus, number> = {
    unknown: 0,
    healthy: 0,
    warning: 0,
    down: 0,
    disabled: 0,
    maintenance: 0,
  };
  for (const n of s.doc.nodes) {
    if (n.type !== 'device') continue;
    counts[s.nodeStatus(n.id)] += 1;
  }
  return counts;
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null);
  useEffect(() => {
    void ipc.appInfo().then(setInfo);
  }, []);

  return (
    <div className="lt-modal-backdrop" onClick={onClose} role="presentation">
      <div className="lt-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About LiveTopo">
        <h2>About LiveTopo</h2>
        <p className="lt-mono lt-help">Version {info?.version ?? '…'}</p>
        <h3>Where your data lives</h3>
        <p className="lt-mono lt-help">{info?.dataDir ?? '…'}</p>
        <h3>Privacy</h3>
        <p>
          Diagrams, notes, probe configuration and results stay on this machine. LiveTopo has no
          account, no cloud sync and no telemetry. It never contacts a server of its own.
        </p>
        <h3>What a green link actually means</h3>
        <p>
          Every check runs from this machine. A passing check proves this host reached the
          configured target with the configured method at that moment. It does not prove that each
          drawn line in the path is healthy, and it does not prove end-to-end application traffic.
          Each link shows status according to the health rule you selected for it.
        </p>
        <button type="button" className="lt-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
