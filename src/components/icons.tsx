/**
 * Device glyphs, drawn here rather than imported, so the app ships with no
 * third-party or vendor-trademarked artwork. All paths are on a 24x24 grid and
 * inherit `currentColor`.
 */
import type { DeviceType } from '../types/domain';

type P = { className?: string; style?: React.CSSProperties };
const S = (children: React.ReactNode) => (props: P) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={props.className}
    style={props.style}
    aria-hidden
  >
    {children}
  </svg>
);

const chassis = (
  <>
    <rect x="2" y="8" width="20" height="8" rx="1.5" />
    <path d="M5 12h2M9 12h2M13 12h2M17 12h2" />
  </>
);

export const ICONS: Record<DeviceType, (p: P) => JSX.Element> = {
  generic: S(
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h10M7 14h6" />
    </>,
  ),
  firewall: S(
    <>
      <path d="M3 5h18v6H3zM3 11h18v8H3z" />
      <path d="M9 5v6M15 5v6M6 11v8M12 11v8M18 11v8" />
    </>,
  ),
  router: S(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 9l-3 3 3 3M16 9l3 3-3 3M12 5v14" />
    </>,
  ),
  'core-switch': S(
    <>
      {chassis}
      <path d="M6 5h12M6 19h12" />
    </>,
  ),
  'distribution-switch': S(
    <>
      {chassis}
      <path d="M8 5h8" />
    </>,
  ),
  'access-switch': S(chassis),
  'wireless-controller': S(
    <>
      <rect x="2" y="9" width="20" height="8" rx="1.5" />
      <path d="M6 13h1.5M10 13h1.5" />
      <path d="M16 8.5a4 4 0 0 1 0 7M18.5 6a7 7 0 0 1 0 12" />
    </>,
  ),
  'access-point': S(
    <>
      <circle cx="12" cy="16" r="2.5" />
      <path d="M8.5 12.5a5 5 0 0 1 7 0M5.5 9.5a9 9 0 0 1 13 0" />
    </>,
  ),
  server: S(
    <>
      <rect x="4" y="3" width="16" height="7" rx="1.5" />
      <rect x="4" y="14" width="16" height="7" rx="1.5" />
      <path d="M8 6.5h.01M8 17.5h.01" />
    </>,
  ),
  vm: S(
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M9 9l4 2-4 2z" />
      <path d="M8 21h8" />
    </>,
  ),
  storage: S(
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>,
  ),
  endpoint: S(
    <>
      <rect x="3" y="5" width="18" height="11" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </>,
  ),
  printer: S(
    <>
      <path d="M7 9V4h10v5" />
      <rect x="3" y="9" width="18" height="7" rx="1.5" />
      <path d="M7 14h10v6H7z" />
    </>,
  ),
  camera: S(
    <>
      <path d="M3 8l14-3 2 6-14 3z" />
      <path d="M8 14v4a2 2 0 0 0 4 0" />
      <circle cx="15" cy="10" r="1" />
    </>,
  ),
  internet: S(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>,
  ),
  'private-cloud': S(
    <>
      <path d="M7 18a4 4 0 0 1 .6-8 5.5 5.5 0 0 1 10.6 1.6A3.4 3.4 0 0 1 17.5 18z" />
      <path d="M10 14h4" />
    </>,
  ),
  site: S(
    <>
      <path d="M3 20V9l9-5 9 5v11" />
      <path d="M9 20v-6h6v6" />
    </>,
  ),
  vpn: S(
    <>
      <path d="M9 15l-2.5 2.5a3.5 3.5 0 0 1-5-5L4 10" />
      <path d="M15 9l2.5-2.5a3.5 3.5 0 0 1 5 5L20 14" />
      <path d="M9 15l6-6" />
    </>,
  ),
  application: S(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </>,
  ),
  database: S(
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>,
  ),
  'custom-image': S(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5-5-9 9" />
    </>,
  ),
  rectangle: S(<rect x="3" y="6" width="18" height="12" />),
  rounded: S(<rect x="3" y="6" width="18" height="12" rx="4" />),
  circle: S(<circle cx="12" cy="12" r="8" />),
  diamond: S(<path d="M12 3l9 9-9 9-9-9z" />),
  cloud: S(<path d="M7 18a4 4 0 0 1 .6-8 5.5 5.5 0 0 1 10.6 1.6A3.4 3.4 0 0 1 17.5 18z" />),
  text: S(<path d="M5 6h14M12 6v13M9 19h6" />),
  zone: S(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" strokeDasharray="3 2" />
      <path d="M3 9h18" />
    </>,
  ),
};

export const DEVICE_LABEL: Record<DeviceType, string> = {
  generic: 'Generic device',
  firewall: 'Firewall',
  router: 'Router',
  'core-switch': 'Core switch',
  'distribution-switch': 'Distribution switch',
  'access-switch': 'Access switch',
  'wireless-controller': 'Wireless controller',
  'access-point': 'Wireless AP',
  server: 'Server',
  vm: 'Virtual machine',
  storage: 'Storage',
  endpoint: 'Endpoint / client',
  printer: 'Printer',
  camera: 'Camera / IoT',
  internet: 'ISP / Internet',
  'private-cloud': 'Private cloud',
  site: 'Data centre / site',
  vpn: 'VPN / tunnel',
  application: 'Application / service',
  database: 'Database',
  'custom-image': 'Custom image',
  rectangle: 'Rectangle',
  rounded: 'Rounded rectangle',
  circle: 'Circle',
  diamond: 'Diamond',
  cloud: 'Cloud',
  zone: 'Section',
  text: 'Text',
};

export const PALETTE_GROUPS: Array<{ title: string; items: DeviceType[] }> = [
  {
    title: 'Network',
    items: [
      'firewall',
      'router',
      'core-switch',
      'distribution-switch',
      'access-switch',
      'wireless-controller',
      'access-point',
      'vpn',
    ],
  },
  {
    title: 'Compute and services',
    items: ['server', 'vm', 'storage', 'application', 'database', 'endpoint', 'printer', 'camera'],
  },
  { title: 'Sites and clouds', items: ['internet', 'private-cloud', 'site', 'generic'] },
  {
    title: 'Shapes',
    items: ['zone', 'rectangle', 'rounded', 'circle', 'diamond', 'cloud', 'text', 'custom-image'],
  },
];
