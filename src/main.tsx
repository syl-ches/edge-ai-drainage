import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';
import { isHardwareSimRoute, isPitchStudioRoute } from './main.route';

// Three pages from one bundle: the 3D map, the Phase 7B Arduino / aquarium companion site
// (/?view=hardware-sim or /hardware-sim) and the Ultra-HD Pitch Studio (/?view=pitch-studio).
// Each is code-split so the companion never loads MapLibre / Three.js and the studio never
// loads MapLibre.
const App = lazy(() => import('./App'));
const HardwareAquariumSimulator = lazy(() => import('./components/HardwareAquariumSimulator'));
const UltraHdPitchStudio = lazy(() => import('./components/UltraHdPitchStudio'));

const Page = isPitchStudioRoute(window.location) ? UltraHdPitchStudio : isHardwareSimRoute(window.location) ? HardwareAquariumSimulator : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="flex h-full items-center justify-center text-sm font-semibold text-slate-400">Loading…</div>}>
      <Page />
    </Suspense>
  </StrictMode>,
);

// Offline-capable PWA in production builds only (dev keeps hot reload uncached).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
