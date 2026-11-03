/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`server 模式必须显式配置 ${name}`);
  return value;
}

if (required('CREATIVE_STUDIO_DEPLOYMENT_MODE') !== 'server') {
  throw new Error('团队服务入口要求 CREATIVE_STUDIO_DEPLOYMENT_MODE=server');
}
const dataRoot = path.resolve(required('CREATIVE_STUDIO_DATA_ROOT'));
const portText = required('CREATIVE_STUDIO_PORT');
const port = Number(portText);
if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('CREATIVE_STUDIO_PORT 必须是 1–65535 的固定端口');
}
required('CREATIVE_STUDIO_DEPLOYMENT_ID');
const origin = new URL(required('CREATIVE_STUDIO_TRUSTED_ORIGIN'));
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
  throw new Error('CREATIVE_STUDIO_TRUSTED_ORIGIN 必须是有效的 HTTP(S) origin');
}

process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.HOSTNAME = '127.0.0.1';
process.env.PORT = String(port);

const runtimeStateKey = Symbol.for('creative-studio.team-runtime-state');
const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function patchedListen(...args) {
  const requestListeners = this.listeners('request');
  this.removeAllListeners('request');
  for (const listener of requestListeners) {
    this.on('request', (request, response) => {
      const pathname = request.url?.split('?', 1)[0]?.replace(/\/$/, '') || '/';
      const runtimeState = globalThis[runtimeStateKey]?.value;
      const infrastructure = pathname === '/api/team/health/live' || pathname === '/api/team/health/ready'
        || pathname === '/api/team/operations/status' || pathname === '/api/team/operations/shutdown';
      if (infrastructure || (runtimeState?.ready === true && runtimeState.maintenance === false)) {
        listener.call(this, request, response);
        return;
      }
      response.writeHead(503, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ ready: false, maintenance: true }));
    });
  }
  http.Server.prototype.listen = originalListen;
  return originalListen.apply(this, args);
};

const serverRoot = process.env.CREATIVE_STUDIO_SERVER_ROOT || path.resolve(__dirname, '..');
const standaloneServer = process.env.CREATIVE_STUDIO_STANDALONE_SERVER || path.join(serverRoot, 'server.js');
if (!fs.existsSync(standaloneServer)) {
  throw new Error(`Missing standalone server entry: ${standaloneServer}`);
}

const startServerRequest = 'next/dist/server/lib/start-server';
const originalModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = originalModuleLoad.call(this, request, parent, isMain);
  if (request !== startServerRequest) return loaded;
  return new Proxy(loaded, {
    get(target, property, receiver) {
      if (property !== 'startServer') return Reflect.get(target, property, receiver);
      const originalStartServer = Reflect.get(target, property, receiver);
      if (typeof originalStartServer !== 'function') {
        throw new Error('Next startServer module is unavailable');
      }
      return (options) => originalStartServer({
        ...options,
        hostname: '127.0.0.1',
        port,
      });
    },
  });
};

try {
  require(standaloneServer);
} finally {
  Module._load = originalModuleLoad;
}
