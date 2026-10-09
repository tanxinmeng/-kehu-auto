// 诊断工具：每 20s 用 curl 级客户端（node fetch，无浏览器指纹）+ 自动化同一份 cookie
// 同时探测 duola / aiDuola 列表接口，记录 status/content-type/响应头几步。
// 目的：duola 间歇返回 HTML 错误页期间，看"非浏览器客户端"是否同样失败 → 定位服务端 vs 客户端。
import fs from "node:fs";
import path from "node:path";
import config from "../config.json" with { type: "json" };

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const outFile = path.join(dataDir, "wave_monitor.log");
const sessionFile = path.join(dataDir, "session.json");

function log(line) {
  try { fs.appendFileSync(outFile, line + "\n"); } catch {}
  console.log(line);
}

const state = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const cookieStr = (state.cookies || [])
  .filter(c => /yuaiweiwu\.com$/i.test(c.domain))
  .map(c => `${c.name}=${c.value}`)
  .join("; ");
log(`[${new Date().toLocaleString("zh-CN")}] 监控启动, cookies=${(state.cookies || []).filter(c => /yuaiweiwu\.com$/i.test(c.domain)).length} 条 (yuaiweiwu.com 域)`);

const targets = [
  { name: "duola", url: "https://duola.yuaiweiwu.com/prod-api/flowtracker-yy/clue/info/list" },
  { name: "aiDuola", url: "https://ai-duola.yuaiweiwu.com/prod-api/flowtracker-yy-ai/clue/info/list" },
];
const body = JSON.stringify({ nickName: "", nickNames: [], mobile: "", mobiles: [], orderNo: "1", virtualMobile: "", orderNos: ["1"], virtualMobiles: [], current: 1, size: 1, recordId: "", recordIds: [] });

async function probe(t) {
  const started = Date.now();
  try {
    const resp = await fetch(t.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookieStr, "User-Agent": "curl/8.0 (wave-monitor diag)" },
      body,
      signal: AbortSignal.timeout(12000),
    });
    const txt = await resp.text();
    const isJson = txt.trim().startsWith("{");
    const wave = !isJson;
    log(`${new Date().toLocaleTimeString("zh-CN")} [${t.name}] status=${resp.status} ct=${(resp.headers.get("content-type") || "?").split(";")[0]} len=${txt.length} json=${isJson}${wave ? "  <<< HTML/非JSON" : ""} head=${txt.slice(0, 120).replace(/\s+/g, " ")}`);
    return { name: t.name, wave, status: resp.status, server: resp.headers.get("server") || "", setCookie: resp.headers.getSetCookie ? resp.headers.getSetCookie().map(c => c.split("=")[0]).join(",") : "" };
  } catch (e) {
    log(`${new Date().toLocaleTimeString("zh-CN")} [${t.name}] FETCH_FAIL ${String(e && e.cause && e.cause.code || e).slice(0, 100)} (${Date.now() - started}ms)`);
    return { name: t.name, wave: true, status: 0, server: "", setCookie: "" };
  }
}

while (true) {
  const [d, a] = await Promise.all(targets.map(probe));
  if (d.wave && !a.wave) log(`  >>> 波动事件: duola 异常 + aiDuola 正常 (同一时刻, curl 客户端)`);
  await new Promise(r => setTimeout(r, 20000));
}
