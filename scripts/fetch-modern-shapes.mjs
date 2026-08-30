#!/usr/bin/env node
/**
 * Builds a modern shape library from two permissively licensed sets.
 *
 * Coreview draws its own glyphs and ships no third-party artwork, which is why
 * the icon library points at a folder rather than at anything bundled. This
 * fills that folder: a curated slice of Tabler Icons (MIT) for equipment and
 * concepts, and Simple Icons (CC0) for the vendor marks a network diagram
 * actually names — Cisco, Fortinet, Ubiquiti, AWS.
 *
 * Curated rather than complete. Tabler has five thousand icons and Simple
 * Icons three thousand brands; a palette of eight thousand entries is not a
 * palette. What is here is what turns up on network diagrams.
 *
 * The licences are written next to the icons, because a folder of artwork with
 * no licence beside it is a problem waiting to happen.
 *
 *     node scripts/fetch-modern-shapes.mjs <output-folder>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/fetch-modern-shapes.mjs <output-folder>');
  process.exit(2);
}

const TABLER = 'https://raw.githubusercontent.com/tabler/tabler-icons/main/icons/outline';
const SIMPLE = 'https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons';

/** Equipment and concepts, by the group they belong in on a diagram. */
const shapes = {
  'Network': [
    'router', 'network', 'switch-3', 'access-point', 'antenna-bars-5', 'wifi', 'wifi-off',
    'topology-star-3', 'topology-ring-3', 'topology-bus', 'topology-full-hierarchy',
    'plug-connected', 'world', 'route', 'arrows-split-2', 'binary-tree', 'nfc', 'devices-2',
  ],
  'Security': [
    'shield', 'shield-lock', 'shield-check', 'shield-x', 'shield-bolt', 'wall', 'lock', 'key',
    'certificate', 'eye-off', 'alert-triangle', 'bug', 'virus',
  ],
  'Compute': [
    'server', 'server-2', 'server-bolt', 'cpu', 'stack-2', 'box', 'container',
    'brand-docker', 'device-desktop', 'device-laptop', 'device-imac', 'terminal-2',
  ],
  'Storage and data': [
    'database', 'database-export', 'disc', 'file-stack', 'archive', 'cloud-data-connection',
  ],
  'Cloud': [
    'cloud', 'cloud-computing', 'cloud-lock', 'cloud-network', 'cloud-up', 'building-broadcast-tower',
  ],
  'Endpoints': [
    'printer', 'device-mobile', 'device-tablet', 'phone', 'headset', 'camera', 'device-tv',
    'device-watch', 'scan', 'battery-charging', 'temperature',
  ],
  'Places and people': [
    'building', 'building-factory-2', 'building-warehouse', 'home', 'map-pin', 'users', 'user',
  ],
  'Monitoring': [
    'activity', 'chart-line', 'gauge', 'clock-hour-4', 'bell', 'report-analytics',
  ],
};

/** Vendor marks. These are trademarks: the icons are CC0, the logos are not,
 *  and using them to label your own network diagram is exactly what they are
 *  for — but they must not end up in the app itself. */
const brands = {
  'Vendors — network': [
    'cisco', 'fortinet', 'ubiquiti', 'mikrotik', 'tplink', 'netgear', 'huawei',
    'paloaltonetworks', 'openwrt', 'pfsense', 'opnsense', 'wireshark',
  ],
  'Vendors — platform': [
    'vmware', 'proxmox', 'redhat', 'ubuntu', 'debian', 'linux', 'apple', 'android',
    'raspberrypi', 'synology', 'truenas',
  ],
  'Vendors — cloud': [
    'googlecloud', 'cloudflare', 'digitalocean', 'kubernetes', 'docker',
  ],
  'Vendors — software': [
    'grafana', 'prometheus', 'elastic', 'nginx', 'apache', 'mysql', 'postgresql',
    'redis', 'mongodb', 'openvpn', 'wireguard',
  ],
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const humanise = (s) =>
  s
    // Tabler prefixes its logo icons with "brand-", which is a fact about
    // Tabler's filing system and not about the thing being drawn.
    .replace(/^brand-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s(\d)$/, ' $1');

async function fetchIcon(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes('<svg') ? text : null;
  } catch {
    return null;
  }
}

mkdirSync(outDir, { recursive: true });

const catalogue = [];
const missing = [];

/** Fetched a few at a time: a hundred and fifty at once gets throttled, and
 *  one at a time takes a minute for no reason. */
async function inBatches(jobs, size, run) {
  for (let i = 0; i < jobs.length; i += size) {
    await Promise.all(jobs.slice(i, i + size).map(run));
  }
}

const jobs = [
  ...Object.entries(shapes).flatMap(([category, names]) =>
    names.map((name) => ({ category, name, url: `${TABLER}/${name}.svg`, brand: false })),
  ),
  ...Object.entries(brands).flatMap(([category, names]) =>
    names.map((name) => ({ category, name, url: `${SIMPLE}/${name}.svg`, brand: true })),
  ),
];

await inBatches(jobs, 12, async (job) => {
  const svg = await fetchIcon(job.url);
  if (!svg) {
    missing.push(job.name);
    return;
  }
  // A brand mark is a solid silhouette and arrives with no colour of its own;
  // leaving it to inherit means it takes the device colour like every other
  // glyph rather than rendering as an invisible black-on-black shape.
  const painted = job.brand
    ? svg.replace('<svg', '<svg fill="currentColor"')
    : svg;
  const file = `${slug(job.name)}.svg`;
  writeFileSync(join(outDir, file), painted);
  catalogue.push({ file, name: humanise(job.name), category: job.category });
});

catalogue.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ icons: catalogue }, null, 2)}\n`);
writeFileSync(
  join(outDir, 'LICENCES.txt'),
  [
    'Shapes in this folder come from two projects. Neither is part of Coreview;',
    'they are fetched into a folder you point the app at.',
    '',
    'Tabler Icons — MIT licence — https://github.com/tabler/tabler-icons',
    '  Everything except the "Vendors" groups.',
    '',
    'Simple Icons — CC0 1.0 — https://github.com/simple-icons/simple-icons',
    '  The "Vendors" groups. The icons are CC0; the logos they depict are',
    '  trademarks of their owners, and using one to label a device on your own',
    '  network diagram is what they are for. Do not use them to suggest that',
    '  those companies endorse anything.',
    '',
  ].join('\n'),
);

console.log(`${catalogue.length} shapes written to ${outDir}`);
if (missing.length) {
  console.log(`${missing.length} not found upstream and skipped: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}`);
}
console.log(`Point Coreview's icon library at ${outDir}.`);
