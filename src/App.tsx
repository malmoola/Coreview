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
  const ground = useStore((s) => s.settings.ground);
  const applyEngineEvent = useStore((s) => s.applyEngineEvent);
  // Read above the early return: a hook after one is called conditionally,
  // which React rejects and which broke the move from the launcher into a
  // project entirely.
  const selection = useStore((s) => s.selectedNodeId ?? s.selectedEdgeId);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);

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
      <div className={`cv-app ${highContrast ? 'is-contrast' : ''} ${ground === 'light' ? 'is-light' : ''}`}>
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
      <div className={`cv-app cv-workspace ${highContrast ? 'is-contrast' : ''} ${ground === 'light' ? 'is-light' : ''}`}>
        <TopBar onExit={() => undefined} />
        {/* The narrow layouts show the palette or the inspector, not both,
            and which one depends on whether there is something to inspect. */}
        <div
          className={[
            'cv-main',
            selection ? 'has-selection' : '',
            paletteOpen ? '' : 'palette-hidden',
            inspectorOpen ? '' : 'inspector-hidden',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {/* Both stay mounted and are hidden in CSS. Unmounting one leaves
              two children in a three-track grid, and the canvas slides into
              the collapsed track — which is how the inspector ended up
              occupying the middle of the window. */}
          <Palette />
          <Canvas />
          <Inspector />

          {/* Slim rails, so the way back is always visible. A panel that
              hides with no handle left behind reads as something broken. */}
          <button
            type="button"
            className="cv-rail cv-rail-left"
            onClick={() => setPaletteOpen(!paletteOpen)}
            title={paletteOpen ? 'Hide the shapes panel' : 'Show the shapes panel'}
            aria-label={paletteOpen ? 'Hide the shapes panel' : 'Show the shapes panel'}
            aria-expanded={paletteOpen}
          >
            {paletteOpen ? '‹' : '›'}
          </button>
          <button
            type="button"
            className="cv-rail cv-rail-right"
            onClick={() => setInspectorOpen(!inspectorOpen)}
            title={inspectorOpen ? 'Hide the details panel' : 'Show the details panel'}
            aria-label={inspectorOpen ? 'Hide the details panel' : 'Show the details panel'}
            aria-expanded={inspectorOpen}
          >
            {inspectorOpen ? '›' : '‹'}
          </button>
        </div>
        <StatusPanel />
      </div>
    </ReactFlowProvider>
  );
}
