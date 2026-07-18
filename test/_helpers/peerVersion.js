/**
 * Resolve the version of the currently-installed @zakkster/lite-signal.
 *
 * lite-signal does not export a VERSION constant, so the peer-assumptions
 * suite reads it from the resolved package.json. This lets a report state
 * exactly which peer it validated against -- the whole point of the matrix.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function installedSignalVersion() {
  try {
    const pkgPath = require.resolve('@zakkster/lite-signal/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '(unknown)';
  } catch (_e) {
    // Some publishes do not expose package.json via exports; fall back to a
    // best-effort walk of node_modules from this file.
    try {
      const url = new URL(
        '../../node_modules/@zakkster/lite-signal/package.json',
        import.meta.url
      );
      const pkg = JSON.parse(readFileSync(url, 'utf-8'));
      return typeof pkg.version === 'string' ? pkg.version : '(unknown)';
    } catch (_e2) {
      return '(unknown)';
    }
  }
}
