import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../Leak.js';

test('VERSION const matches package.json version', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
  );
  assert.equal(VERSION, pkg.version);
});

test('VERSION is semver-shaped', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
});
