import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import { useStore } from '../state/store';
import { ipc } from '../lib/ipc';
import { buildMarkdownReport, saveExport, slug, svgToPng } from '../lib/exports';
import { renderDiagramSvg } from '../lib/diagram';
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
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const [about, setAbout] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Autosave. Runs only while a project is open and unsaved edits exist.
  useEffect(() => {
    if (!meta || !dirty) return;
    const t = setTimeout(() => void store.saveProject(), 2500);
    return () => clearTimeout(t);
  }, [meta, dirty, store]);

  // A bare <details> opens and then stays open: neither Escape nor a click
  // elsewhere closes it, so the export menu sat over the canvas until someone
  // clicked "Export" a second time. Give it the dismissal every other menu has.
  useEffect(() => {
    const away = (e: Event) => {
      const el = exportMenu.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    const key = (e: KeyboardEvent) => {
      const el = exportMenu.current;
      if (e.key !== 'Escape' || !el?.open) return;
      el.open = false;
      // Focus goes back to the control that opened it, or it lands on <body>
      // and the next Tab restarts from the top of the page.
      el.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, []);

  if (!meta) return null;

  const counts = statusCounts();

  /** Runs an export and reports where it landed, or that it failed. */
  const runExport = async (filename: string, build: () => string | Uint8Array | null, mime: string) => {
    try {
      const content = build();
      if (content === null) return;
      const path = await saveExport(filename, content, mime, store.settings.exportFolder);
      store.setStatusMessage(path ? `Saved ${path}` : null);
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  };

  /** The diagram is drawn from the document, not from what is on screen, so a
   *  device scrolled out of view is still in the file. */
  const diagramSvg = () =>
    renderDiagramSvg({
      meta,
      nodes: store.doc.nodes,
      edges: store.doc.edges,
      nodeStatus: (id) => store.nodeStatus(id),
      linkStatus: (id) => store.linkStatus(id),
      includeTitleBlock: true,
      nodeStyle: store.doc.canvas.nodeStyle ?? 'glyph',
    });

  const exportSvg = () => {
    void runExport(`${slug(meta.name)}-diagram.svg`, diagramSvg, 'image/svg+xml');
  };

  const exportPng = async () => {
    setBusy('png');
    try {
      const svg = diagramSvg();
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

  const exportPackage = async (withCredentials = false) => {
    const pkg = await ipc.loadProject(meta.id);
    if (!pkg) return;
    // Credentials are app-wide rather than part of a project, so they are
    // never in an export unless asked for. A project package is the thing
    // people send to each other, and quietly including every saved password
    // in it is how they escape.
    const payload = withCredentials
      ? { ...pkg, vault: await ipc.exportVault() }
      : pkg;
    await runExport(
      withCredentials ? `${slug(meta.name)}-with-credentials.coreview` : `${slug(meta.name)}.coreview`,
      () => JSON.stringify(payload, null, 2),
      'application/json',
    );
  };

  return (
    <header className="cv-topbar">
      <div className="cv-topbar-left">
        <span className="cv-brand">Coreview</span>
        <span className="cv-project-name" title={meta.description}>
          {meta.name}
        </span>
        {meta.customer && <span className="cv-project-sub">{meta.customer}</span>}
        {meta.ticket && <span className="cv-ticket">{meta.ticket}</span>}
        <span className={`cv-save-state ${dirty ? 'is-dirty' : ''}`}>
          {dirty
            ? 'Unsaved changes'
            : lastSavedAt
              ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}`
              : 'Saved'}
        </span>
      </div>

      <div className="cv-topbar-actions">
        <button type="button" className="cv-btn" onClick={() => void store.saveProject()}>
          Save
        </button>
        <button type="button" className="cv-btn" onClick={store.undo} title="Ctrl+Z">
          Undo
        </button>
        <button type="button" className="cv-btn" onClick={store.redo} title="Ctrl+Y">
          Redo
        </button>
        <button type="button" className="cv-btn" onClick={() => rf.fitView({ padding: 0.2 })}>
          Fit view
        </button>

        <div className="cv-divider" />

        {session.state === 'running' || session.state === 'stopping' ? (
          <button
            type="button"
            className="cv-btn cv-btn-stop"
            onClick={() => void store.stopValidation()}
          >
            Stop validation
          </button>
        ) : (
          <button
            type="button"
            className="cv-btn cv-btn-start"
            onClick={() => void store.startValidation()}
            disabled={session.state === 'starting'}
          >
            Start validation
          </button>
        )}

        <span className={`cv-session-state is-${session.state}`}>
          <span className="cv-dot" aria-hidden />
          {SESSION_LABEL[session.state]}
        </span>

        <div className="cv-counts">
          {(['healthy', 'warning', 'down', 'unknown'] as HealthStatus[]).map((s) => (
            <span key={s} className={`cv-count is-${s}`} title={STATUS_LABEL[s]}>
              {STATUS_LABEL[s]} {counts[s]}
            </span>
          ))}
        </div>

        <div className="cv-divider" />

        <details className="cv-dropdown" ref={exportMenu}>
          <summary className="cv-btn">Export</summary>
          <div
            className="cv-dropdown-menu"
            onClick={() => {
              if (exportMenu.current) exportMenu.current.open = false;
            }}
          >
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
            <button type="button" onClick={() => void exportPackage(false)}>
              Project package (.coreview)
            </button>
            <button
              type="button"
              className="cv-menu-danger"
              title="Includes every saved credential, still encrypted. Whoever opens it needs your vault passphrase."
              onClick={() => void exportPackage(true)}
            >
              Project package with saved credentials
            </button>
          </div>
        </details>

        <label className="cv-check cv-check-inline" title="Stops all packet-dot animation">
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(e) => store.setSettings({ reduceMotion: e.target.checked })}
          />
          Reduce motion
        </label>

        <button type="button" className="cv-btn" onClick={() => setAbout(true)}>
          About
        </button>
        <button
          type="button"
          className="cv-btn"
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
    <div className="cv-modal-backdrop" onClick={onClose} role="presentation">
      <div className="cv-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About Coreview">
        <h2>About Coreview</h2>
        <p className="cv-mono cv-help">Version {info?.version ?? '…'}</p>
        <h3>Where your data lives</h3>
        <p className="cv-mono cv-help">{info?.dataDir ?? '…'}</p>
        <h3>Privacy</h3>
        <p>
          Diagrams, notes, probe configuration and results stay on this machine. Coreview has no
          account, no cloud sync and no telemetry. It never contacts a server of its own.
        </p>
        <h3>What a green link actually means</h3>
        <p>
          Every check runs from this machine. A passing check proves this host reached the
          configured target with the configured method at that moment. It does not prove that each
          drawn line in the path is healthy, and it does not prove end-to-end application traffic.
          Each link shows status according to the health rule you selected for it.
        </p>
        <button type="button" className="cv-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
