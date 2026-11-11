/**
 * dsh-live2d-editor — 宿主半边（零依赖、零逻辑）。
 *
 * 全部功能都在浏览器半边 `lib/client.js`。宿主半边存在的唯一理由：让这个包成为
 * cordis 树上的一行，`dsh-client-modules` 才会把客户端产物编进 __DSH_BOOT__。
 *
 * 纪律：
 *   1. apply() 绝不抛错 —— 同步抛错会让该 fiber 失败，启动审计报「Failed to load plugins」。
 *   2. 不 inject 任何服务 —— 声明一个没人 provide 的服务会让 fiber 停在 PENDING。
 *   3. 只做一件事：静态核对客户端产物在不在，坏了也只是编辑器按钮不出现，
 *      绝不阻断启动。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE_ID = "dsh-live2d-editor";

function auditBundle(log) {
  try {
    const bundle = readFileSync(fileURLToPath(new URL("./lib/client.js", import.meta.url)), "utf8");
    const problems = [];
    if (!bundle.includes(`id: "${PACKAGE_ID}"`)) problems.push("bundle id 不匹配");
    if (!bundle.includes("__ModuleLoader__.load")) problems.push("不是模块加载器 bundle");
    if (!bundle.includes("return module.exports")) problems.push("工厂没有交出 exports");
    if (!bundle.includes("shell.overlay")) problems.push("没有声明目标插槽");
    if (!bundle.includes("Live2DCubismCore")) problems.push("没有内联 Cubism Core");
    if (!/exports\.apply\s*=/.test(bundle)) problems.push("没有导出 apply");
    if (problems.length > 0) {
      log(`客户端产物 lib/client.js 检查未通过（左下角不会出现 L2D）：${problems.join("；")}`);
      return;
    }
    log(`客户端产物 lib/client.js 就绪（${Buffer.byteLength(bundle, "utf8")} 字节，静态检查通过）`);
  } catch (error) {
    log(`客户端产物 lib/client.js 不可读（左下角不会出现 L2D）：${String(error)}`);
  }
}

export function apply(ctx) {
  try {
    const candidate = ctx?.logger;
    const sink = typeof candidate === "function" ? candidate(PACKAGE_ID) : candidate;
    const log = (message) => {
      try {
        if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] ${message}`);
        else console.info(`[${PACKAGE_ID}] ${message}`);
      } catch {
        /* 连日志都不能抛 */
      }
    };
    auditBundle(log);
  } catch {
    /* 审计失败也必须静默成功 */
  }
}

export default { apply };
