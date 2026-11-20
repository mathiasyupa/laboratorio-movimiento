export type RunEntry = {
  id: string;
  savedAt: string;
  video: string;
  thetaDeg: number;
  method: string;
  a: number;
  uA: number;
  aTheory: number;
  uTheory: number;
  diffPct: number | null;
  sigmas: number | null;
  mu: number;
  uMu: number;
  r2: number;
  frames: number;
  msPerFrame: number | null;
  manualRmseMm: number | null;
  manualRmseNoOffsetMm: number | null;
};

const STORAGE_KEY = "lab-movimiento-corridas";
const NO_RUNS: RunEntry[] = [];
const listeners = new Set<() => void>();
let cache: RunEntry[] | null = null;

function readStored(): RunEntry[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored : NO_RUNS;
  } catch {
    return NO_RUNS;
  }
}

export function getRuns() {
  cache ??= readStored();
  return cache;
}

export function getServerRuns() {
  return NO_RUNS;
}

export function subscribeRuns(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setRuns(entries: RunEntry[]) {
  cache = entries;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Sin almacenamiento (modo privado) las corridas siguen disponibles hasta cerrar la página.
  }
  listeners.forEach((listener) => listener());
}
