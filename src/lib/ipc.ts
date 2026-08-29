/**
 * The only place the frontend talks to Rust.
 *
 * When the bundle is loaded in a plain browser (`npm run dev` without Tauri)
 * there is no backend, so project storage falls back to localStorage and any
 * probe call fails loudly. Nothing is simulated: a browser session cannot
 * produce probe results, and the UI says so.
 */
import type {
  EventRow,
  Probe,
  ProbeRuntime,
  ProjectMeta,
  SessionState,
} from '../types/domain';

export const isDesktop =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export class BackendUnavailable extends Error {
  constructor(what: string) {
    super(
      `${what} needs the Coreview desktop app. Run "npm run tauri dev" instead of opening the page in a browser.`,
    );
    this.name = 'BackendUnavailable';
  }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = await import('@tauri-apps/api/core');
  return api.invoke<T>(cmd, args);
}

export interface ProjectPackage {
  meta: ProjectMeta;
  documentVersion: number;
  document: unknown;
}

export interface ProbeResultDto {
  probeId: string;
  timestampMs: number;
  outcome:
    | 'success'
    | 'timeout'
    | 'unreachable'
    | 'refused'
    | 'dns_failure'
    | 'no_answer'
    | 'os_error'
    | 'invalid_target';
  rttMs: number | null;
  resolved: string[];
  summary: string;
  errorMessage: string | null;
}

export interface SessionInfo {
  sessionId: string | null;
  projectId: string | null;
  state: SessionState;
  probeCount: number;
}

const LS_KEY = 'coreview.projects.v1';
/** Browser-mode storage was under this name until the 0.2.0 rename. */
const LS_KEY_LEGACY = 'livetopo.projects.v1';

function lsAll(): Record<string, ProjectPackage> {
  try {
    const current = localStorage.getItem(LS_KEY);
    if (current !== null) return JSON.parse(current);
    // Nothing under the new name: adopt anything left under the old one, so a
    // rename does not read as every project having disappeared.
    const legacy = localStorage.getItem(LS_KEY_LEGACY);
    if (legacy === null) return {};
    localStorage.setItem(LS_KEY, legacy);
    return JSON.parse(legacy);
  } catch {
    return {};
  }
}

function lsWrite(all: Record<string, ProjectPackage>) {
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

/** Rust returns snake_case; the UI uses camelCase. */
function camel<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => camel(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = camel(v);
    }
    return out as T;
  }
  return value as T;
}

function snake(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snake);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = snake(v);
    }
    return out;
  }
  return value;
}

export type SubnetInfo = { network: string; broadcast: string; prefix: number; hosts: number };
export type SweepOptions = { timeoutMs: number; concurrency: number };
export type SweepHit = { ip: string; rttMs: number | null };
/** Mirrors the Rust SweepEvent enum, which is tagged with `kind`. */
export type SweepEvent =
  | { kind: 'started'; total: number }
  | { kind: 'alive'; ip: string; rttMs: number | null }
  | { kind: 'progress'; done: number; total: number }
  | { kind: 'finished'; alive: number; scanned: number; cancelled: boolean };

/** Sent for one run and never stored. The backend has no way to give these
 *  back — nothing reads a password out of Coreview once it is in. */
export type CredentialInput = {
  username: string;
  password: string;
  enablePassword?: string;
};

export type DeviceClassName =
  | 'router' | 'switch' | 'firewall' | 'wireless-controller' | 'access-point'
  | 'phone' | 'camera' | 'printer' | 'server' | 'endpoint' | 'unknown';

export type DeviceAddress = { ip: string; interface: string | null; isManagement: boolean };

export type Neighbor = {
  deviceId: string;
  shortName: string;
  addresses: DeviceAddress[];
  localInterface: string | null;
  remoteInterface: string | null;
  platform: string | null;
  capabilities: string[];
  version: string | null;
  class: DeviceClassName;
  discoveredBy: 'cdp' | 'lldp';
};

export type CrawledDevice = {
  hostname: string;
  address: string;
  addresses: DeviceAddress[];
  probeTarget: string;
  class: DeviceClassName;
  platform: string | null;
  version: string | null;
  neighbors: Neighbor[];
  hops: number;
  /** How the device answered. SSH gives neighbours and interfaces; SNMP gives
   *  a name and nothing about what it connects to. */
  reachedBy: 'ssh' | 'snmp';
};

/** Optional, and only used for devices that refuse SSH. */
export type SnmpInput = {
  version: 'v2c' | 'v3';
  community?: string;
  username?: string;
  /** The word a device configuration uses: "sha", "md5", "sha256". */
  authProtocol?: string;
  authPassword?: string;
  /** "aes 256", "aes", "des"; omit for authentication without privacy. */
  privacy?: string;
  privacyPassword?: string;
};

export type CrawlInput = {
  seed: string;
  subnets: string[];
  crawlClasses: DeviceClassName[];
  maxHops: number;
  maxDevices: number;
  secondFactor: boolean;
  addressPreference: 'loopback' | 'management' | 'first' | 'interface';
  interfaceName?: string;
  port: number;
  snmp?: SnmpInput;
  /** A saved credential to use instead of typed ones. Only the id travels. */
  credentialId?: string;
  snmpCredentialId?: string;
};

export type SshProgress =
  | { kind: 'connecting'; host: string }
  | { kind: 'checkingHostKey'; host: string }
  | { kind: 'authenticating'; host: string }
  | { kind: 'awaitingSecondFactor'; host: string; message: string }
  | { kind: 'ready'; host: string; hostname: string }
  | { kind: 'running'; host: string; command: string };

export type CrawlEvent =
  | { kind: 'started'; seed: string }
  | ({ kind: 'ssh' } & { [k: string]: unknown })
  | { kind: 'reached'; hostname: string; address: string; probeTarget: string; class: DeviceClassName; platform: string | null; hops: number }
  | { kind: 'skipped'; name: string; reason: string }
  | { kind: 'failed'; address: string; reason: string }
  | { kind: 'finished'; reached: number; failed: number; cancelled: boolean };

export type CrawlResult = {
  devices: CrawledDevice[];
  notVisited: Neighbor[];
  failures: { address: string; reason: string }[];
  cancelled: boolean;
};

export type BackupTarget = { address: string; name: string };

export type BackupEvent =
  | { kind: 'started'; devices: number }
  | ({ kind: 'ssh' } & { [k: string]: unknown })
  | { kind: 'saved'; name: string; address: string; path: string; bytes: number; unchanged: boolean }
  | { kind: 'failed'; name: string; address: string; reason: string }
  | { kind: 'finished'; saved: number; failed: number; cancelled: boolean };

export type HostKeyRow = { host: string; fingerprint: string };

export type VaultStatus = {
  exists: boolean;
  unlocked: boolean;
  credentials: number;
  minimumPassphrase: number;
};

export type CredentialSummary = {
  id: string;
  label: string;
  kind: string;
  username: string;
  detail: string;
  hasSecondSecret: boolean;
};

/** Only ever returned by revealCredential, which is the one call that hands
 *  back a stored secret. */
export type RevealedCredential = {
  username: string;
  secret: string;
  secondSecret: string | null;
};

export type BackupDevice = { name: string; captures: number; latest: string | null };
/** Mirrors the Rust DiffLine, which is tagged with `kind`. */
export type DiffLine =
  | { kind: 'same'; value: string }
  | { kind: 'added'; value: string }
  | { kind: 'removed'; value: string };

export type IconLibEntry = { id: string; name: string; category: string; svg: string };
export type IconLibrary = { dir: string; icons: IconLibEntry[]; skipped: string[] };

/** Preferences that outlive a restart. Paths only — nothing secret. */
export type StoredSettings = Partial<{
  backupFolder: string;
  exportFolder: string;
  iconLibraryDir: string;
  addressPreference: string;
}>;

export const ipc = {
  /** Every stored preference. Browser mode has no backend, so none. */
  async getSettings(): Promise<StoredSettings> {
    if (!isDesktop) return {};
    return invoke<StoredSettings>('get_settings');
  },

  /** Stores a preference, or clears it when value is null. */
  async setSetting(key: keyof StoredSettings, value: string | null): Promise<void> {
    if (!isDesktop) return;
    await invoke('set_setting', { key, value });
  },

  /** Picking a folder is not the same as being able to write into it: a
   *  read-only mount picks cleanly and fails at the first backup. */
  async checkFolderWritable(path: string): Promise<void> {
    if (!isDesktop) return;
    await invoke('check_folder_writable', { path });
  },

  /** Native folder picker. Returns null if the user cancelled. */
  async pickFolder(title: string, defaultPath?: string): Promise<string | null> {
    if (!isDesktop) throw new BackendUnavailable('Choosing a folder');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false, title, defaultPath });
    return typeof picked === 'string' ? picked : null;
  },

  /** Index a user-chosen folder of SVGs. Desktop only. */
  listIconLibrary(dir: string) {
    return invoke<IconLibrary>('list_icon_library', { dir });
  },

  async listProjects(): Promise<ProjectMeta[]> {
    if (!isDesktop) {
      return Object.values(lsAll())
        .map((p) => p.meta)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return camel<ProjectMeta[]>(await invoke('list_projects'));
  },

  async saveProject(pkg: ProjectPackage): Promise<void> {
    if (!isDesktop) {
      const all = lsAll();
      all[pkg.meta.id] = pkg;
      lsWrite(all);
      return;
    }
    await invoke('save_project', { package: snake(pkg) });
  },

  async loadProject(id: string): Promise<ProjectPackage | null> {
    if (!isDesktop) return lsAll()[id] ?? null;
    return camel<ProjectPackage | null>(await invoke('load_project', { id }));
  },

  async deleteProject(id: string): Promise<void> {
    if (!isDesktop) {
      const all = lsAll();
      delete all[id];
      lsWrite(all);
      return;
    }
    await invoke('delete_project', { id });
  },

  async setArchived(id: string, archived: boolean): Promise<void> {
    if (!isDesktop) {
      const all = lsAll();
      const p = all[id];
      if (p) {
        p.meta.archived = archived;
        lsWrite(all);
      }
      return;
    }
    await invoke('set_project_archived', { id, archived });
  },

  async testProbeNow(probe: Probe): Promise<ProbeResultDto> {
    if (!isDesktop) throw new BackendUnavailable('Testing a target');
    return camel<ProbeResultDto>(await invoke('test_probe_now', { config: snake(probe) }));
  },

  async validateTarget(target: string): Promise<string> {
    if (!isDesktop) throw new BackendUnavailable('Target validation');
    return invoke<string>('validate_target', { target });
  },

  async startValidation(
    projectId: string,
    operator: string,
    probes: Probe[],
  ): Promise<SessionInfo> {
    if (!isDesktop) throw new BackendUnavailable('Starting validation');
    return camel<SessionInfo>(
      await invoke('start_validation', { projectId, operator, probes: snake(probes) }),
    );
  },

  async stopValidation(): Promise<SessionInfo> {
    if (!isDesktop) return { sessionId: null, projectId: null, state: 'stopped', probeCount: 0 };
    return camel<SessionInfo>(await invoke('stop_validation'));
  },

  async sessionStatus(): Promise<SessionInfo> {
    if (!isDesktop) return { sessionId: null, projectId: null, state: 'stopped', probeCount: 0 };
    return camel<SessionInfo>(await invoke('session_status'));
  },

  async probeSnapshot(): Promise<ProbeRuntime[]> {
    if (!isDesktop) return [];
    return camel<ProbeRuntime[]>(await invoke('probe_snapshot'));
  },

  async listEvents(projectId: string, limit = 2000): Promise<EventRow[]> {
    if (!isDesktop) return [];
    return camel<EventRow[]>(await invoke('list_events', { projectId, limit }));
  },

  async recordEvent(event: EventRow): Promise<void> {
    if (!isDesktop) return;
    await invoke('record_event', { event: snake(event) });
  },

  async appInfo(): Promise<{ version: string; dataDir: string; documentVersion: number }> {
    if (!isDesktop) {
      return { version: 'dev (browser)', dataDir: 'browser localStorage', documentVersion: 1 };
    }
    return camel(await invoke('app_info'));
  },

  /** Validate a subnet and say how big it is, without starting anything. */
  describeSubnet(subnet: string) {
    return invoke<SubnetInfo>('describe_subnet', { subnet });
  },

  /** Begin a ping sweep. Resolves with the number of addresses to be tried;
   *  results arrive on the sweep event. */
  startSweep(subnets: string[], options: SweepOptions) {
    return invoke<number>('start_sweep', { subnets, options });
  },

  /** Stop the running sweep. Safe to call when none is running. */
  cancelSweep() {
    return invoke<void>('cancel_sweep');
  },

  /** Subscribe to sweep progress and hits. */
  async onSweepEvent(handler: (e: SweepEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://sweep', (e) => handler(e.payload as SweepEvent));
  },

  /** Walk the network from a seed address. Credentials are used for this run
   *  and never stored. */
  startCrawl(input: CrawlInput, credentials: CredentialInput) {
    return invoke<void>('start_crawl', { input, credentials });
  },
  cancelCrawl() {
    return invoke<void>('cancel_crawl');
  },
  async onCrawlEvent(handler: (e: CrawlEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://crawl', (e) => handler(e.payload as CrawlEvent));
  },
  async onCrawlResult(handler: (r: CrawlResult) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://crawl-result', (e) => handler(e.payload as CrawlResult));
  },

  /** Capture configurations into the chosen backup folder. */
  startBackup(
    input: {
      targets: BackupTarget[];
      kinds: ('running' | 'startup')[];
      secondFactor: boolean;
      port: number;
      credentialId?: string;
    },
    credentials: CredentialInput,
    stamp: string,
  ) {
    return invoke<void>('start_backup', { input, credentials, stamp });
  },
  cancelBackup() {
    return invoke<void>('cancel_backup');
  },
  async onBackupEvent(handler: (e: BackupEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    return listen('coreview://backup', (e) => handler(e.payload as BackupEvent));
  },

  /** The credential vault. Every call here takes secrets in; only
   *  revealCredential returns one, and only while unlocked. */
  vaultStatus() {
    return isDesktop
      ? invoke<VaultStatus>('vault_status')
      : Promise.resolve({ exists: false, unlocked: false, credentials: 0, minimumPassphrase: 12 });
  },
  createVault(passphrase: string) {
    return invoke<void>('create_vault', { passphrase });
  },
  unlockVault(passphrase: string) {
    return invoke<void>('unlock_vault', { passphrase });
  },
  lockVault() {
    return invoke<void>('lock_vault');
  },
  discardVault() {
    return invoke<number>('discard_vault');
  },
  saveCredential(credential: {
    id?: string;
    label: string;
    kind: string;
    username: string;
    secret: string;
    secondSecret?: string;
    detail?: string;
  }) {
    return invoke<string>('save_credential', { credential });
  },
  listCredentials() {
    return isDesktop ? invoke<CredentialSummary[]>('list_credentials') : Promise.resolve([]);
  },
  revealCredential(id: string) {
    return invoke<RevealedCredential>('reveal_credential', { id });
  },
  /** The vault as ciphertext, for moving it to another machine. Opening it
   *  elsewhere still needs the passphrase. */
  exportVault() {
    return invoke<unknown>('export_vault');
  },
  deleteCredential(id: string) {
    return invoke<void>('delete_credential', { id });
  },

  /** Devices with backups on disk. */
  listBackupDevices() {
    return isDesktop ? invoke<BackupDevice[]>('list_backup_devices') : Promise.resolve([]);
  },
  listDeviceCaptures(device: string) {
    return invoke<string[]>('list_device_captures', { device });
  },
  readCapture(device: string, filename: string) {
    return invoke<string>('read_capture', { device, filename });
  },
  diffCaptures(device: string, before: string, after: string) {
    return invoke<DiffLine[]>('diff_captures', { device, before, after });
  },

  /** Remembered SSH host keys, and the ways to forget them. */
  listHostKeys() {
    return isDesktop ? invoke<HostKeyRow[]>('list_host_keys') : Promise.resolve([]);
  },
  clearHostKeys() {
    return invoke<number>('clear_host_keys');
  },
  forgetHostKey(host: string, port: number) {
    return invoke<boolean>('forget_host_key', { host, port });
  },

  /** Subscribe to engine samples and transitions. */
  async onEngineEvent(handler: (payload: unknown) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    const un = await listen('coreview://engine', (e) => handler(camel(e.payload)));
    return un;
  },
};
