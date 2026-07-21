/**
 * Deterministic mock hosts for the resource kernels (worker-orphan,
 * audio-node, socket-orphan). Node has no Worker, WebAudio or WebSocket, and
 * patching a real global would leak claims into unrelated tests, so every host
 * is a fresh local object passed as `{ target }`.
 */

/**
 * Worker host. `Worker` records construction and termination so a test can
 * assert on lifecycle without a thread. `URL` is a local object-URL registry.
 */
export function makeWorkerHost() {
  const host = Object.create(null);
  const log = { constructed: 0, terminated: 0, minted: [], revoked: [] };

  host.Worker = class MockWorker {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.alive = true;
      log.constructed++;
    }
    terminate() { this.alive = false; log.terminated++; }
  };

  let seq = 0;
  host.URL = {
    createObjectURL(_blob) {
      const url = 'blob:mock/' + (++seq);
      log.minted.push(url);
      return url;
    },
    revokeObjectURL(url) { log.revoked.push(url); },
  };

  host._log = log;
  return host;
}

/**
 * WebAudio host. `AudioNode` tracks graph edges; `AudioScheduledSourceNode`
 * adds start/stop. `disconnect()` with no args severs everything, mirroring the
 * spec distinction the kernel depends on.
 */
export function makeAudioHost() {
  const log = { connects: 0, disconnects: 0, starts: 0, stops: 0 };

  class AudioNode {
    constructor() { this.outputs = []; this.playing = false; }
    connect(destination) { this.outputs.push(destination); log.connects++; return destination; }
    disconnect(destination) {
      log.disconnects++;
      if (destination === undefined) { this.outputs.length = 0; return; }
      const i = this.outputs.indexOf(destination);
      if (i >= 0) this.outputs.splice(i, 1);
    }
  }

  class AudioScheduledSourceNode extends AudioNode {
    start() { this.playing = true; log.starts++; }
    stop() { this.playing = false; log.stops++; }
  }

  const host = Object.create(null);
  host.AudioNode = AudioNode;
  host.AudioScheduledSourceNode = AudioScheduledSourceNode;
  host._log = log;
  /** A destination that is never itself tracked (stands in for ctx.destination). */
  host.destination = new AudioNode();
  host.makeGain = () => new AudioNode();
  host.makeSource = () => new AudioScheduledSourceNode();
  return host;
}

/**
 * Socket host. `readyState` follows the DOM constants so the kernel's
 * "peer already closed is not a leak" rule can be exercised.
 */
export function makeSocketHost() {
  const log = { opened: 0, closed: 0 };

  class MockSocket {
    constructor(url) { this.url = url; this.readyState = 1; log.opened++; }   // OPEN
    close() { this.readyState = 3; log.closed++; }                            // CLOSED
  }

  const host = Object.create(null);
  host.WebSocket = class WebSocket extends MockSocket {};
  host.EventSource = class EventSource extends MockSocket {};
  host._log = log;
  return host;
}
