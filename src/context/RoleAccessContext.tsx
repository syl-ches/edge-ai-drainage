// Lightweight executive role-based views (Phase 9D). A presentation-layer switch for the pitch: it
// adapts what each municipal stakeholder sees; it is NOT an authentication or authorisation
// boundary (anyone can pick a role in the header, and the backend does not check roles).
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type Role = 'EXECUTIVE' | 'ENGINEER' | 'PUBLIC';

export const ROLES: { id: Role; label: string; hint: string }[] = [
  { id: 'EXECUTIVE', label: 'Mayor / Executive', hint: 'Decision banner, overflow countdown, PDF, citywide alert' },
  { id: 'ENGINEER', label: 'CDRRMO / Engineer', hint: 'Full operational access (default)' },
  { id: 'PUBLIC', label: 'Public Citizen (QR view)', hint: 'Read-only map, street advisory, safety guidance' },
];

export type Capability =
  | 'simulation' // storm-sim scrubbers, presets, live driver scenarios
  | 'hardware' // USB rig, aquarium sim, pitch studio, SD recovery, spoof test
  | 'cctv'
  | 'dispatch' // SMS / e-mail dispatch center, log dispatch
  | 'analytics' // command center, exports
  | 'rawTelemetry' // hex payload registers, serial monitors, Kalman variances
  | 'executiveBanner'
  | 'publicAdvisory'
  | 'report';

const MATRIX: Record<Role, Capability[]> = {
  ENGINEER: ['simulation', 'hardware', 'cctv', 'dispatch', 'analytics', 'rawTelemetry', 'report'],
  EXECUTIVE: ['cctv', 'dispatch', 'analytics', 'executiveBanner', 'report'],
  PUBLIC: ['publicAdvisory'],
};

export function can(role: Role, cap: Capability): boolean {
  return MATRIX[role].includes(cap);
}

/** Capabilities the role gains / loses when switching (for the role-change toast and tests). */
export function roleDiff(from: Role, to: Role): { gained: Capability[]; lost: Capability[] } {
  return { gained: MATRIX[to].filter((c) => !MATRIX[from].includes(c)), lost: MATRIX[from].filter((c) => !MATRIX[to].includes(c)) };
}

export function parseRole(v: string | null | undefined): Role {
  return v === 'EXECUTIVE' || v === 'PUBLIC' ? v : 'ENGINEER';
}

interface Ctx {
  role: Role;
  setRole(r: Role): void;
  can(cap: Capability): boolean;
}

const RoleContext = createContext<Ctx>({ role: 'ENGINEER', setRole: () => undefined, can: (c) => can('ENGINEER', c) });

export function RoleAccessProvider({ initial = 'ENGINEER', children }: { initial?: Role; children: ReactNode }) {
  const [role, setRole] = useState<Role>(initial);
  const value = useMemo<Ctx>(() => ({ role, setRole, can: (c) => can(role, c) }), [role]);
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): Ctx {
  return useContext(RoleContext);
}
