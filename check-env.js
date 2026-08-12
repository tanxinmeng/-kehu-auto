// 环境自检：Node版本 / node:sqlite / 依赖 / 登录态 / 端口。用法：node check-env.js
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const ROOT = process.cwd();
let pass = 0, fail = 0, warn = 0;
const ok = (m) => { console.log("[OK]   " + m); pass++; };
const bad = (m) => { console.log("[FAIL] " + m); fail++; };
const w = (m) => { console.log("[WARN] " + m); warn++; };

// 1) Node 版本（node:sqlite 需要 22.5+）
const v = process.versions.node;
const [ma, mi] = v.split(".").map(Number);
if (ma > 22 || (ma === 22 && mi >= 5)) ok("Node " + v + "（满足 node:sqlite 要求）");
else bad("Node " + v + " 过低，需 22.5+（建议 24 LTS）：https://nodejs.org");

// 2) node:sqlite 可用性
try {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE t(a); DROP TABLE t;");
  d.close();
  ok("node:sqlite 可用");
} catch (e) { bad("node:sqlite 不可用: " + String(e.message || e).split("\n")[0]); }

// 3) 依赖
for (const dep of ["playwright", "jszip", "sax"]) {
  try { await import(dep); ok("依赖 " + dep + " 已安装"); }
  catch { bad("依赖 " + dep + " 未安装（运行 npm install playwright jszip sax）"); }
}

// 4) 登录态
const sessionFile = path.join(ROOT, "data", "session.json");
if (fs.existsSync(sessionFile)) ok("data/session.json 存在");
else w("data/session.json 不存在 → 运行 start-login.bat 扫码登录（登录态会过期）");

// 5) 端口 8766
const portBusy = await new Promise((resolve) => {
  const s = net.connect({ port: 8766, host: "127.0.0.1" });
  s.on("connect", () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});
if (portBusy) w("端口 8766 已被占用（可能 server 已在运行，可跳过启动；若需重启先结束占用进程）");
else ok("端口 8766 空闲（可启动 server）");

console.log("\n结果: 通过 " + pass + "，失败 " + fail + "，警告 " + warn);
process.exit(fail ? 1 : 0);
