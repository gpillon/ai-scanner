// The server has no endpoint listing Scans: a Scan id is the only thing keeping one caller's
// Report from another holder of the token (ADR-0002). This browser remembers the ids it used.

import { useCallback, useEffect, useState } from 'react';

export interface KnownScan {
  id: string;
  /** When this browser submitted or opened it. */
  addedAt: string;
}

const HISTORY_KEY = 'ai-scanner.scans';
const CHANGED = 'ai-scanner.scans-changed';

function read(): KnownScan[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s?.id === 'string') : [];
  } catch {
    return [];
  }
}

function write(scans: KnownScan[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(scans));
  } catch {
    // Storage unavailable: the history lasts until reload.
  }
  window.dispatchEvent(new Event(CHANGED));
}

export const history = {
  list: read,
  remember(id: string): void {
    if (read().some((s) => s.id === id)) return;
    write([{ id, addedAt: new Date().toISOString() }, ...read()]);
  },
  forget(id: string): void {
    write(read().filter((s) => s.id !== id));
  },
};

/** The remembered Scans, kept in sync across components and tabs. */
export function useHistory(): KnownScan[] {
  const [scans, setScans] = useState(read);
  const refresh = useCallback(() => setScans(read()), []);
  useEffect(() => {
    window.addEventListener(CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [refresh]);
  return scans;
}
