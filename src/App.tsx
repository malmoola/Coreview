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
      <div className={`lt-app ${highContrast ? 'is-contrast' : ''}`}>
        {!isDesktop && (
          <div className="lt-browser-banner">
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
      <div className={`lt-app lt-workspace ${highContrast ? 'is-contrast' : ''}`}>
        <TopBar onExit={() => undefined} />
        <div className="lt-main">
          <Palette />
          <Canvas />
          <Inspector />
        </div>
        <StatusPanel />
      </div>
    </ReactFlowProvider>
  );
}
