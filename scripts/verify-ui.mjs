// 面板交互验证：把同一份 lib/client.js 的组件挂在普通页面里，用无头 Edge 真的拖滑块、
// 记录表情、打关键帧、点导出，断言「画面变了 / 列表长出来了 / 文件名对」。
//
// 需要 build/vendor/{react,react-dom}.js（scripts/fetch-vendor.mjs 下载），仅测试用，不进包。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD = join(ROOT, "build");
const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe"
].find((candidate) => existsSync(candidate));

if (!EDGE) {
  console.error("verify-ui: 找不到 Edge/Chrome");
  process.exit(2);
}
for (const vendor of ["react.js", "react-dom.js"]) {
  if (!existsSync(join(BUILD, "vendor", vendor))) {
    console.error(`verify-ui: 缺 build/vendor/${vendor}，先跑 node scripts/fetch-vendor.mjs`);
    process.exit(2);
  }
}

const helpers = `
var out = { steps: [], problems: [] };
function note(name, data) { out.steps.push(Object.assign({ name: name }, data || {})); }
function problem(text) { out.problems.push(text); }
function publish() { document.getElementById("r").textContent = JSON.stringify(out); }

var downloads = [];
var blobs = [];
var originalCreate = URL.createObjectURL;
URL.createObjectURL = function (blob) { blobs.push(blob); return originalCreate.call(URL, blob); };
HTMLAnchorElement.prototype.click = function () {
  downloads.push({ name: this.download, href: String(this.href).slice(0, 30) });
};

function readBlobs(callback) {
  if (blobs.length === 0) return callback([]);
  var texts = new Array(blobs.length);
  var remaining = blobs.length;
  blobs.forEach(function (blob, index) {
    var reader = new FileReader();
    reader.onload = function () {
      texts[index] = String(reader.result);
      remaining--;
      if (remaining === 0) callback(texts);
    };
    reader.onerror = function () {
      texts[index] = "";
      remaining--;
      if (remaining === 0) callback(texts);
    };
    reader.readAsText(blob);
  });
}

function setRange(input, value) {
  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findByText(root, selector, text) {
  return Array.prototype.slice.call(root.querySelectorAll(selector)).filter(function (node) {
    return (node.textContent || "").trim() === text;
  })[0] || null;
}

function rowForPanel(panel, label) {
  return Array.prototype.slice.call(panel.querySelectorAll(".l2de-row")).filter(function (row) {
    var name = row.querySelector(".l2de-row-name");
    return name && (name.textContent || "").trim() === label;
  })[0] || null;
}

function imageSignature(canvas) {
  var text = canvas.toDataURL();
  var sum = 0;
  for (var i = 0; i < text.length; i += 97) sum = (sum * 31 + text.charCodeAt(i)) % 2147483647;
  return { length: text.length, sum: sum };
}

function pollUntil(condition, next, limit) {
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (condition()) { clearInterval(timer); next(); }
    else if (tries > (limit || 40)) { clearInterval(timer); problem("等待超时"); publish(); }
  }, 100);
}

function start() {
  var def = window.__ModuleLoader__.defs[0];
  if (!def) { problem("bundle 没有注册"); return publish(); }
  var module = def.factory(function (name) { return name === "react" ? React : null; });
  var host = document.getElementById("host");
  module.apply({
    effect: function (fn) { return fn(); },
    slots: {
      inject: function (name, callback) { return callback(); },
      register: function (options, component) {
        ReactDOM.createRoot(host).render(React.createElement(component));
      }
    }
  });

  var waited = 0;
  var poll = setInterval(function () {
    waited += 100;
    var launcher = host.querySelector(".l2de-launch");
    var canvas = host.querySelector(".l2de-canvas");
    var rows = host.querySelectorAll(".l2de-row").length;
    if (launcher && !host.querySelector(".l2de-dialog")) {
      launcher.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return;
    }
    if (host.querySelector(".l2de-dialog") && canvas && rows > 0) {
      clearInterval(poll);
      try { run(host, canvas); } catch (error) { problem("交互异常：" + (error && error.message)); publish(); }
    } else if (waited > 15000) {
      clearInterval(poll);
      problem("面板 15s 内没有就绪（rows=" + rows + "）");
      publish();
    }
  }, 100);
}
`;

const runBody = `
function run(host, canvas) {
  note("mount", {
    rows: host.querySelectorAll(".l2de-row").length,
    tabs: Array.prototype.slice.call(host.querySelectorAll(".l2de-tabs button")).map(function (b) { return b.textContent.trim(); }),
    title: host.querySelector(".l2de-title b").textContent,
    status: host.querySelector(".l2de-sub").textContent
  });
  var before = imageSignature(canvas);
  note("baseline", before);

  var row = rowForPanel(host.querySelector(".l2de-left"), "角度 Z");
  if (!row) { problem("找不到「角度 Z」参数行"); return publish(); }
  setRange(row.querySelector("input[type=range]"), 25);

  pollUntil(function () { return row.querySelector("input[type=number]").value === "25"; }, function () {
    var after = imageSignature(canvas);
    note("after-slider", after);
    if (after.sum === before.sum) problem("拖动滑块后画面没变");

    var chipsBefore = host.querySelectorAll(".l2de-chip").length;
    var capture = findByText(host, "button", "记录当前姿态");
    if (!capture) { problem("找不到「记录当前姿态」"); return publish(); }
    capture.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    pollUntil(function () { return host.querySelectorAll(".l2de-chip").length > chipsBefore; }, function () {
      note("expression", { chips: host.querySelectorAll(".l2de-chip").length });

      var keysBefore = host.querySelectorAll(".l2de-key").length;
      findByText(host, "button", "打关键帧").dispatchEvent(new MouseEvent("click", { bubbles: true }));

      pollUntil(function () { return host.querySelectorAll(".l2de-key").length > keysBefore; }, function () {
        note("keyframe", { keys: host.querySelectorAll(".l2de-key").length });

        findByText(host, "button", "导出动作").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        var exportChip = host.querySelector(".l2de-chip .l2de-chip-act[title='导出 exp3']");
        if (exportChip) exportChip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        pollUntil(function () { return downloads.length >= 2; }, function () {
          note("downloads", downloads);
          if (!downloads.some(function (item) { return /\\.motion3\\.json$/.test(item.name); })) problem("没有导出 .motion3.json");
          if (!downloads.some(function (item) { return /\\.exp3\\.json$/.test(item.name); })) problem("没有导出 .exp3.json");

          findByText(host, "button", "截图").dispatchEvent(new MouseEvent("click", { bubbles: true }));
          pollUntil(function () { return downloads.some(function (item) { return /\\.png$/.test(item.name); }); }, function () {
            note("screenshot", downloads.filter(function (item) { return /\\.png$/.test(item.name); })[0]);
            readBlobs(function (texts) {
              var motion = null;
              var expression = null;
              texts.forEach(function (text) {
                try {
                  var json = JSON.parse(text);
                  if (json && json.Curves) motion = json;
                  if (json && json.Type === "Live2D Expression") expression = json;
                } catch (error) {
                  problem("导出的 JSON 解析失败：" + String(error && error.message));
                }
              });
              if (!motion) problem("没有可解析的 motion3");
              else {
                var segments = motion.Curves[0] && motion.Curves[0].Segments;
                note("motion3", {
                  curveCount: motion.Meta.CurveCount,
                  totalPoints: motion.Meta.TotalPointCount,
                  firstSegments: segments && segments.slice(0, 5),
                  curveIds: motion.Curves.map(function (curve) { return curve.Id; }).slice(0, 4)
                });
                if (!motion.Meta || motion.Meta.CurveCount < 1) problem("motion3 的 Meta 不对");
                if (!segments || segments.length < 5) problem("motion3 的 Segments 太短");
                if (motion.Curves[0].Target !== "Parameter") problem("motion3 曲线 Target 不是 Parameter");
              }
              if (!expression) problem("没有可解析的 exp3");
              else {
                note("exp3", {
                  type: expression.Type,
                  count: expression.Parameters.length,
                  first: expression.Parameters[0]
                });
                if (!Array.isArray(expression.Parameters) || expression.Parameters.length === 0) problem("exp3 没有参数");
              }
              out.ok = out.problems.length === 0;
              publish();
            });
          }, 30);
        }, 30);
      }, 30);
    }, 30);
  }, 30);
}
`;

const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>ui verify</title>
<style>html,body{margin:0;height:100%;background:#eef0f3}#host{position:absolute;inset:0}</style></head>
<body><div id="host"></div><pre id="r"></pre>
<script src="vendor/react.js"></script>
<script src="vendor/react-dom.js"></script>
<script>window.__ModuleLoader__={defs:[],load(d){this.defs.push(d)}};</script>
<script src="../lib/client.js"></script>
<script>
${helpers}
${runBody}
window.addEventListener("load", function () {
  try { start(); } catch (error) { problem("启动失败：" + (error && error.message)); publish(); }
});
</script>
</body></html>`;

mkdirSync(BUILD, { recursive: true });
const target = join(BUILD, "ui-verify.html");
writeFileSync(target, page);

function runEdge() {
  return new Promise((resolveRun) => {
    execFile(
      EDGE,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--hide-scrollbars",
        "--window-size=1400,900",
        "--virtual-time-budget=30000",
        "--dump-dom",
        pathToFileURL(target).href
      ],
      { maxBuffer: 40 * 1024 * 1024, timeout: 180000 },
      (error, stdout, stderr) => resolveRun({ error, stdout: stdout || "", stderr: stderr || "" })
    );
  });
}

const result = await runEdge();
const match = result.stdout.match(/<pre id="r">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error("verify-ui: 没有拿到结果");
  console.error(result.stdout.slice(-1500));
  console.error(result.stderr.slice(-1500));
  process.exit(1);
}
const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const data = JSON.parse(decoded);
const problems = data.problems || [];
console.log(JSON.stringify({ ok: problems.length === 0, problems, steps: data.steps }, null, 1));
process.exit(problems.length === 0 ? 0 : 1);
