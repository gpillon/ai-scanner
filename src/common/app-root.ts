import { resolve } from 'node:path';

/**
 * The directory holding `profiles/`, `containers/` and `ui/`: the repository, or `/app` in the
 * image. This file sits at the same depth in `src/` and in `dist/`, so the path holds for both.
 */
export const APP_ROOT = resolve(__dirname, '..', '..');
