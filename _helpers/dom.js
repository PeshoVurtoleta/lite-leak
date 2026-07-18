/**
 * Test-only DOM bootstrap for lite-leak's DOM-adjacent kernels
 * (listener-orphan, observer-orphan, detached-dom).
 *
 * Matches the pattern used by lite-signal-dom / lite-headless / lite-element:
 * install a jsdom window's globals so the same source that runs in a browser
 * runs unchanged under `node --test`. Import this FIRST in any test that
 * touches DOM APIs, before importing the kernel that patches those globals.
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://lite.test/',
});
const { window } = dom;

// Minimal global surface the kernels touch.
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.EventTarget = window.EventTarget;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.MutationObserver = window.MutationObserver;
// jsdom's ResizeObserver / IntersectionObserver are not implemented; stub
// them with minimal-but-real constructors so kernel patching has something
// to intercept.
if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class ResizeObserverStub {
    constructor(cb) { this.cb = cb; this._connected = false; }
    observe() { this._connected = true; }
    unobserve() {}
    disconnect() { this._connected = false; }
    /** Test-only: trigger a manual notification with hand-crafted entries. */
    _fire(entries) { if (this._connected) this.cb(entries, this); }
  };
}
if (typeof window.IntersectionObserver !== 'function') {
  window.IntersectionObserver = class IntersectionObserverStub {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this._connected = false; }
    observe() { this._connected = true; }
    unobserve() {}
    disconnect() { this._connected = false; }
    takeRecords() { return []; }
    _fire(entries) { if (this._connected) this.cb(entries, this); }
  };
}
globalThis.ResizeObserver = window.ResizeObserver;
globalThis.IntersectionObserver = window.IntersectionObserver;

/**
 * Flush pending MutationObserver callbacks. jsdom delivers them on the
 * microtask queue; await two turns to catch cascades (a disposal that
 * triggers further removals).
 */
export async function flushObserver() {
  await Promise.resolve();
  await Promise.resolve();
}

export { window };
export const documentRef = window.document;
