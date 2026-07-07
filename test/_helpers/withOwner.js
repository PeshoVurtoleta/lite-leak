/**
 * Test helper: run `fn` inside a lite-signal owner (effect body), returning
 * both fn's result and the effect's disposer. The effect body runs
 * synchronously once at creation; the returned disposer tears it down and
 * cascades onCleanup callbacks (including lite-leak's auto-untrack).
 */

import { effect, dispose as disposeEffect } from '@zakkster/lite-signal';

export function withOwner(fn) {
  let result;
  const e = effect(() => {
    result = fn();
  });
  return {
    result,
    dispose() { disposeEffect(e); },
  };
}
