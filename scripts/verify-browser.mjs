// 浏览器端验证：用系统 Edge 的无头模式真的加载 Cubism Core + 渲染器，
// 断言「模型能被 WebGL 画出来」「拖参数真的改几何」「截得到图」。
//
// 做法不需要 npm 依赖：写一个 harness 页面 → Edge --headless=new --dump-dom →
// 从 DOM 里读回 JSON 结果。页面里不点按钮，只走渲染器 API（与面板同一条路径）。
//
//   node scripts/verify-browser.mjs [--keep]
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD = join(ROOT, "build");
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe"
];
const SHOT = join(ROOT, "preview", "editor-render.png");

const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!edge) {
  console.error("verify-browser: 找不到 Edge/Chrome，跳过浏览器验证");
  process.exit(2);
}

const assets = (await import("file://" + join(BUILD, "model-assets.mjs").replace(/\\/g, "/"))).default;
mkdirSync(BUILD, { recursive: true });

const harness = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>l2d harness</title></head>
<body>
<canvas id="stage" style="width:420px;height:520px"></canvas>
<pre id="result"></pre>
<script src="../assets/live2dcubismcore.min.js"></script>
<script src="../src/viewport.js"></script>
<script>
var MODEL = ${JSON.stringify(assets)};
var out = { steps: [], ok: false };
function note(name, data) { out.steps.push(Object.assign({ name: name }, data || {})); }
function publish() { document.getElementById("result").textContent = JSON.stringify(out); }
function fail(message) { out.error = String(message); out.ok = false; publish(); }
try {
  var canvas = document.getElementById("stage");
  canvas.width = 420; canvas.height = 520;
  out.core = !!window.Live2DCubismCore;
  if (!out.core) throw new Error("Cubism Core 没加载");
  var view = window.createLive2DEditorViewport(canvas, MODEL, {});
  note("model", { drawables: view.drawableCount, textures: view.textureCount, parameters: view.parameterIds.length, masks: view.maskWarning });
  view.render();
  var gl = view.gl;

  function coverage() {
    var w = canvas.width, h = canvas.height;
    var buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    var painted = 0, sum = 0;
    for (var i = 3; i < buf.length; i += 4) {
      if (buf[i] > 8) painted++;
      sum = (sum + buf[i] * (i % 97)) % 2147483647;
    }
    return { painted: painted, ratio: painted / (w * h), hash: sum };
  }

  var waitTries = 0;
  function waitTextures() {
    waitTries++;
    if (!view.texturesReady() && waitTries < 200) { setTimeout(function () { try { waitTextures(); } catch (error) { fail(error && error.stack ? error.stack : error); } }, 50); return; }
    if (!view.texturesReady()) throw new Error("图集一直没就绪");
    view.render();
    var first = coverage();
    note("first-draw", first);

    var before = Array.prototype.slice.call(view.model.drawables.vertexPositions[0]);
    view.setParam("ParamAngleZ", 30);
    view.setParam("ParamEyeLOpen", 0);
    view.render();
    var after = view.model.drawables.vertexPositions[0];
    var delta = 0;
    for (var i = 0; i < before.length; i++) delta += Math.abs(before[i] - after[i]);
    note("deform", { delta: delta, angleZ: view.getParam("ParamAngleZ"), eyeOpen: view.getParam("ParamEyeLOpen") });

    view.setWireframe(true);
    view.render();
    var wire = coverage();
    view.setWireframe(false);
    view.render();
    note("wireframe", wire);

    view.resetView();
    view.setParam("ParamAngleZ", 0);
    view.setParam("ParamEyeLOpen", 1);
    view.render();
    var shot = view.snapshot();
    note("snapshot", { bytes: shot.length, prefix: shot.slice(0, 22) });
    note("image", { dataUrl: shot });
    out.ok = true;
    publish();
  }
  waitTextures();
} catch (error) {
  fail(error && error.stack ? error.stack : error);
}
window.addEventListener("error", function (event) { fail(event.message); });
publish();
</script>
</body></html>
`;

const harnessPath = join(BUILD, "harness.html");
writeFileSync(harnessPath, harness);

const flags = [
  "--headless=new",
  "--disable-gpu-sandbox",
  "--no-sandbox",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--hide-scrollbars",
  "--window-size=520,620",
  "--virtual-time-budget=15000",
  "--dump-dom",
  pathToFileURL(harnessPath).href
];

function runEdge(args) {
  return new Promise((resolveRun) => {
    execFile(edge, args, { maxBuffer: 40 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
      resolveRun({ error, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

const result = await runEdge(flags);
const match = result.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error("verify-browser: harness 没有产出结果");
  console.error(result.stdout.slice(-2000));
  console.error(result.stderr.slice(-2000));
  process.exit(1);
}

const text = match[1]
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");
const data = JSON.parse(text);
const problems = [];
if (data.error) problems.push("页面报错：" + data.error);
if (!data.core) problems.push("Cubism Core 未加载");
const steps = Object.fromEntries((data.steps || []).map((step) => [step.name, step]));
const model = steps.model || {};
if (model.drawables !== 17) problems.push("绘制对象应为 17，实际 " + model.drawables);
if (model.parameters !== 27) problems.push("参数应为 27，实际 " + model.parameters);
if (!steps["first-draw"] || steps["first-draw"].ratio < 0.05) {
  problems.push("画面覆盖不足（" + JSON.stringify(steps["first-draw"]) + "），模型没画出来");
}
if (!steps.deform || steps.deform.delta <= 0) problems.push("改参数后顶点没动，变形没生效");
if (steps.deform && steps.deform.angleZ !== 30) problems.push("ParamAngleZ 没有写进模型");
if (!steps.wireframe || steps.wireframe.ratio <= 0) problems.push("线框模式没画出东西");
if (!steps.snapshot || !String(steps.snapshot.prefix).startsWith("data:image/png")) problems.push("截图不是 PNG data URL");

const image = (data.steps || []).find((step) => step.name === "image");
if (image && image.dataUrl) {
  mkdirSync(join(ROOT, "preview"), { recursive: true });
  writeFileSync(SHOT, Buffer.from(image.dataUrl.split(",")[1], "base64"));
}

const report = {
  ok: problems.length === 0,
  problems,
  model,
  firstDraw: steps["first-draw"],
  deform: steps.deform,
  wireframe: steps.wireframe,
  snapshot: steps.snapshot,
  screenshot: existsSync(SHOT) ? SHOT : null
};
console.log(JSON.stringify(report, null, 1));
if (process.argv.includes("--keep") === false) {
  // harness 留着当调试入口，不删
}
process.exit(report.ok ? 0 : 1);
