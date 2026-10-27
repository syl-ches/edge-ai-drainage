/** The Phase 7B companion page lives at /?view=hardware-sim (any host) or /hardware-sim (SPA fallback). */
export function isHardwareSimRoute(loc: Pick<Location, 'search' | 'pathname'>): boolean {
  return new URLSearchParams(loc.search).get('view') === 'hardware-sim' || /\/hardware-sim\/?$/.test(loc.pathname);
}
