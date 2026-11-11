// 出交付包：dist/ 下产出一个可安装的 .tgz（npm pack）和一个可读的 .zip（含 INSTALL.md）。
//   node scripts/make-dist.mjs
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const STAGE = join(DIST, "stage", pkg.name);

const INSTALL = `# ${pkg.name} ${pkg.version} — 安装说明

**Live2D 编辑器**：DSH Web 界面右缘的一个 \`L2D\` 侧边标签，点开是参数滑块 + 真实 WebGL 模型视口 + 表情/动作面板。
Cubism Core、内置模型（LED v16）都内联在 \`lib/client.js\` 里，零运行时依赖，不需要联网。

## 需要

- DeepSeek Harness（DSH）0.2.1-rc.5 以上、0.3.0 以下（见 \`package.json\` 的 \`engines.dsh\`）
- Node.js 22 以上

## 安装

1. 解压到一个固定位置，路径建议纯英文，例如 \`D:\\dsh-live2d-editor\`。
   解压后应能看到 \`package.json\`、\`cordis.patch.yml\`、\`index.js\`、\`lib\\client.js\`、\`README.md\`。

2. 用 pnpm 或 npm 把包装进 desktop profile（路径用正斜杠）：

   \`\`\`powershell
   cd C:\\Users\\<你>\\.dsh\\profiles\\desktop
   pnpm add file:D:/dsh-live2d-editor
   \`\`\`

3. 在 profile 的 \`package.json\` 里把 \`"${pkg.name}"\` 加进 \`dsh.profile.bundles\` 数组。

4. 重启 DSH（或让它重载），然后刷新页面：窗口右缘中部会出现竖排的 \`L2D\` 标签。

也可以用 Agent 的 \`plugin_manager\`：\`action=install_bundle\`, \`target=<解压目录>\`。

## 卸载

- profile 的 \`package.json\`：从 \`dsh.profile.bundles\` 删掉 \`${pkg.name}\`，再 \`pnpm remove ${pkg.name}\`
- 或 \`plugin_manager\` \`action=remove_bundle\`, \`target=${pkg.name}\`

## 用之前知道三件事

1. **剪裁遮罩没实现**：带 Clipping Mask 的模型会把遮罩对象整块画出来；面板底部会提示数量。LED 模型没有遮罩。
2. **不写 .cmo3**：那是 Cubism Editor 的私有工程容器。这个面板负责调参数、存表情（\`.exp3.json\`）、做小动作（\`.motion3.json\`），产物用 Cubism Editor 或支持 Cubism 的运行时直接能吃。
3. **刷新才生效**：换模型/表情存在浏览器 \`localStorage\`，按模型名分键。

## 验证过的

- \`npm test\`：34 例（参数/表情/动作/清单纯逻辑、bundle 结构、React 桩渲染）
- \`npm run test:browser\`：系统 Edge 无头真渲染（17 个绘制对象、27 个参数、参数改动真的改顶点）+ 真交互（拖滑块画面变化、记录表情、打关键帧、导出 motion3/exp3/PNG 且 JSON 可解析）

许可：代码 MIT；\`lib/client.js\` 内联的 Live2D Cubism Core 按 Live2D 的 Redistributable Code 条款分发，见 \`NOTICE\`。
`;

function run(command, options) {
  return execSync(command, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1. npm pack
const packOutput = run("npm pack --json --pack-destination dist");
const packed = JSON.parse(packOutput)[0];
const tgz = join(DIST, packed.filename);
if (!existsSync(tgz)) throw new Error("npm pack 没有产出 tgz");

// 2. 文件清单（用于铺 zip）
const listing = JSON.parse(run("npm pack --dry-run --json"))[0].files.map((entry) => entry.path);

// 3. staging + zip
mkdirSync(STAGE, { recursive: true });
for (const path of listing) {
  const from = join(ROOT, path);
  const to = join(STAGE, path);
  mkdirSync(join(to, ".."), { recursive: true });
  copyFileSync(from, to);
}
writeFileSync(join(STAGE, "INSTALL.md"), INSTALL);

const zipPath = join(DIST, `${pkg.name}-${pkg.version}.zip`);
const zipScript = join(DIST, "zip.py");
writeFileSync(
  zipScript,
  [
    "import os, sys, zipfile",
    "stage, out, top = sys.argv[1], sys.argv[2], sys.argv[3]",
    "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:",
    "    for root, _, files in os.walk(stage):",
    "        for name in sorted(files):",
    "            full = os.path.join(root, name)",
    "            rel = os.path.relpath(full, stage)",
    "            z.write(full, os.path.join(top, rel).replace('\\\\', '/'))"
  ].join("\n")
);
execFileSync("python", [zipScript, STAGE, zipPath, `${pkg.name}`], { cwd: ROOT });

const report = {
  tgz: { path: tgz, bytes: statSync(tgz).size },
  zip: { path: zipPath, bytes: statSync(zipPath).size },
  files: listing.length + 1
};
rmSync(join(DIST, "stage"), { recursive: true, force: true });
rmSync(zipScript, { force: true });
console.log(JSON.stringify(report, null, 1));
