// Hash routing: the backend serves the UI as static files, so every route is `/ui/#/...`.

import { useEffect, useState } from 'react';

export const SCAN_TABS = ['overview', 'findings', 'logs'] as const;
export type ScanTab = (typeof SCAN_TABS)[number];

export type Route =
  | { page: 'scans' }
  | { page: 'new' }
  | { page: 'scan'; id: string; tab: ScanTab }
  | { page: 'docs' }
  | { page: 'providers' }
  | { page: 'models' }
  | { page: 'skills' }
  | { page: 'skill-packs' };

export function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const scan = path.match(/^scans\/([^/]+)(?:\/([a-z]+))?$/);
  if (scan) {
    const tab = SCAN_TABS.find((t) => t === scan[2]) ?? 'overview';
    return { page: 'scan', id: decodeURIComponent(scan[1]), tab };
  }
  if (path === 'new') return { page: 'new' };
  if (path === 'docs') return { page: 'docs' };
  if (path === 'admin/providers') return { page: 'providers' };
  if (path === 'admin/models') return { page: 'models' };
  if (path === 'admin/skills') return { page: 'skills' };
  if (path === 'admin/skill-packs') return { page: 'skill-packs' };
  return { page: 'scans' };
}

/** A Scan's page; its Overview tab unless `tab` says otherwise. */
export const scanRoute = (id: string, tab: ScanTab = 'overview'): Route => ({ page: 'scan', id, tab });

export function href(route: Route): string {
  switch (route.page) {
    case 'scans':
      return '#/scans';
    case 'new':
      return '#/new';
    case 'docs':
      return '#/docs';
    case 'providers':
      return '#/admin/providers';
    case 'models':
      return '#/admin/models';
    case 'skills':
      return '#/admin/skills';
    case 'skill-packs':
      return '#/admin/skill-packs';
    case 'scan':
      return `#/scans/${encodeURIComponent(route.id)}${route.tab === 'overview' ? '' : `/${route.tab}`}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
