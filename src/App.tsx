import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import { Canvas } from './components/Canvas';
import { Inspector } from './components/inspector/Inspector';
import { Palette } from './components/Palette';
import { ProjectScreen } from './components/ProjectScreen';
import { StatusPanel } from './components/StatusPanel';
import { TopBar } from './components/TopBar';
import { ipc, isDesktop } from './lib/ipc';
import { useStore } from './state/store';

export default function App() {
  const meta = useStore((s) => s.meta);
  const highContrast = useStore((s) => s.settings.highContrast);
  const applyEngineEvent = useStore((s) => s.applyEngineEvent);
  // Read above the early return: a hook after one is called conditionally,
  // which React rejects and which broke the move from the launcher into a
  // project entirely.
  const selection = useStore((s) => s.selectedNodeId ?? s.selectedEdgeId);

  // Engine events arrive on one channel for the life of the window.
  useEffect(() => {
    let un: (() => void) | undefined;
    void ipc.onEngineEvent(applyEngineEvent).then((f) => {
      un = f;
    });
    return () => un?.();
  }, [applyEngineEvent]);

  // Belt and braces alongside the Rust-side window close handler.
  useEffect(() => {
    const stop = () => {
      if (useStore.getState().session.state !== 'stopped') void ipc.stopValidation();
    };
    window.addEventListener('beforeunload', stop);
    return () => window.removeEventListener('beforeunload', stop);
  }, []);

  if (!meta) {
    return (
      <div className={`cv-app ${highContrast ? 'is-contrast' : ''}`}>
        {!isDesktop && (
          <div className="cv-browser-banner">
            Running in a browser. Projects are kept in browser storage and no probing is possible —
            start the desktop app with <code>npm run tauri dev</code> to run checks.
          </div>
        )}
        <ProjectScreen />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className={`cv-app cv-workspace ${highContrast ? 'is-contrast' : ''}`}>
        <TopBar onExit={() => undefined} />
        {/* The narrow layouts show the palette or the inspector, not both,
            and which one depends on whether there is something to inspect. */}
        <div className={`cv-main${selection ? ' has-selection' : ''}`}>
          <Palette />
          <Canvas />
          <Inspector />
        </div>
        <StatusPanel />
      </div>
    </ReactFlowProvider>
  );
}
