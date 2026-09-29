// Exercise the actual component's hooks and event handlers with a deterministic
// commit cycle. Scroll geometry represents a 300-row sliding log window.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const slots = [];
let cursor = 0;
let dirty = true;
let effects = [];
let tree;
let writes = 0;
let top = 0;
const viewport = {
  scrollHeight: 6000, clientHeight: 400,
  get scrollTop() { return top; },
  set scrollTop(value) { top = Math.min(value, this.scrollHeight - this.clientHeight); writes++; },
};
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const react = {
  useState(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = initial;
    return [slots[i], value => {
      const next = typeof value === 'function' ? value(slots[i]) : value;
      if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
    }];
  },
  useRef(initial) {
    const i = cursor++;
    return slots[i] ??= { current: initial };
  },
  useCallback(fn, deps) {
    const i = cursor++;
    if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn };
    return slots[i].fn;
  },
  useEffect(fn, deps) {
    const i = cursor++;
    if (!same(slots[i]?.deps, deps)) {
      effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
    }
  },
};
react.useLayoutEffect = react.useEffect;
const jsx = (type, props) => ({ type, props });
const nodes = (node = tree) => !node || typeof node !== 'object' ? []
  : [node, ...[node.props?.children].flat(Infinity).filter(child => child != null).flatMap(child => nodes(child))];
const checkbox = () => nodes().find(n => n.type === 'input' && n.props.type === 'checkbox');
const scroller = () => nodes().find(n => n.props?.ref);
const logs = offset => Array.from({ length: 300 }, (_, i) => ({
  id: `log-${i + offset}`, jobId: null, level: i % 2 ? 'warn' : 'info',
  message: `entry ${i + offset}`, attempt: 0, createdAt: '2026-09-29T02:00:00',
}));
let response = logs(0);
const exports = {};
const source = ts.transpileModule(fs.readFileSync('components/LogViewer.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(source, {
  exports, require: name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === '@/components/ui/Icon') return { Icon: () => null };
    throw new Error(`Unexpected import: ${name}`);
  },
  fetch: async () => ({ json: async () => response }),
  URLSearchParams, console, setTimeout, clearTimeout, setInterval, clearInterval,
});
async function flush() {
  for (let i = 0; i < 10; i++) {
    if (dirty) {
      dirty = false; cursor = 0; effects = [];
      tree = exports.default({ projectId: 'fixture' });
      for (const n of nodes()) if (n.props?.ref) n.props.ref.current = viewport;
      effects.forEach(effect => effect());
    }
    await Promise.resolve();
  }
}
async function refresh(offset) {
  response = logs(offset);
  await nodes().find(n => n.type === 'button' && n.props.children === '刷新').props.onClick();
  await flush();
}
await flush();
assert.equal(top, 5600, '首次加载结束、列表挂载后应滚到底部');
viewport.scrollTop = viewport.scrollHeight;
const before = writes;
// Browser scroll anchoring moves the retained rows when the oldest rows drop out.
top -= 200;
await refresh(10);
assert.ok(writes > before, '300 条窗口更新后，条数不变也必须继续滚到底部');
assert.equal(top, 5600);
// A layout/anchor/horizontal-scroll event must not uncheck an explicit preference.
top -= 200;
scroller().props.onScroll?.({ currentTarget: viewport });
await flush();
assert.equal(checkbox().props.checked, true, '浏览器滚动事件不能自行关闭自动滚动');
checkbox().props.onChange({ target: { checked: false } });
await flush();
top = 1000;
await refresh(20);
assert.equal(top, 1000, '用户关闭自动滚动后应保留阅读位置');
checkbox().props.onChange({ target: { checked: true } });
await flush();
assert.equal(top, 5600, '重新勾选立即回到底部');
top -= 100;
await refresh(30);
assert.equal(top, 5600, '重新勾选后后续刷新也继续跟随');
const infoButton = nodes().find(n => n.type === 'button' && n.props.children?.[0] === 'INFO');
top = 0;
infoButton.props.onClick();
await flush();
assert.equal(top, 5600, '切换过滤后也跟随最新日志');
console.log('LogViewer sliding-window and explicit auto-scroll tests passed');
