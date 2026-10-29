/** The Phase 7B companion page lives at /?view=hardware-sim (any host) or /hardware-sim (SPA fallback). */
export function isHardwareSimRoute(loc: Pick<Location, 'search' | 'pathname'>): boolean {
  return new URLSearchParams(loc.search).get('view') === 'hardware-sim' || /\/hardware-sim\/?$/.test(loc.pathname);
}

/** The Ultra-HD Pitch Studio lives at /?view=pitch-studio (any host) or /pitch-studio (SPA fallback). */
export function isPitchStudioRoute(loc: Pick<Location, 'search' | 'pathname'>): boolean {
  return new URLSearchParams(loc.search).get('view') === 'pitch-studio' || /\/pitch-studio\/?$/.test(loc.pathname);
}
