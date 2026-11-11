// 探针：eval 载入 Core 后，Moc.fromArrayBuffer 是「立刻可用」还是「要等一拍」
import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const core = readFileSync(join(ROOT, "assets", "live2dcubismcore.min.js"), "utf8");
const assets = (await import("file://" + join(ROOT, "build", "model-assets.mjs").replace(/\\/g, "/"))).default;

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="r"></pre>
<script>
var CORE_SRC = ${JSON.stringify(core)};
var MOC = ${JSON.stringify(assets.moc3)};
var log = [];
function b64(s) { var bin = atob(s); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
function attempt(tag) {
  try {
    var moc = window.Live2DCubismCore.Moc.fromArrayBuffer(b64(MOC));
    var model = window.Live2DCubismCore.Model.fromMoc(moc);
    log.push(tag + ": ok drawables=" + model.drawables.count);
    return true;
  } catch (e) {
    log.push(tag + ": " + e.message);
    return false;
  }
}
try {
  (0, eval)(CORE_SRC);
  log.push("core? " + !!window.Live2DCubismCore);
  if (!attempt("immediate")) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (attempt("retry-" + tries) || tries > 40) {
        clearInterval(timer);
        document.getElementById("r").textContent = JSON.stringify(log);
      }
    }, 25);
  } else {
    document.getElementById("r").textContent = JSON.stringify(log);
  }
} catch (e) {
  log.push("eval failed: " + e.message);
  document.getElementById("r").textContent = JSON.stringify(log);
}
</script></body></html>`;

const target = join(ROOT, "build", "core-eval-probe.html");
writeFileSync(target, page);
console.log(target);
