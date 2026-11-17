/* eslint-disable @typescript-eslint/no-require-imports -- Node preload for isolated production acceptance. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');
const source = path.resolve(process.env.STICKER_TEST_SOURCE_ROOT).toLowerCase();
const allowed = [process.env.STICKER_TEST_STANDALONE, process.env.CREATIVE_STUDIO_DATA_ROOT].map(value => path.resolve(value).toLowerCase());
const within = (file, root) => file === root || file.startsWith(root + path.sep);
function check(file) {
  if (typeof file === 'number') return;
  if (file instanceof URL) file = fileURLToPath(file);
  if (typeof file !== 'string' && !Buffer.isBuffer(file)) return;
  const resolved = path.resolve(String(file)).toLowerCase();
  if (within(resolved, source) && !allowed.some(root => within(resolved, root))) {
    const error = new Error('Production acceptance forbids source fallback: ' + resolved);
    error.code = 'ENOENT';
    throw error;
  }
}
for (const name of ['readFileSync', 'readdirSync', 'openSync', 'statSync', 'lstatSync', 'realpathSync', 'accessSync', 'copyFileSync', 'cpSync']) {
  const original = fs[name];
  const wrapped = function(file, ...args) { check(file); return original.call(this, file, ...args); };
  if (original.native) wrapped.native = function(file, ...args) { check(file); return original.native.call(this, file, ...args); };
  fs[name] = wrapped;
}
const exists = fs.existsSync;
fs.existsSync = file => { try { check(file); return exists(file); } catch { return false; } };
for (const name of ['readFile', 'readdir', 'open', 'stat', 'lstat', 'realpath', 'access', 'copyFile', 'cp']) {
  const callbackOriginal = fs[name];
  fs[name] = function(file, ...args) {
    try { check(file); }
    catch (error) {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw error;
      process.nextTick(callback, error);
      return;
    }
    return callbackOriginal.call(this, file, ...args);
  };
  const original = fs.promises[name];
  fs.promises[name] = async function(file, ...args) { check(file); return original.call(this, file, ...args); };
}
const stream = fs.createReadStream;
fs.createReadStream = function(file, ...args) { check(file); return stream.call(this, file, ...args); };
const existsCallback = fs.exists;
fs.exists = (file, callback) => {
  try { check(file); return existsCallback(file, callback); }
  catch { process.nextTick(callback, false); }
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function(...args) {
  const result = resolve.apply(this, args);
  if (path.isAbsolute(result)) check(result);
  return result;
};
// Verify the guard itself is active in every inherited Node subprocess.
try { fs.readFileSync(path.join(source, 'package.json')); throw new Error('source guard inactive'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
