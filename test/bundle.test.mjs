// bundle 集成测试：不打开浏览器，直接把 lib/client.js 当作宿主会加载的产物跑一遍。
//   · 结构检查：ModuleLoader 格式、id、插槽、apply 导出
//   · 工厂真的能执行：用 React 桩渲染出 L2D 启动按钮 → 点开 → 出编辑器面板
//   · 与源码同步：build-client --check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

function createReactStub() {
  const store = new Map();
  const effects = [];
  let cursor = 0;

  function index(initial, factory) {
    const current = cursor++;
    if (!store.has(current)) store.set(current, factory ? factory(initial) : initial);
    return current;
  }

  const api = {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2);
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      };
    },
    useState(initial) {
      const slot = index(initial, (value) => (typeof value === "function" ? value() : value));
      return [
        store.get(slot),
        (next) => {
          store.set(slot, typeof next === "function" ? next(store.get(slot)) : next);
        }
      ];
    },
    useRef(initial) {
      const slot = index(undefined, () => ({ current: initial }));
      return store.get(slot);
    },
    useMemo(factory) {
      cursor++;
      return factory();
    },
    useEffect(fn) {
      cursor++;
      effects.push(fn());
    },
    useCallback(fn) {
      cursor++;
      return fn;
    }
  };

  return {
    api,
    effects,
    reset() {
      cursor = 0;
    },
    render(component) {
      cursor = 0;
      return component();
    }
  };
}

function createDomStub() {
  const appended = [];
  const document = {
    head: { appendChild: (node) => { node.parentNode = document.head; appended.push(node); } },
    documentElement: { appendChild: () => {} },
    body: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({
      id: "",
      textContent: "",
      style: {},
      appendChild: () => {},
      remove: () => {}
    })
  };
  return { document, appended };
}

function loadBundle() {
  const react = createReactStub();
  const dom = createDomStub();
  const registries = [];

  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        registries.push(definition);
      }
    },
    document: dom.document,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    devicePixelRatio: 1
  };

  const factory = new Function("window", "document", "require", BUNDLE + "\nreturn window.__ModuleLoader__;");
  factory(windowStub, dom.document, (name) => {
    if (name === "react") return react.api;
    throw new Error("unexpected require: " + name);
  });

  assert.equal(registries.length, 1, "应当只注册一个 ModuleLoader bundle");
  const moduleExports = registries[0].factory((name) => {
    if (name === "react") return react.api;
    throw new Error("unexpected require: " + name);
  });
  return { exports: moduleExports, react, dom, definition: registries[0] };
}

function find(node, predicate, found = []) {
  if (!node || typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

test("bundle 结构：ModuleLoader 格式与关键标记", () => {
  assert.match(BUNDLE, /^\/\/ dsh-live2d-editor/m);
  assert.ok(BUNDLE.includes('id: "dsh-live2d-editor"'));
  assert.ok(BUNDLE.includes("__ModuleLoader__.load"));
  assert.ok(BUNDLE.includes("return module.exports"));
  assert.ok(BUNDLE.includes("Live2DCubismCore"), "Cubism Core 必须内联（客户端不能取同级文件）");
  assert.ok(BUNDLE.includes("shell.overlay"));
  assert.ok(!/^export\s/m.test(BUNDLE), "产物里不能残留 ESM export");
  assert.ok(!BUNDLE.includes("window.__L2D_EDITOR_REACT__"), "React 必须来自宿主模块表");
});

test("ModLoader 工厂可执行：apply 注册 shell.overlay，组件能渲染出启动按钮", () => {
  const { exports, react } = loadBundle();
  assert.deepEqual(exports.inject, ["slots"]);
  assert.equal(typeof exports.apply, "function");

  let registered = null;
  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      return dispose;
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, "shell.overlay");
        return callback();
      },
      register(options, component) {
        registered = { options, component };
        return () => {};
      }
    }
  };

  exports.apply(ctx);
  assert.ok(registered, "没有注册到 shell.overlay");
  assert.equal(registered.options.name, "shell.overlay");
  assert.equal(registered.options.id, "dsh-live2d-editor");
  assert.equal(typeof registered.component, "function");

  const tree = react.render(registered.component);
  const launchers = find(tree, (node) => node.props && node.props.className === "l2de-launch");
  assert.equal(launchers.length, 1);
  assert.equal(launchers[0].children[0], "L2D");
  assert.equal(tree.props.className, "l2de-launch");
});

test("点开启动按钮后渲染出完整编辑器面板", () => {
  const { exports, react } = loadBundle();
  let registered = null;
  exports.apply({
    effect: (fn) => fn(),
    slots: { inject: (name, callback) => callback(), register: (options, component) => { registered = { options, component }; return () => {}; } }
  });

  const closed = react.render(registered.component);
  react.reset();
  closed.props.onClick();
  const open = react.render(registered.component);

  assert.equal(open.props.className, "l2de-overlay");
  const classes = find(open, (node) => typeof node.props.className === "string")
    .flatMap((node) => node.props.className.split(/\s+/));
  for (const expected of ["l2de-dialog", "l2de-canvas", "l2de-left", "l2de-center", "l2de-right", "l2de-foot"]) {
    assert.ok(classes.includes(expected), "缺少 ." + expected);
  }
  const texts = find(open, (node) => typeof node.children?.[0] === "string").map((node) => node.children[0]);
  assert.ok(texts.includes("表情"), "缺表情卡片");
  assert.ok(texts.includes("动作"), "缺动作卡片");

  const fileInputs = find(open, (node) => node.type === "input" && node.props.type === "file");
  assert.equal(fileInputs.length, 3, "模型 / 表情 / 动作 三个导入入口");
  const buttons = find(open, (node) => node.type === "button").map((node) => node.children[0]).filter((text) => typeof text === "string");
  for (const label of ["导入模型", "关闭", "记录当前姿态", "播放", "打关键帧", "导出动作", "截图", "线框"]) {
    assert.ok(buttons.includes(label), "缺少按钮：" + label);
  }
});

test("lib/client.js 与 src/ 同步（build-client --check）", () => {
  const output = execFileSync(process.execPath, [join(ROOT, "scripts", "build-client.mjs"), "--check"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  const result = JSON.parse(output);
  assert.equal(result.inSync, true);
  assert.ok(result.bytes > 500000, "bundle 里应当带着 Core 与内置模型");
});
