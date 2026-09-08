/**
 * Bringing a Visio drawing in as a topology (LT-110).
 *
 * The drawing is read in Rust; this shows what came out and lets the operator
 * decide before anything lands on the canvas. A preview rather than a straight
 * import, for the same reason the crawl reports its findings instead of
 * folding them in silently: an import that quietly gets a device name or an
 * address wrong is worse than one that says what it is unsure about.
 *
 * And a preview you can only accept or reject is not much of a decision. A
 * drawing is a picture, so some of what is read out of one will be wrong no
 * matter how carefully it is read — a device the drawing never named, a link
 * whose ends were worked out from where the line was drawn. Everything here is
 * therefore editable before it is added: rename a device, correct an address,
 * change a type, fix which devices a link joins, drop what does not belong,
 * add what the drawing left out. What lands on the canvas is what is on
 * screen, not what the file said.
 *
 * What the drawing does not say, this still does not invent. A device with no
 * caption arrives named after its Visio master; a link whose ports were never
 * labelled arrives without ports.
 */
import { useMemo, useState } from 'react';

import { ipc, isDesktop, type ImportedPage, type VisioImport } from '../lib/ipc';
import { useStore } from '../state/store';
import { uid } from '../lib/id';
import { newProbe } from '../lib/probes';
import { makeDeviceNode } from './Canvas';
import type { DeviceNodeData, DeviceType, LinkData } from '../types/domain';
import type { TopoEdge } from '../state/store';
import { linkStyleDefaults } from '../lib/linkDefaults';
import { activePage } from '../lib/pages';
import { placeDevices } from '../lib/visioLayout';

/** A device as it stands in the preview, after any correction. */
interface DraftDevice {
  id: string;
  label: string;
  address: string;
  deviceType: string;
  model: string;
  properties: Record<string, string>;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DraftLink {
  id: string;
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
  color: string;
  glued: boolean;
}

interface DraftPage {
  name: string;
  devices: DraftDevice[];
  links: DraftLink[];
}

/** The device types offered in the preview, in the order the palette uses. */
const TYPES: DeviceType[] = [
  'router',
  'core-switch',
  'distribution-switch',
  'access-switch',
  'firewall',
  'wireless-controller',
  'access-point',
  'server',
  'storage',
  'internet',
  'endpoint',
  'printer',
  'camera',
  'generic',
];

function toDraft(pages: ImportedPage[]): DraftPage[] {
  return pages.map((p) => ({
    name: p.name,
    devices: p.devices.map((d) => ({
      id: d.id,
      label: d.label,
      // One address is what a check needs. The rest, if a caption carried
      // more than one, stay in the notes rather than being dropped.
      address: d.addresses[0] ?? '',
      deviceType: d.deviceType || 'generic',
      model: d.model,
      properties:
        d.addresses.length > 1
          ? { ...d.properties, 'Other addresses': d.addresses.slice(1).join(', ') }
          : d.properties,
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
    })),
    links: p.links.map((l, i) => ({
      id: `${p.name}-${i}`,
      source: l.source,
      target: l.target,
      sourcePort: l.sourcePort,
      targetPort: l.targetPort,
      color: l.color,
      glued: l.glued,
    })),
  }));
}

export function VisioImportPanel() {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draft, setDraft] = useState<DraftPage[] | null>(null);
  const [file, setFile] = useState<string>('');
  const [withProbes, setWithProbes] = useState(true);
  const [showLinks, setShowLinks] = useState(false);

  const pick = async () => {
    setProblem(null);
    try {
      const path = await ipc.pickVisioFile();
      if (!path) return;
      setBusy(true);
      setFile(path.split(/[\\/]/).pop() ?? path);
      const out: VisioImport = await ipc.importVisio(path);
      setDraft(toDraft(out.pages));
      setWarnings(out.warnings);
    } catch (err) {
      setDraft(null);
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Applies a change to one page of the draft. */
  const editPage = (index: number, patch: (p: DraftPage) => DraftPage) =>
    setDraft((d) => (d ? d.map((p, i) => (i === index ? patch(p) : p)) : d));

  const editDevice = (page: number, id: string, patch: Partial<DraftDevice>) =>
    editPage(page, (p) => ({
      ...p,
      devices: p.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    }));

  const dropDevice = (page: number, id: string) =>
    editPage(page, (p) => ({
      ...p,
      devices: p.devices.filter((d) => d.id !== id),
      // A link to a device that is no longer coming has nowhere to land.
      links: p.links.filter((l) => l.source !== id && l.target !== id),
    }));

  const addDevice = (page: number) =>
    editPage(page, (p) => {
      // Placed to the right of everything the drawing had, so a device added
      // by hand is visible rather than hidden under the diagram.
      const right = p.devices.reduce((max, d) => Math.max(max, d.x), 0);
      const y = p.devices.reduce((max, d) => Math.max(max, d.y), 0);
      return {
        ...p,
        devices: [
          ...p.devices,
          {
            id: `added-${uid()}`,
            label: 'New device',
            address: '',
            deviceType: 'generic',
            model: '',
            properties: {},
            x: right + 1.5,
            y,
            width: 0,
            height: 0,
          },
        ],
      };
    });

  const editLink = (page: number, id: string, patch: Partial<DraftLink>) =>
    editPage(page, (p) => ({
      ...p,
      links: p.links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));

  const dropLink = (page: number, id: string) =>
    editPage(page, (p) => ({ ...p, links: p.links.filter((l) => l.id !== id) }));

  /** Draws the preview onto the canvas, one Coreview page per Visio page. */
  const add = () => {
    if (!draft) return;
    let devices = 0;
    let links = 0;

    draft.forEach((page, pageIndex) => {
      // The first page goes onto whatever is open; the rest get their own, so
      // an 18-page drawing does not land on top of itself.
      if (pageIndex > 0) store.addPage(page.name || `Page ${pageIndex + 1}`);

      const placed = placeDevices(
        page.devices.map((d) => ({
          id: d.id,
          label: d.label,
          addresses: [],
          deviceType: d.deviceType,
          model: d.model,
          properties: {},
          x: d.x,
          y: d.y,
          width: d.width,
          height: d.height,
        })),
      );
      const idToNode = new Map<string, string>();

      for (const d of page.devices) {
        const at = placed.get(d.id);
        const node = makeDeviceNode(
          (d.deviceType || 'generic') as DeviceType,
          at?.x ?? 0,
          at?.y ?? 0,
        );
        if (at) {
          node.width = at.width;
          node.height = at.height;
        }
        const data = node.data as DeviceNodeData;
        data.label = d.label;
        if (d.model) data.model = d.model;
        data.addresses = d.address
          ? [{ id: uid(), label: 'Management', address: d.address, isPrimary: true }]
          : [];
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

        if (withProbes && store.meta && d.address) {
          store.upsertProbe(newProbe('node', node.id, store.meta.id, d.address, 'Imported'));
        }
      }

      for (const l of page.links) {
        const a = idToNode.get(l.source);
        const b = idToNode.get(l.target);
        if (!a || !b) continue;
        // Imported links take this diagram's own link style, except where the
        // drawing stated a colour of its own — an operator who drew the
        // carrier circuits orange meant something by it.
        const style = linkStyleDefaults(activePage(store.doc).canvas.linkStyle);
        const ports = [l.sourcePort, l.targetPort].filter(Boolean);
        const data: LinkData = {
          ...style,
          sourcePortLabel: l.sourcePort,
          targetPortLabel: l.targetPort,
          // The pair written on the line, the way the drawing wrote it.
          label: ports.length === 2 ? `${l.sourcePort} <> ${l.targetPort}` : (ports[0] ?? ''),
          ...(l.color ? { color: l.color, colorMode: 'fixed' as const } : {}),
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
    setDraft(null);
    setWarnings([]);
  };

  const totals = useMemo(() => {
    if (!draft) return null;
    const devices = draft.reduce((n, p) => n + p.devices.length, 0);
    return {
      devices,
      links: draft.reduce((n, p) => n + p.links.length, 0),
      named: draft.reduce(
        (n, p) => n + p.devices.filter((d) => d.label && d.label !== d.model).length,
        0,
      ),
      addressed: draft.reduce((n, p) => n + p.devices.filter((d) => d.address).length, 0),
      ported: draft.reduce(
        (n, p) => n + p.links.filter((l) => l.sourcePort || l.targetPort).length,
        0,
      ),
      inferred: draft.reduce((n, p) => n + p.links.filter((l) => !l.glued).length, 0),
    };
  }, [draft]);

  return (
    <div className="cv-import">
      <div className="cv-row cv-row-tight">
        <button type="button" className="cv-btn" disabled={!isDesktop || busy} onClick={pick}>
          {busy ? 'Reading…' : isDesktop ? 'Choose a .vsdx drawing' : 'Desktop app only'}
        </button>
        {draft && (
          <>
            <button type="button" className="cv-btn is-primary" onClick={add}>
              Add to diagram
            </button>
            <button type="button" className="cv-btn" onClick={() => setDraft(null)}>
              Discard
            </button>
          </>
        )}
      </div>

      <p className="cv-field-hint">
        Reads devices, links, addresses, port labels and line colours out of a Visio drawing.
        Correct anything that came out wrong below — nothing is added until you say so.
      </p>

      {problem && <p className="cv-warn">{problem}</p>}

      {draft && totals && (
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
            {file}: {totals.devices} devices, {totals.links} links across {draft.length} page
            {draft.length === 1 ? '' : 's'} — {totals.named} named, {totals.addressed} with an
            address, {totals.ported} with a port.
          </p>

          {totals.inferred > 0 && (
            <p className="cv-warn">
              {totals.inferred} of {totals.links} links were not glued to their shapes in the
              drawing, so which devices they join was worked out from where the line was drawn.
              Those are worth checking — everything else the drawing stated outright.
            </p>
          )}

          {warnings.map((w) => (
            <p className="cv-warn" key={w}>
              {w}
            </p>
          ))}

          {draft.map((p, pageIndex) => (
            <div key={p.name}>
              {draft.length > 1 && <h4 className="cv-palette-sub">{p.name}</h4>}
              <table className="cv-table cv-import-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Type</th>
                    <th>Address</th>
                    <th>From the drawing</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {p.devices.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <input
                          className="cv-input"
                          value={d.label}
                          spellCheck={false}
                          aria-label={`Name of ${d.label}`}
                          onChange={(e) => editDevice(pageIndex, d.id, { label: e.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          className="cv-input"
                          value={d.deviceType}
                          aria-label={`Type of ${d.label}`}
                          onChange={(e) =>
                            editDevice(pageIndex, d.id, { deviceType: e.target.value })
                          }
                        >
                          {TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="cv-input cv-mono"
                          value={d.address}
                          spellCheck={false}
                          placeholder="—"
                          aria-label={`Address of ${d.label}`}
                          onChange={(e) => editDevice(pageIndex, d.id, { address: e.target.value })}
                        />
                      </td>
                      <td className="cv-muted">{d.model}</td>
                      <td>
                        <button
                          type="button"
                          className="cv-btn is-danger"
                          aria-label={`Leave out ${d.label}`}
                          onClick={() => dropDevice(pageIndex, d.id)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="cv-row cv-row-tight">
                <button type="button" className="cv-btn" onClick={() => addDevice(pageIndex)}>
                  Add a device
                </button>
                <button
                  type="button"
                  className="cv-btn"
                  onClick={() => setShowLinks((s) => !s)}
                  aria-expanded={showLinks}
                >
                  {showLinks ? 'Hide' : 'Show'} the {p.links.length} links
                </button>
              </div>

              {showLinks && (
                <table className="cv-table cv-import-table">
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>Port</th>
                      <th>To</th>
                      <th>Port</th>
                      <th>Colour</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {p.links.map((l) => (
                      <tr key={l.id} className={l.glued ? undefined : 'cv-row-inferred'}>
                        <td>
                          <select
                            className="cv-input"
                            value={l.source}
                            aria-label="From device"
                            onChange={(e) =>
                              editLink(pageIndex, l.id, { source: e.target.value })
                            }
                          >
                            {p.devices.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="cv-input cv-mono"
                            value={l.sourcePort}
                            spellCheck={false}
                            placeholder="—"
                            aria-label="From port"
                            onChange={(e) =>
                              editLink(pageIndex, l.id, { sourcePort: e.target.value })
                            }
                          />
                        </td>
                        <td>
                          <select
                            className="cv-input"
                            value={l.target}
                            aria-label="To device"
                            onChange={(e) =>
                              editLink(pageIndex, l.id, { target: e.target.value })
                            }
                          >
                            {p.devices.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="cv-input cv-mono"
                            value={l.targetPort}
                            spellCheck={false}
                            placeholder="—"
                            aria-label="To port"
                            onChange={(e) =>
                              editLink(pageIndex, l.id, { targetPort: e.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            type="color"
                            className="cv-import-colour"
                            value={l.color || '#7d8590'}
                            aria-label="Line colour"
                            onChange={(e) => editLink(pageIndex, l.id, { color: e.target.value })}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="cv-btn is-danger"
                            aria-label="Leave out this link"
                            onClick={() => dropLink(pageIndex, l.id)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
