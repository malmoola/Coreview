/**
 * Turning what was read out of a drawing into Coreview's own model (LT-110).
 *
 * Pulled out of the import panel so the decisions here can be stated as tests
 * rather than only as behaviour you have to import a file to see. Each of them
 * has already been got wrong once.
 */
import type { LinkData, NodeAddress } from '../types/domain';
import type { LinkStyleDefaults } from './linkDefaults';
import { uid } from './id';

/** What a link needs from the drawing, whether it came from the file or was
 *  corrected by hand in the preview first. */
export interface DraftLinkShape {
  sourcePort: string;
  targetPort: string;
  color: string;
}

/**
 * The link a drawing's cable becomes.
 *
 * Two things it does not simply inherit from the diagram's own link style:
 *
 * - **The path is a bezier**, not the smooth step a hand-drawn link defaults
 *   to. An import puts devices where the *drawing* put them rather than on a
 *   tidy grid, and an orthogonal route between two of those takes a long way
 *   round — it reads as routing that was meant, when it is only routing that
 *   was computed. A curve says "these two are joined" and nothing more.
 * - **A stated colour wins.** An operator who drew the carrier circuits in one
 *   colour and the fibre in another meant something by it, and an import that
 *   repaints everything the same has thrown that away.
 */
export function importedLinkData(style: LinkStyleDefaults, l: DraftLinkShape): LinkData {
  const ports = [l.sourcePort, l.targetPort].filter(Boolean);
  return {
    ...style,
    pathType: 'bezier',
    sourcePortLabel: l.sourcePort,
    targetPortLabel: l.targetPort,
    // The pair written along the line, the way the drawing writes it.
    label: ports.length === 2 ? `${l.sourcePort} <> ${l.targetPort}` : (ports[0] ?? ''),
    ...(l.color ? { color: l.color, colorMode: 'fixed' as const } : {}),
    enabled: true,
    maintenance: false,
    healthRule: { type: 'both-endpoints' },
  };
}

/**
 * The addresses a device arrives with.
 *
 * A caption often carries more than one — a management address and a loopback,
 * say. The first is the one checks are aimed at; the rest used to be flattened
 * into the notes as text, which is where an address goes to be forgotten. They
 * are real addresses and the model already holds as many as you like, so they
 * arrive as addresses and can be pointed at a check later.
 */
export function importedAddresses(addresses: string[]): NodeAddress[] {
  return addresses.map((address, i) => ({
    id: uid(),
    label: i === 0 ? 'Management' : `Address ${i + 1}`,
    address,
    isPrimary: i === 0,
  }));
}
