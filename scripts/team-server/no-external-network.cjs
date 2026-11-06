/* eslint-disable @typescript-eslint/no-require-imports -- NODE_OPTIONS --require 需要 CJS 同步安装网络守卫。 */
'use strict';

const net = require('node:net');

function allowedHost(host) {
  const value = String(host || 'localhost').replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.endsWith('.localhost');
}

function assertAllowed(args) {
  const options = args[0];
  if (typeof options === 'string') return;
  const normalized = options && typeof options === 'object'
    ? options
    : { host: args[1] };
  if (normalized.path) return;
  if (!allowedHost(normalized.host)) {
    throw new Error(`acceptance L1 禁止外网连接：${normalized.host}`);
  }
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function acceptanceNetworkGuard(...args) {
  assertAllowed(args);
  return originalConnect.apply(this, args);
};
for (const method of ['connect', 'createConnection']) {
  const original = net[method];
  net[method] = function acceptanceNetworkFactoryGuard(...args) {
    assertAllowed(args);
    return original.apply(this, args);
  };
}
