// Hash routing: the backend serves the UI as static files, so every route is `/ui/#/...`.

import { useEffect, useState } from 'react';

export type Route = { page: 'scans' } | { page: 'new' } | { page: 'scan'; id: string } | { page: 'docs' };

export function parse(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const scan = path.match(/^scans\/([^/]+)$/);
  if (scan) return { page: 'scan', id: decodeURIComponent(scan[1]) };
  if (path === 'new') return { page: 'new' };
  if (path === 'docs') return { page: 'docs' };
  return { page: 'scans' };
}

export function href(route: Route): string {
  switch (route.page) {
    case 'scans':
      return '#/scans';
    case 'new':
      return '#/new';
    case 'docs':
      return '#/docs';
    case 'scan':
      return `#/scans/${encodeURIComponent(route.id)}`;
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
