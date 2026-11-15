/* eslint-disable @typescript-eslint/no-require-imports -- preload runs before Next.js. */
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const output = process.env.STUDIO_LOAD_METRICS;
const ports = new Set((process.env.STUDIO_LOAD_ALLOWED_PORTS || '').split(',').map(Number));
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  if (!options || typeof options !== 'object') [options] = net._normalizeArgs(args);
  if (!options.path) {
    const host = String(options.host || 'localhost').replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !ports.has(Number(options.port))) {
      if (output) fs.appendFileSync(output, JSON.stringify({ event: 'blocked-network', host, port: options.port, at: Date.now() }) + '\n');
      throw Error('Isolated load acceptance blocked a connection outside its two loopback ports');
    }
  }
  return original.apply(this, args);
};
if (output) {
  const childProcess = require('node:child_process');
  const originalVersionSpawn = childProcess.spawnSync;
  childProcess.spawnSync = function (command, args, ...rest) {
    if (!Array.isArray(args) || args[0] !== '-version') return originalVersionSpawn.call(this, command, args, ...rest);
    const start = process.hrtime.bigint();
    try { return originalVersionSpawn.call(this, command, args, ...rest); }
    finally { fs.appendFileSync(output, JSON.stringify({ event: 'binary-version-check', at: Date.now(), binary: require('node:path').basename(String(command)), durationMs: Number(process.hrtime.bigint() - start) / 1e6 }) + '\n'); }
  };
  require('node:module').syncBuiltinESMExports();
}
if (output) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const media = globalThis[Symbol.for('creative-studio.media-resource-gate')];
    const preparation = globalThis[Symbol.for('creative-studio.verified-analysis-preparation')];
    const probes = globalThis[Symbol.for('creative-studio.verified-project-media-probes')];
    fs.appendFileSync(output, JSON.stringify({ at: Date.now(), pid: process.pid, preparationCache: preparation ? { entries: preparation.entries.size, estimatedImageBytes: preparation.bytes } : null, verifiedProbeEntries: probes?.size ?? 0, mediaResource: media ? { active: media.active, queue: media.queue.length } : null, memory: process.memoryUsage(), cpu: process.cpuUsage(), resource: process.resourceUsage(), eventLoopMs: { mean: histogram.mean / 1e6, p95: histogram.percentile(95) / 1e6, max: histogram.max / 1e6 } }) + '\n');
    histogram.reset();
  }, 1000);
  timer.unref();
}