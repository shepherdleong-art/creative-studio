/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');

const READY_PREFIX = '__CREATIVE_STUDIO_READY__';
const instanceId =
  process.env.CREATIVE_STUDIO_INSTANCE_ID || crypto.randomUUID();
const serverRoot =
  process.env.CREATIVE_STUDIO_SERVER_ROOT || path.resolve(__dirname, '..');
const standaloneServer =
  process.env.CREATIVE_STUDIO_STANDALONE_SERVER ||
  path.join(serverRoot, 'server.js');

if (!fs.existsSync(standaloneServer)) {
  throw new Error(`Missing standalone server entry: ${standaloneServer}`);
}

const startServerRequest = 'next/dist/server/lib/start-server';
const originalModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  const loaded = originalModuleLoad.call(this, request, parent, isMain);
  if (request !== startServerRequest) {
    return loaded;
  }
  return new Proxy(loaded, {
    get(target, property, receiver) {
      if (property === 'startServer') {
        const originalStartServer = Reflect.get(target, property, receiver);
        if (typeof originalStartServer !== 'function') {
          throw new Error('Next startServer module is unavailable');
        }
        return (options) =>
          originalStartServer({
            ...options,
            hostname: '127.0.0.1',
            port: 0,
          });
      }
      return Reflect.get(target, property, receiver);
    },
  });
};

const originalListen = http.Server.prototype.listen;
let readyReported = false;
http.Server.prototype.listen = function patchedListen(...args) {
  this.once('listening', () => {
    if (readyReported) {
      return;
    }
    const address = this.address();
    const port =
      address && typeof address === 'object' && 'port' in address
        ? address.port
        : null;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Unable to determine the standalone server port');
    }
    readyReported = true;
    process.stdout.write(
      `${READY_PREFIX} ${JSON.stringify({ port, instanceId })}\n`,
    );
    http.Server.prototype.listen = originalListen;
  });
  return originalListen.apply(this, args);
};

require(standaloneServer);
Module._load = originalModuleLoad;
