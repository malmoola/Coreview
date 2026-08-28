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
      `${what} needs the LiveTopo desktop app. Run "npm run tauri dev" instead of opening the page in a browser.`,
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

const LS_KEY = 'livetopo.projects.v1';

function lsAll(): Record<string, ProjectPackage> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
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

export type IconLibEntry = { id: string; name: string; category: string; svg: string };
export type IconLibrary = { dir: string; icons: IconLibEntry[]; skipped: string[] };

export const ipc = {
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

  /** Subscribe to engine samples and transitions. */
  async onEngineEvent(handler: (payload: unknown) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const { listen } = await import('@tauri-apps/api/event');
    const un = await listen('livetopo://engine', (e) => handler(camel(e.payload)));
    return un;
  },
};
