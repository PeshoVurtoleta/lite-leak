#!/usr/bin/env node
/**
 * Local peer-matrix runner.
 *
 * Reads peers.json, and for every listed version: installs
 * @zakkster/lite-signal at that exact spec, runs the peer-assumptions
 * suite, and records pass/fail. Restores the original installed version on
 * exit. Mirrors what .github/workflows/peer-matrix.yml does in CI, for a
 * fast local sweep before publishing either package.
 *
 * Usage:
 *   node scripts/peer-matrix.mjs
 *   node scripts/peer-matrix.mjs 1.8.0 1.12.0-rc.1   # ad-hoc specs
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url);

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8' });
}

// Read the resolved package.json straight from node_modules. Robust even
// when a publish does not expose ./package.json via its exports map (several
// lite-signal prereleases do not).
function currentInstalledVersion() {
  try {
    const url = new URL('node_modules/@zakkster/lite-signal/package.json', ROOT);
    return JSON.parse(readFileSync(url, 'utf-8')).version;
  } catch (_e) {
    return null;
  }
}

function loadSpecs() {
  const cli = process.argv.slice(2);
  if (cli.length > 0) return cli.map((spec) => ({ role: 'cli', spec }));
  const cfg = JSON.parse(readFileSync(new URL('peers.json', ROOT), 'utf-8'));
  return cfg.versions;
}

const PKG = '@zakkster/lite-signal';
const specs = loadSpecs();
const original = currentInstalledVersion();
const results = [];

console.log('peer-matrix: ' + PKG + ' x ' + specs.length + ' version(s)\n');

for (const entry of specs) {
  const spec = entry.spec;
  const role = entry.role || '';
  process.stdout.write('  ' + (role ? '[' + role + '] ' : '') + PKG + '@' + spec + ' ... ');
  try {
    sh('npm', ['install', PKG + '@' + spec, '--no-save', '--no-audit', '--no-fund', '--silent']);
  } catch (err) {
    console.log('INSTALL FAILED');
    results.push({ spec, role, ok: false, stage: 'install', detail: String(err.message || err).split('\n')[0] });
    continue;
  }
  const resolved = currentInstalledVersion();
  try {
    sh('node', ['--test', 'test/peer-assumptions.test.js']);
    console.log('ok (resolved ' + resolved + ')');
    results.push({ spec, role, ok: true, resolved });
  } catch (err) {
    console.log('FAIL (resolved ' + resolved + ')');
    const out = (err.stdout || '') + (err.stderr || '');
    results.push({ spec, role, ok: false, stage: 'test', resolved, detail: firstFailLine(out) });
  }
}

// Restore the original devDependency version so the workspace is left clean.
if (original) {
  try {
    sh('npm', ['install', PKG + '@' + original, '--no-save', '--no-audit', '--no-fund', '--silent']);
  } catch (_e) { /* best effort */ }
}

console.log('\n--- summary ---');
let failed = 0;
for (const r of results) {
  const tag = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) failed++;
  const extra = r.ok ? '' : ('  <- ' + (r.stage || '') + ': ' + (r.detail || ''));
  console.log('  ' + tag + '  ' + (r.role ? '[' + r.role + '] ' : '') + PKG + '@' + r.spec + extra);
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' peer(s) green');

function firstFailLine(out) {
  const lines = out.split('\n');
  for (const l of lines) {
    if (/not ok|AssertionError|Error:/.test(l)) return l.trim();
  }
  return '(see full output)';
}

process.exit(failed === 0 ? 0 : 1);
