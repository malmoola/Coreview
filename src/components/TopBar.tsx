import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';

import { useStore } from '../state/store';
import { ipc } from '../lib/ipc';
import { buildMarkdownReport, saveExport, slug, svgToPng } from '../lib/exports';
import { renderDiagramSvg } from '../lib/diagram';
import { isVisible, layersOf } from '../lib/layers';
import { effectivePage } from '../lib/pageRect';
import { PAPERS, describePage, paperById, sheetSize, sheetsFor, tileRects } from '../lib/paper';
import { TIME_FORMATS, isLocalFormat, zoneLabel, type TimeFormat } from '../lib/timeFormat';
import { eventsToCsv, linksToCsv, nodesToCsv } from '../lib/csv';
import type { DeviceNodeData, HealthStatus, LinkData, NodeAddress } from '../types/domain';
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
  const recovery = useStore((s) => s.recovery);
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
  const paper = paperById(settings.paper);
  const sheet = sheetSize(paper, settings.orientation);
  /** Said in the menu, because "A3 landscape" does not tell anyone whether
   *  their diagram will still be readable on it. */
  const pageNote = (() => {
    if (paper.width === 0) return 'The file is sized to the diagram.';
    const bounds = store.doc.nodes.reduce(
      (acc, n) => ({
        w: Math.max(acc.w, n.position.x + (n.width ?? 176)),
        h: Math.max(acc.h, n.position.y + (n.height ?? 96)),
      }),
      { w: 1, h: 1 },
    );
    const tiles = sheetsFor({ width: bounds.w, height: bounds.h }, sheet);
    return tiles.total > 1
      ? `${describePage(paper, settings.orientation)} — shrunk to fit one sheet, ` +
        `or ${tiles.total} sheets at full size when printed.`
      : `${describePage(paper, settings.orientation)} — the diagram fits at full size.`;
  })();

  /** The diagram as it is being looked at, with hidden views left out. */
  const shown = (() => {
    const layers = layersOf(store.doc.canvas.layers);
    if (layers.every((l) => l.visible)) {
      return { nodes: store.doc.nodes, edges: store.doc.edges };
    }
    const nodes = store.doc.nodes.filter((n) =>
      isVisible((n.data as { layers?: string[] }).layers, layers),
    );
    const alive = new Set(nodes.map((n) => n.id));
    const edges = store.doc.edges.filter(
      (e) =>
        isVisible((e.data as { layers?: string[] } | undefined)?.layers, layers) &&
        alive.has(e.source) &&
        alive.has(e.target),
    );
    return { nodes, edges };
  })();

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
      // What is on screen, not what is in the file: a view hidden to prepare a
      // document must not reappear in the document.
      nodes: shown.nodes,
      edges: shown.edges,
      nodeStatus: (id) => store.nodeStatus(id),
      linkStatus: (id) => store.linkStatus(id),
      includeTitleBlock: true,
      nodeStyle: store.doc.canvas.nodeStyle ?? 'glyph',
      // What you are looking at is what comes out. Exporting dark from a
      // white screen put a black rectangle in the middle of a white page.
      ground: settings.ground,
      page: sheet.w > 0 ? { width: sheet.w, height: sheet.h } : undefined,
      // The on-screen page, computed from the same function the canvas draws
      // it with, and from the same visible nodes — hidden views do not hold
      // the exported sheet open either.
      sheetRect:
        (store.doc.canvas.page ?? true)
          ? effectivePage(store.doc.canvas.pageRect, shown.nodes)
          : undefined,
    });

  const exportSvg = () => {
    void runExport(`${slug(meta.name)}-diagram.svg`, diagramSvg, 'image/svg+xml');
  };

  // LT-028: how many sheets the diagram spans at full size on the chosen paper.
  const contentBounds = () => {
    if (store.doc.canvas.page ?? true) {
      const p = effectivePage(store.doc.canvas.pageRect, shown.nodes);
      return { x: p.x, y: p.y, width: p.w, height: p.h };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of shown.nodes) {
      minX = Math.min(minX, n.position.x); minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + (n.width ?? 176));
      maxY = Math.max(maxY, n.position.y + (n.height ?? 96));
    }
    if (!shown.nodes.length) return { x: 0, y: 0, width: 800, height: 600 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };
  const sheetTiles = () => tileRects(contentBounds(), sheet, 36);

  /** One SVG per sheet, each a full-size slice of the diagram (LT-028). Needs
   *  an export folder so the files land somewhere without one dialog per
   *  sheet; when none is set, the single-sheet SVG is written instead. */
  const exportSheets = async () => {
    const tiles = sheetTiles();
    if (tiles.length <= 1 || !store.settings.exportFolder) {
      exportSvg();
      if (tiles.length > 1) {
        store.setStatusMessage('Set an export folder to write one file per sheet.');
      }
      return;
    }
    setBusy('sheets');
    try {
      let last: string | null = null;
      for (const t of tiles) {
        const svg = renderDiagramSvg({
          meta,
          nodes: shown.nodes,
          edges: shown.edges,
          nodeStatus: (id) => store.nodeStatus(id),
          linkStatus: (id) => store.linkStatus(id),
          includeTitleBlock: true,
          nodeStyle: store.doc.canvas.nodeStyle ?? 'glyph',
          ground: settings.ground,
          page: { width: sheet.w, height: sheet.h },
          tile: { x: t.x, y: t.y, w: t.w, h: t.h },
        });
        last = await saveExport(
          `${slug(meta.name)}-sheet-r${t.row + 1}c${t.col + 1}.svg`,
          svg,
          'image/svg+xml',
          store.settings.exportFolder,
        );
      }
      store.setStatusMessage(last ? `Saved ${tiles.length} sheets to ${store.settings.exportFolder}` : null);
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /** LT-077: the same drawing the screen and the SVG export use, as a
   *  vector PDF — the format a change record or an approval wants. */
  const exportPdf = async () => {
    setBusy('pdf');
    try {
      const bytes = await ipc.diagramPdf(diagramSvg());
      await runExport(`${slug(meta.name)}-diagram.pdf`, () => bytes, 'application/pdf');
    } catch (err) {
      store.setStatusMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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

  /** The diagram as the two files the importer reads back. */
  const exportTopologyCsv = () => {
    const devices = store.doc.nodes.filter((n) => n.type === 'device');
    const nameOf = new Map(
      devices.map((n) => [n.id, String((n.data as DeviceNodeData).label ?? '')]),
    );
    const probeFor = (nodeId: string) =>
      store.doc.probes.find((p) => p.objectKind === 'node' && p.objectId === nodeId);

    const rows = devices.map((n) => {
      const d = n.data as DeviceNodeData;
      const probe = probeFor(n.id);
      return {
        label: d.label,
        type: d.deviceType,
        address:
          d.addresses?.find((a: NodeAddress) => a.isPrimary)?.address ??
          d.addresses?.[0]?.address ??
          '',
        probeType: probe?.kind ?? 'manual',
        port: probe?.kind === 'tcp' ? (probe.tcpPort ?? undefined) : undefined,
        notes: d.notes ?? '',
        tags: d.tags ?? [],
      };
    });
    void runExport(`${slug(meta.name)}-devices.csv`, () => nodesToCsv(rows), 'text/csv');

    // Links reference devices by name, because that is what the importer
    // matches on and what a person reading the file can follow.
    const links = store.doc.edges
      .filter((e) => nameOf.has(e.source) && nameOf.has(e.target))
      .map((e) => {
        const d = (e.data ?? {}) as LinkData;
        return {
          source: nameOf.get(e.source) ?? '',
          target: nameOf.get(e.target) ?? '',
          sourcePort: d.sourcePortLabel ?? '',
          targetPort: d.targetPortLabel ?? '',
          label: d.label ?? '',
          healthRule: d.healthRule?.type ?? 'both-endpoints',
        };
      });
    void runExport(`${slug(meta.name)}-links.csv`, () => linksToCsv(links), 'text/csv');
  };

  /**
   * Print on paper, which is white.
   *
   * The colours on the canvas are chosen against the ground they are drawn on
   * and half of them are set from script, so a diagram printed straight from
   * the dark ground comes out as pale grey lines on a white page. Switching
   * the ground first is the only way the printed sheet is the one that was
   * designed; it is put back afterwards, so nothing about the session changes.
   */
  const printOnPaper = async () => {
    // The page choice has to reach the print job, and only `@page` can carry
    // it — a stylesheet cannot be told a paper size any other way.
    const style = document.createElement('style');
    style.textContent =
      paper.width === 0
        ? '@page { margin: 10mm; }'
        : `@page { size: ${paper.name} ${settings.orientation}; margin: 10mm; }`;
    document.head.appendChild(style);

    const was = settings.ground;
    if (was !== 'light') {
      store.setSettings({ ground: 'light' });
      // Two frames: one for React to render the new ground, one for the
      // browser to paint it. Printing before the paint captures the old one.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    try {
      window.print();
    } finally {
      if (was !== 'light') store.setSettings({ ground: was });
      style.remove();
    }
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
    <div className="cv-topbar-wrap">
      {recovery && (
        <div className="cv-recovery" role="alert">
          <span>
            Unsaved work from {new Date(recovery.savedAt).toLocaleTimeString()} was found —
            this session ended before it could be saved.
          </span>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => store.restoreRecovery()}>
            Restore it
          </button>
          <button type="button" className="cv-btn cv-btn-small" onClick={() => store.discardRecovery()}>
            Keep what was saved
          </button>
        </div>
      )}
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
        <button
          type="button"
          className="cv-btn"
          /* Fits the sheet, not only what is on it: fitting to the devices
             alone puts the page edge off-screen, and the edge is the thing
             that says where the drawing surface is. */
          onClick={() =>
            (store.doc.canvas.page ?? true)
              ? (() => {
                  const sheet = effectivePage(store.doc.canvas.pageRect, store.doc.nodes);
                  rf.fitBounds({ x: sheet.x, y: sheet.y, width: sheet.w, height: sheet.h }, { padding: 0.08 });
                  if (rf.getZoom() > 2) rf.zoomTo(2);
                })()
              : rf.fitView({ padding: 0.2, maxZoom: 2 })
          }
        >
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
            <button type="button" onClick={() => void exportPdf()} disabled={busy === 'pdf'}>
              Diagram as PDF
            </button>
            <button type="button" onClick={() => void exportSheets()} disabled={busy === 'sheets'}>
              {sheetTiles().length > 1 ? `SVG sheets (${sheetTiles().length})` : 'SVG sheets'}
            </button>
            <div className="cv-dropdown-field" onClick={(e) => e.stopPropagation()}>
              <label>
                Page
                <select
                  className="cv-input"
                  value={settings.paper}
                  onChange={(e) => store.setSettings({ paper: e.target.value })}
                >
                  {PAPERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {paper.width > 0 && (
                <label>
                  Way round
                  <select
                    className="cv-input"
                    value={settings.orientation}
                    onChange={(e) =>
                      store.setSettings({
                        orientation: e.target.value as 'portrait' | 'landscape',
                      })
                    }
                  >
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </label>
              )}
              <span className="cv-help">{pageNote}</span>
            </div>

            <button type="button" onClick={() => void printOnPaper()}>
              Print / save as PDF
            </button>
            <button type="button" onClick={exportCsv}>
              Events as CSV
            </button>
            <button
              type="button"
              onClick={exportTopologyCsv}
              title="Two files — devices and links — in the same columns the CSV import reads"
            >
              Devices and links as CSV
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

        <button
          type="button"
          className="cv-btn"
          title="Draw on white — for a document, a projector, or daylight. Every colour is chosen against the ground it is on, not inverted."
          onClick={() =>
            store.setSettings({ ground: settings.ground === 'light' ? 'dark' : 'light' })
          }
        >
          {settings.ground === 'light' ? 'Dark background' : 'White background'}
        </button>

        <label className="cv-check cv-check-inline" title="The overview box, bottom-right">
          <input
            type="checkbox"
            checked={settings.minimap}
            onChange={(e) => store.setSettings({ minimap: e.target.checked })}
          />
          Overview
        </label>

        <label className="cv-check cv-check-inline" title="Stops all packet-dot animation">
          <input
            type="checkbox"
            checked={settings.reduceMotion}
            onChange={(e) => store.setSettings({ reduceMotion: e.target.checked })}
          />
          Reduce motion
        </label>

        {/* LT-076: how every timestamp is written. DTG is what an operator
            reads at a glance; a plain clock is what everyone else does. The
            zone is named in the tooltip so nobody has to guess. */}
        <label
          className="cv-check cv-check-inline"
          title={`Times shown in ${
            isLocalFormat(settings.timeFormat) ? zoneLabel() : 'Zulu (UTC)'
          }`}
        >
          Times
          <select
            className="cv-input cv-input-inline"
            value={settings.timeFormat}
            onChange={(e) => store.setSettings({ timeFormat: e.target.value as TimeFormat })}
          >
            {TIME_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
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
    </div>
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
