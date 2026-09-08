/**
 * Bringing a Visio drawing in as a topology (LT-110).
 *
 * The drawing is read in Rust; this shows what came out and lets the operator
 * decide before anything lands on the canvas. A preview rather than a straight
 * import, for the same reason the crawl reports its findings instead of
 * folding them in silently: an import that quietly gets a device name or an
 * address wrong is worse than one that says what it is unsure about.
 *
 * What the drawing does not say, this does not invent. A device with no
 * caption arrives named after its Visio master; a link whose ports were never
 * labelled arrives without ports.
 */
import { useState } from 'react';

import { ipc, isDesktop, type VisioImport } from '../lib/ipc';
import { useStore } from '../state/store';
import { uid } from '../lib/id';
import { newProbe } from '../lib/probes';
import { makeDeviceNode } from './Canvas';
import type { DeviceNodeData, DeviceType, LinkData } from '../types/domain';
import type { TopoEdge } from '../state/store';
import { linkStyleDefaults } from '../lib/linkDefaults';
import { activePage } from '../lib/pages';

export function VisioImportPanel() {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<VisioImport | null>(null);
  const [file, setFile] = useState<string>('');
  const [withProbes, setWithProbes] = useState(true);

  const pick = async () => {
    setProblem(null);
    try {
      const path = await ipc.pickVisioFile();
      if (!path) return;
      setBusy(true);
      setFile(path.split(/[\\/]/).pop() ?? path);
      setResult(await ipc.importVisio(path));
    } catch (err) {
      setResult(null);
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Draws the preview onto the canvas, one Coreview page per Visio page. */
  const add = () => {
    if (!result) return;
    let devices = 0;
    let links = 0;

    result.pages.forEach((page, pageIndex) => {
      // The first page goes onto whatever is open; the rest get their own, so
      // an 18-page drawing does not land on top of itself.
      if (pageIndex > 0) store.addPage(page.name || `Page ${pageIndex + 1}`);

      // Visio measures in inches from the bottom-left; the canvas is pixels
      // from the top-left. 96 px to the inch, and the Y axis flips.
      const ys = page.devices.map((d) => d.y);
      const top = ys.length ? Math.max(...ys) : 0;
      const idToNode = new Map<string, string>();

      for (const d of page.devices) {
        const node = makeDeviceNode(
          (d.deviceType || 'generic') as DeviceType,
          Math.round(d.x * 96),
          Math.round((top - d.y) * 96),
        );
        const data = node.data as DeviceNodeData;
        data.label = d.label;
        if (d.model) data.model = d.model;
        data.addresses = d.addresses.map((a, i) => ({
          id: uid(),
          label: i === 0 ? 'Management' : `Address ${i + 1}`,
          address: a,
          isPrimary: i === 0,
        }));
        // Shape Data the drawing carried — vendor, part number, room. Kept as
        // notes rather than dropped, since it is the operator's own data.
        const props = Object.entries(d.properties ?? {});
        if (props.length) {
          data.notes = props.map(([k, v]) => `${k}: ${v}`).join('\n');
          const vendor = d.properties.Manufacturer ?? d.properties.manufacturer;
          if (vendor) data.vendor = vendor;
          const room = d.properties.Room ?? d.properties.room;
          if (room) data.rack = room;
        }
        store.addNode(node);
        idToNode.set(d.id, node.id);
        devices += 1;

        if (withProbes && store.meta && d.addresses[0]) {
          store.upsertProbe(
            newProbe('node', node.id, store.meta.id, d.addresses[0], 'Imported'),
          );
        }
      }

      for (const l of page.links) {
        const a = idToNode.get(l.source);
        const b = idToNode.get(l.target);
        if (!a || !b) continue;
        // Imported links take this diagram's own link style, so they look like
        // links drawn by hand rather than announcing where they came from.
        const style = linkStyleDefaults(activePage(store.doc).canvas.linkStyle);
        const data: LinkData = {
          ...style,
          sourcePortLabel: l.sourcePort,
          targetPortLabel: l.targetPort,
          label: l.label,
          enabled: true,
          maintenance: false,
          healthRule: { type: 'both-endpoints' },
        };
        store.addEdge({ id: uid(), source: a, target: b, data } as TopoEdge);
        links += 1;
      }
    });

    store.setStatusMessage(
      `Imported ${devices} device${devices === 1 ? '' : 's'} and ${links} link${links === 1 ? '' : 's'} from ${file}`,
    );
    setResult(null);
  };

  const totals = result
    ? {
        devices: result.pages.reduce((n, p) => n + p.devices.length, 0),
        links: result.pages.reduce((n, p) => n + p.links.length, 0),
        named: result.pages.reduce(
          (n, p) => n + p.devices.filter((d) => d.label && d.label !== d.model).length,
          0,
        ),
        addressed: result.pages.reduce(
          (n, p) => n + p.devices.filter((d) => d.addresses.length > 0).length,
          0,
        ),
        ported: result.pages.reduce(
          (n, p) => n + p.links.filter((l) => l.sourcePort || l.targetPort).length,
          0,
        ),
      }
    : null;

  return (
    <div className="cv-import">
      <div className="cv-row cv-row-tight">
        <button type="button" className="cv-btn" disabled={!isDesktop || busy} onClick={pick}>
          {busy ? 'Reading…' : isDesktop ? 'Choose a .vsdx drawing' : 'Desktop app only'}
        </button>
        {result && (
          <button type="button" className="cv-btn is-primary" onClick={add}>
            Add to diagram
          </button>
        )}
      </div>

      <p className="cv-field-hint">
        Reads devices, links, addresses and port labels out of a Visio drawing. Nothing is
        added until you say so.
      </p>

      {problem && <p className="cv-warn">{problem}</p>}

      {result && totals && (
        <>
          <label className="cv-check">
            <input
              type="checkbox"
              checked={withProbes}
              onChange={(e) => setWithProbes(e.target.checked)}
            />
            Also create a check for every device that has an address
          </label>

          <p className="cv-field-hint">
            {file}: {totals.devices} devices, {totals.links} links across{' '}
            {result.pages.length} page{result.pages.length === 1 ? '' : 's'} — {totals.named}{' '}
            named, {totals.addressed} with an address, {totals.ported} with a port.
          </p>

          {result.warnings.map((w) => (
            <p className="cv-warn" key={w}>
              {w}
            </p>
          ))}

          {result.pages.map((p) => (
            <div key={p.name}>
              {result.pages.length > 1 && <h4 className="cv-palette-sub">{p.name}</h4>}
              <table className="cv-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Type</th>
                    <th>Address</th>
                    <th>From the drawing</th>
                  </tr>
                </thead>
                <tbody>
                  {p.devices.map((d) => (
                    <tr key={d.id}>
                      <td>{d.label}</td>
                      <td className="cv-muted">{d.deviceType}</td>
                      <td className="cv-mono">
                        {d.addresses.join(', ') || <span className="cv-muted">—</span>}
                      </td>
                      <td className="cv-muted">{d.model}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
