// M4: 本地网页服务器（内部处理表 + 手动同步按钮 + 勾选是否处理 + 备注）
// 注意：同步/查询都用同一个 Edge 配置，必须串行执行（jobQueue），否则会互抢配置文件
import http from "node:http";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import config from "../config.json" with { type: "json" };
import { openDb } from "./db.js";

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const db = openDb(dataDir);
const port = config.web.port || 8766;
const dingCfg = config.dingtalk || {};
const dingSettingsFile = path.join(dataDir, "ding_settings.json");
function readDingSettings() { try { return JSON.parse(fs.readFileSync(dingSettingsFile, "utf8")); } catch { return {}; } }
// 快速判断腾讯文档是否已登录：优先看 doc_session.json 的实测结果（sync/回填每次打开文档都会写入），
// 3 小时内实测过游客模式 → 直接判未登录（cookie 快照无法反映服务端已将会话作废，曾出现"显示已登录实际游客"）；
// 没有实测数据时才退回检查 session.json 里 docs.qq.com 的 SID/uid 是否过期
function tencentLoggedIn() {
  try {
    const live = JSON.parse(fs.readFileSync(path.join(dataDir, "doc_session.json"), "utf8"));
    if (live.at && Date.now() - live.at < 3 * 3600 * 1000) return !live.guest;
  } catch {}
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, "session.json"), "utf8"));
    const cookies = s.cookies || [];
    const now = Date.now() / 1000;
    const find = (name) => cookies.find(c => /\.?docs\.qq\.com$/i.test(c.domain || "") && c.name === name && c.value);
    const sid = find("SID");
    const uid = find("uid");
    return !!(sid && uid && (sid.expires === -1 || sid.expires > now));
  } catch { return false; }
}
// 腾讯文档登录状态（供界面红横幅）：结合实测 doc_session.json 给出带时间的原因
function tencentLoginState() {
  if (tencentLoggedIn()) return { ok: true };
  let reason = "腾讯文档会话已失效（或从未登录），回填/同步前请重新扫码";
  try {
    const live = JSON.parse(fs.readFileSync(path.join(dataDir, "doc_session.json"), "utf8"));
    if (live.guest && live.at) reason = "腾讯文档掉登录（" + new Date(live.at).toLocaleString("zh-CN") + " 实测处于游客只读模式，复制/写入被禁），请重新扫码";
  } catch {}
  return { ok: false, reason };
}
function dingAutoEnabled() {  if (dingCfg.enabled === false) return false;
  const s = readDingSettings();
  return (s.auto === undefined) ? (dingCfg.autoSendOnWriteback !== false) : !!s.auto;
}
// 站点登录状态：看 session.json 里 yuaiweiwu.com 域 cookie 是否过期（供界面亮红灯，不再靠猜）
function siteLoginState() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, "session.json"), "utf8"));
    const now = Date.now() / 1000;
    const siteCookies = (s.cookies || []).filter(c => /yuaiweiwu\.com$/i.test((c.domain || "").replace(/^\./, "")));
    if (!siteCookies.length) return { ok: false, reason: "站点从未登录或会话快照丢失，请重新登录站点" };
    const maxExp = Math.max(...siteCookies.map(c => c.expires || 0));
    if (maxExp > 0 && maxExp < now) return { ok: false, reason: "站点登录已于 " + new Date(maxExp * 1000).toLocaleString("zh-CN") + " 过期，请重新登录站点" };
    return { ok: true, expiresAt: maxExp > 0 ? maxExp * 1000 : null };
  } catch { return { ok: false, reason: "会话快照缺失，请重新登录站点" }; }
}
const AUTO_WRITEBACK = config.writeback && config.writeback.auto !== false;   // 网页勾"是"/填反馈后自动回写源表（可在 config.json 关闭）

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(body);
}


// 设备登录：spawn dws 读到验证码后立即 kill，不等轮询（轮询会持续 900s）
function runDws(bin, dwsArgs, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const cb = (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    if (!/\.(cmd|bat)$/i.test(bin)) {
      execFile(bin, dwsArgs, { cwd: ROOT, timeout: timeoutMs, windowsHide: true }, cb);
      return;
    }
    // Windows 下 .cmd/.bat 必须经 shell 启动；由 Node 自行拼引号，避免手拼出错
    const child = spawn(bin, dwsArgs, { cwd: ROOT, shell: true, windowsHide: true });
    let stdout = "", stderr = "";
    const to = setTimeout(() => { child.kill(); cb({ message: "dws 调用超时" }, stdout, stderr); }, timeoutMs);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", (e) => { clearTimeout(to); cb(e, stdout, stderr); });
    child.on("close", (code) => { clearTimeout(to); cb(code === 0 ? null : { message: "exit code " + code }, stdout, stderr); });
  });
}
function authLooksLoggedIn(out) {
  if (/未登录|登录失败|not\s*logged|logged[\s_-]*out|invalid|expired/i.test(out)) return false;
  if (/登录成功|已登录|logged[\s_-]*in|valid/i.test(out)) return true;
  try {
    const d = JSON.parse(out);
    let ok = false;
    (function walk(o) {
      if (!o || typeof o !== "object" || ok) return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v === true) ok = true;
        else if (typeof v === "string" && /登录成功|已登录|logged[\s_-]*in|valid/i.test(v)) ok = true;
        else if (v && typeof v === "object") walk(v);
        if (ok) return;
      }
    })(d);
    return ok;
  } catch (e) { return false; }
}
function findDwsBin() {
  const cfgBin = dingCfg.binPath || "";
  if (cfgBin && fs.existsSync(cfgBin)) return Promise.resolve(cfgBin);
  const local = path.join(ROOT, "node_modules", ".bin", "dws.cmd");
  if (fs.existsSync(local)) return Promise.resolve(local);
  return new Promise((resolve) => {
    execFile("where.exe", ["dws"], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (!err) {
        const lines = String(stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const exe = lines.find(l => /\.exe$/i.test(l));
        if (exe && fs.existsSync(exe)) return resolve(exe);
        const cmd = lines.find(l => /\.(cmd|bat)$/i.test(l));
        if (cmd && fs.existsSync(cmd)) return resolve(cmd);
        if (lines.length && fs.existsSync(lines[0])) return resolve(lines[0]);
      }
      resolve("");
    });
  });
}

// 运行脚本并收集输出
function runScript(script, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    let done = false;
    const child = execFile(process.execPath, [path.join(ROOT, "src", script), ...args], { cwd: ROOT },
      (err, stdout, stderr) => { done = true; resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }); });
    // 不用 execFile 自带 timeout：它只杀 node 本体，Playwright 拉起的 Edge 会残留占住 profile，
    // 导致后续批量任务卡死在启动阶段；必须 taskkill 整棵进程树
    const killer = setTimeout(() => {
      if (done) return;
      console.log("[runScript] " + script + " 超时，强杀进程树 pid=" + child.pid);
      try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]); } catch {}
    }, timeoutMs);
    child.on("exit", () => { done = true; clearTimeout(killer); });
  });
}

// 浏览器任务队列：同步/查询/回写 串行
let jobChain = Promise.resolve();
const jobState = { running: false, type: "", startedAt: null, doneAt: null, dingRunning: false, batchQueued: 0 };
// 钉钉发送专用队列：notify.js 只用 dws/webhook，不碰浏览器档案，可与补全/回写并行
// （此前与浏览器任务共用一条串行队列，查询补全一跑几分钟，钉钉发送就得干等——点击后迟迟没反应的根因）
let dingChain = Promise.resolve();
function enqueueDing(fn) {
  dingChain = dingChain.then(async () => {
    jobState.dingRunning = true;
    try { return await fn(); }
    finally { jobState.dingRunning = false; }
  }).catch(e => { console.log("[ding] 出错: " + e.message); return { ok: false, reason: e.message }; });
  return dingChain;
}
let tencentLoginProc = null;   // 腾讯文档登录进程（无头截图二维码回传），退出后置 null
let siteLoginProc = null;      // 站点登录进程（login.js 有头 Edge），存续期间禁止启动查询（profile 冲突）
function enqueue(fn, type, timeoutMs = 5 * 60 * 1000) {  // 默认 5 分钟；长任务（批量检查/执行、回写批）传入更长超时
  jobChain = jobChain.then(async () => {
    jobState.running = true;
    jobState.type = type || "任务";
    jobState.startedAt = Date.now();
    jobState.doneAt = null;
    jobState.lastResult = null;   // 新任务开始即清空上一任务的结果，避免旧失败串显
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(type + " 超时（" + Math.round(timeoutMs / 60000) + "分钟）")), timeoutMs));
    try { return await Promise.race([fn(), timeout]); }
    finally { jobState.running = false; jobState.doneAt = Date.now(); }
  }).catch(e => { console.log("[job] 出错: " + e.message); return { ok: false, reason: e.message }; });
  return jobChain;
}

// 自动回写批处理：勾"是"/填反馈不再每条立刻开一个浏览器，
// 而是合并成一次 writeback 进程（--id a,b,c）跑多条记录。
// 批真正开始执行时才取快照，排队期间的新勾选全部并入本批；
// 运行期间的新勾选积累到批结束后自动再起一批。每条记录内部的
// 定位→写入→校验逻辑完全不变。
const WB_BATCH_TIMEOUT = 30 * 60 * 1000;   // 批内可能有多条记录，给足超时
function makeWbBatcher(extraArgs, typeName, opts = {}) {
  let ids = new Set();
  let active = false;
  const run = () => {
    active = true;
    enqueue(async () => {
      try {
        const snapshot = [...ids];   // 批真正开始时才取快照
        ids.clear();
        if (!snapshot.length) return;
        const r = await runScript("writeback.js", ["--id", snapshot.join(","), ...extraArgs], WB_BATCH_TIMEOUT);
        if (opts.dingAuto && dingAutoEnabled()) {
          enqueueDing(async () => { await runScript("notify.js", ["--auto"]); });
        }
        const tail = String(r.stdout || "").split("\n").filter(Boolean).slice(-3);
        console.log("[" + typeName + "批] id=" + snapshot.join(",") + " " + tail.join(" | "));
        if (r.err) console.log("[" + typeName + "批] 进程出错: " + (r.err.message || "").split("\n")[0]);
      } finally {
        active = false;
        if (ids.size) run();   // 运行期间新勾选/新反馈 → 紧接着再起一批
      }
    }, typeName, WB_BATCH_TIMEOUT + 5 * 60 * 1000);
  };
  const mark = (id) => {
    ids.add(Number(id));
    if (!active) run();
  };
  return { mark };
}
const wbBatch = makeWbBatcher(["--confirm"], "回写", { dingAuto: true });
const wbFeedbackBatch = makeWbBatcher(["--feedback", "--confirm"], "回写反馈");

// 从 site-query.js 输出提取真实结果（登录失效时不许报"已完成"）
function queryJobResult(r) {
  const out = String(r.stdout || "");
  const m = out.match(/完成:\s*成功\s*(\d+),\s*查不到\s*(\d+),\s*登录失效\s*(\d+),\s*网络超时\s*(\d+)/);
  if (!m) {
    if (r.err) {
      const errLine = String(r.stderr || "").split("\n").filter(l => l.trim() && !l.includes("ExperimentalWarning") && !l.includes("trace-warnings")).pop();
      return { ok: false, reason: "补全脚本异常: " + (errLine || String(r.err.message || "").split("\n")[0]) };
    }
    return { ok: true };
  }
  const [okN, nfN, loginN, netN] = m.slice(1).map(Number);
  if (okN === 0 && loginN > 0) return { ok: false, reason: "站点登录已失效，一条都没查成——请先重新登录站点再补全" };
  if (okN === 0 && nfN === 0 && loginN === 0 && netN === 0) return { ok: true, summary: "没有需要补全的记录（无待查/待重查行）" };
  return { ok: true, summary: `成功 ${okN}，查不到 ${nfN}，登录失效 ${loginN}，超时 ${netN}` };
}

// 补全类后台任务：结束结果存入 jobState.lastResult，前端轮询可见
function enqueueQuery(args, type) {
  return enqueue(async () => {
    jobState.lastResult = null;
    // 站点登录窗口还开着时严禁启动查询（profile 冲突会崩），等它退出并释放档案
    if (siteLoginProc && siteLoginProc.exitCode === null) {
      await new Promise((resolve) => {
        const to = setTimeout(resolve, 10 * 60 * 1000);
        siteLoginProc.once("exit", () => { clearTimeout(to); resolve(); });
      });
      await new Promise(r => setTimeout(r, 5000));
    }
    const r = await runScript("site-query.js", args);
    jobState.lastResult = queryJobResult(r);
    return jobState.lastResult;
  }, type);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  const t0 = Date.now();
  console.log("[req]", req.method, p);
  try {
    if (p === "/" || p === "/index.html") {
      const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    } else if (p === "/api/config") {
      json(res, 200, {
        talkScripts: config.talkScripts || {},
        specialKeywords: (config.rules && config.rules.specialKeywords) || [],
        periodRule: config.periodRule || {},
      });
    } else if (p === "/api/status") {
      const sm = db.prepare("SELECT query_status, COUNT(*) n FROM complaints GROUP BY query_status").all();
      const map = {}; sm.forEach(x => map[x.query_status] = x.n);
      let dingProgress = null;
      try { dingProgress = JSON.parse(fs.readFileSync(path.join(dataDir, "ding_progress.json"), "utf8")); } catch {}
      json(res, 200, {
        running: jobState.running, type: jobState.type,
        startedAt: jobState.startedAt, doneAt: jobState.doneAt,
        dingRunning: jobState.dingRunning || false,
        lastResult: jobState.lastResult || null, lastPhase: jobState.lastPhase || null,
        batchQueued: jobState.batchQueued || 0,
        total: db.prepare("SELECT COUNT(*) n FROM complaints").get().n,
        records: db.prepare("SELECT COUNT(*) n FROM complaints WHERE is_blank=0").get().n,
        pending: map.pending || 0, filled: map.filled || 0, not_found: map.not_found || 0, special: map.special || 0,
        nfWait: map.nf_wait || 0,
        siteLogin: siteLoginState(),
        tencentLogin: tencentLoginState(),
        dingSent: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='ok'").get().n,
        dingFiltered: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='filtered'").get().n,
        dingFail: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='fail'").get().n,
        dingProgress,
      });
    } else if (p === "/api/stats") {
      const s = db.prepare(`SELECT query_status, COUNT(*) n FROM complaints GROUP BY query_status`).all();
      const p2 = db.prepare(`SELECT processed, COUNT(*) n FROM complaints GROUP BY processed`).all();
      let syncState = {};
      try { syncState = JSON.parse(fs.readFileSync(path.join(dataDir, "sync_state.json"), "utf8")); } catch {}
      json(res, 200, { status: s, processed: p2, total: db.prepare("SELECT COUNT(*) n FROM complaints").get().n, syncState, dingSent: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='ok'").get().n, dingFiltered: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='filtered'").get().n, dingFail: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='fail'").get().n });
    } else if (p === "/api/reset" && req.method === "POST") {
      // 清空前自动备份整库：重置后数据只能靠源表重新同步找回，备份是最后保险
      try {
        // 先 checkpoint 把 WAL 合并进主库文件，再拷贝，保证备份完整
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        const bak = path.join(dataDir, "backup_kehu_" + new Date().toISOString().replace(/[:.]/g, "-") + ".db");
        fs.copyFileSync(path.join(dataDir, "kehu.db"), bak);
      } catch (e) { console.log("[reset] 备份失败，中止清空: " + e.message); return json(res, 500, { ok: false, error: "备份失败，已中止清空: " + e.message }); }
      db.prepare("DELETE FROM complaints").run();
      try { fs.writeFileSync(path.join(dataDir, "sync_state.json"), "{}", "utf8"); } catch {}
      json(res, 200, { ok: true, message: "已清空（清空前已自动备份数据库）" });
    } else if (p === "/api/records") {
      const status = u.searchParams.get("status") || "";
      const sheet = u.searchParams.get("sheet") || "";
      const processed = u.searchParams.get("processed") || "";
      const q = u.searchParams.get("q") || "";
      const limit = Math.min(Number(u.searchParams.get("limit") || 200), 2000);
      const offset = Math.max(Number(u.searchParams.get("offset") || 0), 0);
      let where = "1=1"; const params = [];
      if (status) { where += " AND query_status=?"; params.push(status); }
      if (sheet) { where += " AND sheet=?"; params.push(sheet); }
      if (processed === "是") { where += " AND processed=?"; params.push("是"); }
      else if (processed === "否") { where += " AND (processed='否' OR processed='')"; }
      if (q) { where += " AND (order_no LIKE ? OR customer_info LIKE ? OR category LIKE ?)"; const like = "%" + q + "%"; params.push(like, like, like); }
      const rows = db.prepare(`SELECT * FROM complaints WHERE ${where} ORDER BY CASE WHEN sheet='AI' THEN 0 ELSE 1 END, src_row ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) n FROM complaints WHERE ${where}`).get(...params).n;
      json(res, 200, { rows, total, limit, offset });
    } else if (p === "/api/sync" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const sheet = data.sheet || "AI";
      const startRow = Number(data.startRow || 0);
      if (!startRow) return json(res, 400, { error: "缺少起始行号" });
      // 等待同步完成（约1分钟），返回结果；查询随后台队列继续
      // 同步失败必须如实报错：此前无条件 ok:true，copyFromRow 连续失败崩进程前端仍显示"同步完成"，
      // 用户以为同步好了，实际一行都没入库，查询再报"成功 0"彻底误导排查方向
      const syncResult = await enqueue(async () => {
        const r1 = await runScript("sync.js", ["--sheet", sheet, "--start-row", String(startRow)]);
        const lines = String(r1.stdout || "").split("\n").filter(Boolean);
        const done = lines.find(l => l.includes("同步完成"));
        if (r1.err || !done) {
          const errLine = String(r1.stderr || "").split("\n").filter(l => l.trim() && !l.includes("ExperimentalWarning") && !l.includes("trace-warnings") && !/^Node\.js v/.test(l.trim()) && !l.startsWith("file://") && !/^\s+at /.test(l)).pop();
          return { ok: false, log: lines.slice(-4), err: r1.err ? (errLine || String(r1.err.message || "").split("\n")[0]) : "同步脚本未正常完成（无「同步完成」输出）" };
        }
        return { ok: true, log: lines.slice(-4), err: "" };
      }, "同步");
      json(res, 200, { ok: syncResult.ok !== false, result: syncResult });
      if (syncResult.ok !== false) enqueueQuery(["--sheet", sheet, "--limit", "500"], "查询补全");
    } else if (p === "/api/query" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const sheet = data.sheet || "";
      const args = ["--limit", "500"];
      if (sheet) args.push("--sheet", sheet);
      json(res, 200, { ok: true, message: "查询已开始" });
      enqueueQuery(args, "查询补全");
    } else if (p === "/api/query-one" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const id = Number(data.id);
      if (!id) return json(res, 400, { error: "缺少 id" });
      json(res, 200, { ok: true, message: "补全已开始" });
      enqueueQuery(["--ids", String(id)], "单条补全");
    } else if (p === "/api/query-batch" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const ids = (data.ids || []).map(Number).filter(n => n > 0);
      if (!ids.length) return json(res, 400, { error: "缺少 ids" });
      json(res, 200, { ok: true, message: "补全已开始" });
      enqueueQuery(["--ids", ids.join(",")], "批量补全");
    } else if (p === "/api/process" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const id = Number(data.id);
      if (!id) return json(res, 400, { error: "缺少 id" });
      const now = new Date().toLocaleString("zh-CN");
      db.prepare(`UPDATE complaints SET processed=?, processed_at=?, internal_remark=COALESCE(?, internal_remark) WHERE id=?`)
        .run(data.processed === "是" ? "是" : "否", data.processed === "是" ? now : null, data.remark || null, id);
      // 勾"是" → 入批后由批处理统一回写源表 E/F/G（多条合并为一次浏览器会话）
      if (data.processed === "是" && AUTO_WRITEBACK) {
        wbBatch.mark(id);
      }
      json(res, 200, { ok: true, writeback: (data.processed === "是" && AUTO_WRITEBACK) ? "started" : "none" });
    } else if (p === "/api/delete-batch" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const ids = (data.ids || []).map(Number).filter(n => n > 0);
      if (!ids.length) return json(res, 400, { error: "缺少 ids" });
      const placeholders = ids.map(() => "?").join(",");
      const n = db.prepare(`DELETE FROM complaints WHERE id IN (${placeholders})`).run(...ids).changes;
      json(res, 200, { ok: true, deleted: n });
    } else if (p === "/api/feedback" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const fid = Number(data.id);
      const ftext = String(data.text || "");
      const before = db.prepare(`SELECT feedback_text, processed FROM complaints WHERE id=?`).get(fid);
      db.prepare(`UPDATE complaints SET feedback_text=? WHERE id=?`).run(ftext, fid);
      // 反馈内容有变化 → 入批后由批处理统一回写源表 H/I（AI 表 H / 高表 I）
      const changed = !before || (before.feedback_text || "") !== ftext;
      if (changed && ftext.trim() && AUTO_WRITEBACK) {
        wbFeedbackBatch.mark(fid);
      }
      json(res, 200, { ok: true, writeback: (changed && ftext.trim() && AUTO_WRITEBACK) ? "started" : "none" });
    } else if (p === "/api/writeback-all" && req.method === "POST") {
      // 批量回填：异步执行（避免 HTTP 请求超时），前端轮询 /api/status 取结果
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const sheet = data.sheet || "AI";
      const phase = data.phase === "exec" ? "exec" : "check";
      const pending = db.prepare("SELECT COUNT(*) n FROM complaints WHERE sheet=? AND query_status='pending'").get(sheet).n;
      if (pending > 0) return json(res, 200, { ok: false, needWait: true, pending, phase });
      // 检查是否有同类型任务已在运行
      if (jobState.running && jobState.type && jobState.type.includes("批量回填")) {
        return json(res, 200, { ok: false, reason: "已有批量回填任务在运行，请等待完成" });
      }
      // 清除旧结果，启动异步任务（batchQueued 让前端区分"排队中"与"已完成但无结果"）
      jobState.lastResult = null;
      jobState.lastPhase = phase;
      jobState.batchQueued++;
      enqueue(async () => {
        jobState.batchQueued--;
        const rr = await runScript("writeback.js", ["--batch", "--sheet", sheet, "--phase", phase], 15 * 60 * 1000);
        const out = String(rr.stdout || "");
        const m = out.split("\n").find(l => l.startsWith("__BATCH_JSON__"));
        let result;
        if (m) {
          try { result = JSON.parse(m.slice("__BATCH_JSON__".length)); } catch { result = { ok: false, reason: "批量结果解析失败" }; }
        } else {
          const tail = out.split("\n").filter(Boolean).slice(-5).join(" | ");
          result = { ok: false, reason: (rr.err ? String(rr.err.message || "").split("\n")[0] : "") || tail || "无输出" };
        }
        jobState.lastResult = result;
        if (phase === "exec" && result && result.ok && dingAutoEnabled()) {
          enqueueDing(async () => { await runScript("notify.js", ["--auto"]); });
        }
        return result;
      }, "批量回填" + (phase === "exec" ? "执行" : "检查"), 20 * 60 * 1000);
      json(res, 200, { ok: true, async: true, phase });
    } else if (p === "/api/writeback-selected" && req.method === "POST") {
      // 回填选中：只回填前端勾选的记录（writeback.js --id a,b,c --confirm，E/F/G 逐格写入+校验）
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const ids = [...new Set((Array.isArray(data.ids) ? data.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
      if (!ids.length) return json(res, 200, { ok: false, reason: "未选择任何记录" });
      if (jobState.running && jobState.type && jobState.type.includes("回填选中")) {
        return json(res, 200, { ok: false, reason: "已有回填选中任务在运行，请等待完成" });
      }
      // 待补全的记录期次/手机号可能还是空，回填会把空值写进源表——与批量回填同样的拦截
      const ph = ids.map(() => "?").join(",");
      const pend = db.prepare(`SELECT COUNT(*) n FROM complaints WHERE id IN (${ph}) AND query_status='pending'`).get(...ids).n;
      if (pend > 0) return json(res, 200, { ok: false, reason: `选中的记录里有 ${pend} 条还没查询补全，请先补全后再回填` });
      jobState.lastResult = null;
      jobState.lastPhase = "selected";
      enqueue(async () => {
        const rr = await runScript("writeback.js", ["--id", ids.join(","), "--confirm"], WB_BATCH_TIMEOUT);
        const out = String(rr.stdout || "");
        const m = out.match(/回写完成:\s*成功\s*(\d+),\s*失败\s*(\d+)/);
        let result;
        if (m) {
          const okN = Number(m[1]), failN = Number(m[2]);
          result = (okN + failN) > 0
            ? { ok: failN === 0, okCount: okN, failCount: failN }
            : { ok: false, reason: "没有可回填的记录（可能无订单号）" };
        } else {
          const tail = out.split("\n").filter(Boolean).slice(-5).join(" | ");
          result = { ok: false, reason: (rr.err ? String(rr.err.message || "").split("\n")[0] : "") || tail || "无输出" };
        }
        jobState.lastResult = result;
        if (result.ok && dingAutoEnabled()) {
          enqueueDing(async () => { await runScript("notify.js", ["--auto"]); });
        }
        return result;
      }, "回填选中", WB_BATCH_TIMEOUT + 5 * 60 * 1000);
      json(res, 200, { ok: true, async: true, count: ids.length });
    } else if (p === "/api/talkgenall") {
      // 批量生成/撤销话术：GET 返回状态；POST {on:1/0} 批量设置（仅"有具体助教"的单）
      const QUALIFY = "query_status != 'not_found' AND fill_tutor IS NOT NULL AND fill_tutor != '' AND fill_period IS NOT NULL AND fill_period != '' AND fill_period != '系统未掉落' AND fill_phone IS NOT NULL AND fill_phone != '' AND (fill_tutor NOT LIKE '%爱芯过滤%' AND fill_tutor NOT LIKE '%正价课拦截%') AND (query_remark IS NULL OR (query_remark NOT LIKE '%爱芯过滤%' AND query_remark NOT LIKE '%正价课拦截%')) AND (category IS NULL OR (category NOT LIKE '%爱芯过滤%' AND category NOT LIKE '%正价课拦截%'))";
      if (req.method === "GET") {
        const total = db.prepare("SELECT COUNT(*) n FROM complaints WHERE " + QUALIFY).get().n;
        const generated = db.prepare("SELECT COUNT(*) n FROM complaints WHERE " + QUALIFY + " AND talk_generated=1").get().n;
        json(res, 200, { total, generated, allOn: total > 0 && generated === total });
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      if (data.on) {
        const r = db.prepare("UPDATE complaints SET talk_generated=1 WHERE " + QUALIFY).run();
        json(res, 200, { ok: true, generated: r.changes });
      } else {
        db.prepare("UPDATE complaints SET talk_generated=0").run();
        json(res, 200, { ok: true, generated: 0 });
      }
    } else if (p === "/api/talkgen" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      db.prepare(`UPDATE complaints SET talk_generated=? WHERE id=?`).run(data.on ? 1 : 0, Number(data.id));
      json(res, 200, { ok: true });
    } else if (p === "/api/talk" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      db.prepare(`UPDATE complaints SET talk_script=? WHERE id=?`).run(data.text || "", Number(data.id));
      json(res, 200, { ok: true });
    } else if (p === "/api/remark" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      db.prepare(`UPDATE complaints SET internal_remark=? WHERE id=?`).run(data.remark || "", Number(data.id));
      json(res, 200, { ok: true });
    } else if (p === "/api/ding/status") {
      const bin = await findDwsBin();
      let available = !!bin, loggedIn = false, userName = "";
      if (bin) {
        const r = await runDws(bin, ["auth", "status", "--format", "json"], 15000);
        const out = String(r.stdout || "") + String(r.stderr || "");
        loggedIn = !r.err && authLooksLoggedIn(out);
        if (loggedIn) {
          try { const j = JSON.parse(String(r.stdout || "")); userName = j.user_name || j.userName || ""; } catch {}
        }
      }
      const s = readDingSettings();
      json(res, 200, {
        available,
        loggedIn,
        userName,
        auto: (s.auto === undefined) ? (dingCfg.autoSendOnWriteback !== false) : !!s.auto,
      });
    } else if (p === "/api/site/login" && req.method === "POST") {
      // 站点一键重登：弹出自动化专用 Edge 窗口（login.js），登录态落在 profile + session.json
      if (siteLoginProc && siteLoginProc.exitCode === null) {
        return json(res, 200, { ok: true, message: "站点登录窗口已打开，请在弹出的 Edge 里登录站点" });
      }
      siteLoginProc = spawn(process.execPath, [path.join(ROOT, "src", "login.js")], { cwd: ROOT, stdio: "ignore", windowsHide: true });
      siteLoginProc.on("exit", () => { siteLoginProc = null; });
      json(res, 200, { ok: true, message: "正在打开自动化 Edge 窗口，请在窗口内登录 AI站/高中站，完成后关闭窗口" });
    } else if (p === "/api/tencent/login" && req.method === "POST") {
      // 无头后台打开登录框截图二维码，二维码回传到操作者浏览器，扫码后登录态落在终端 profile
      let body = "";
      for await (const chunk of req) body += chunk;
      let force = false;
      try { force = !!(JSON.parse(body || "{}").force); } catch {}
      // 已登录且非强制重登：秒回「已登录」，不启动浏览器（避免等 9 秒才提示）
      if (!force && tencentLoggedIn()) {
        try { fs.writeFileSync(path.join(dataDir, "qr_state.json"), JSON.stringify({ status: "done", message: "已登录", updatedAt: Date.now() }), "utf8"); } catch {}
        try { fs.unlinkSync(path.join(dataDir, "qr.png")); } catch {}
        return json(res, 200, { ok: true, message: "已登录" });
      }
      if (tencentLoginProc && tencentLoginProc.exitCode === null) {
        if (!force) return json(res, 200, { ok: true, message: "腾讯文档登录进行中，请刷新二维码" });
        try { tencentLoginProc.kill(); } catch {}
        tencentLoginProc = null;
      }
      try { fs.unlinkSync(path.join(dataDir, "qr_state.json")); } catch {}
      try { fs.unlinkSync(path.join(dataDir, "qr.png")); } catch {}
      const args = [path.join(ROOT, "src", "login-qr.js")];
      if (force) args.push("--force");
      const child = spawn(process.execPath, args, {
        cwd: ROOT, stdio: "ignore", windowsHide: true
      });
      child.on("exit", () => { tencentLoginProc = null; });
      child.unref();
      tencentLoginProc = child;
      json(res, 200, { ok: true, message: force ? "正在退出登录并重新生成二维码…" : "正在生成登录二维码…" });
    } else if (p === "/api/tencent/qrcode") {
      const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, "qr_state.json"), "utf8")); } catch { return {}; } })();
      let qr = "";
      try { qr = fs.readFileSync(path.join(dataDir, "qr.png")).toString("base64"); } catch {}
      json(res, 200, { state: state.status || "idle", message: state.message || "", qr: qr ? "data:image/png;base64," + qr : "" });
    } else if (p === "/api/tencent/refresh-qr" && req.method === "POST") {
      // 写刷新标志，login-qr.js 轮询到后重载页面重新生成二维码
      try { fs.writeFileSync(path.join(dataDir, "qr_refresh.flag"), "1", "utf8"); } catch {}
      json(res, 200, { ok: true, message: "正在刷新二维码…" });
    } else if (p === "/api/ding/login" && req.method === "POST") {
      const bin = await findDwsBin();
      if (!bin) return json(res, 200, { ok: false, message: "未检测到 dws，请先安装：npm install -g dingtalk-workspace-cli" });
      // spawn dws 后台轮询，读到验证码后立即返回响应但不 kill 进程
      const safeBin = bin.replace(/\\/g, "/");
      const child = spawn(safeBin, ["auth", "login", "--device", "--no-browser"], { cwd: ROOT, shell: true, windowsHide: true });
      let out = "";
      let sent = false;
      const send = () => {
        if (sent) return;
        const mCode = out.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
        const mUrlWithCode = out.match(/https?:\/\/[^\s]*user_code=[^\s]+/);
        const mUrl = mUrlWithCode || out.match(/https?:\/\/[^\s]+/);
        if (mCode && mUrl) {
          sent = true;
          json(res, 200, { ok: true, device: true, url: mUrl[0], code: mCode[0] });
        }
      };
      let debounce;
      const onData = (d) => { out += String(d); clearTimeout(debounce); debounce = setTimeout(send, 600); };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      // 10s 保护：如果还没匹配到也返回
      setTimeout(() => { if (!sent) { sent = true; try { child.kill(); } catch (e) {} json(res, 200, { ok: false, message: "设备码获取失败" }); } }, 10000);
      // dws 进程继续后台运行直到用户授权完成或超时
	    } else if (p === "/api/ding/logout" && req.method === "POST") {
	      const bin2 = await findDwsBin();
	      if (!bin2) return json(res, 200, { ok: false, message: "未检测到 dws" });
	      const r2 = await runDws(bin2, ["auth", "logout", "-y"], 15000);
	      json(res, 200, { ok: !r2.err, message: r2.err ? (r2.stderr || r2.err.message) : "已退出钉钉登录" });
	    } else if (p === "/api/ding/switch-account" && req.method === "POST") {
		      const bin3 = await findDwsBin();
		      if (!bin3) return json(res, 200, { ok: false, message: "未检测到 dws" });
		      await runDws(bin3, ["auth", "logout", "-y"], 15000);
		      // spawn dws 后台轮询
		      const safeBin3 = bin3.replace(/\\/g, "/");
		      const child3 = spawn(safeBin3, ["auth", "login", "--device", "--no-browser"], { cwd: ROOT, shell: true, windowsHide: true });
		      let out3 = "";
		      let sent3 = false;
		      const send3 = () => {
		        if (sent3) return;
		        const mCode = out3.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
		        const mUrlWithCode = out3.match(/https?:\/\/[^\s]*user_code=[^\s]+/);
		        const mUrl = mUrlWithCode || out3.match(/https?:\/\/[^\s]+/);
		        if (mCode && mUrl) {
		          sent3 = true;
		          json(res, 200, { ok: true, device: true, url: mUrl[0], code: mCode[0] });
		        }
		      };
		      let debounce3;
		      const onData3 = (d) => { out3 += String(d); clearTimeout(debounce3); debounce3 = setTimeout(send3, 600); };
		      child3.stdout.on("data", onData3);
		      child3.stderr.on("data", onData3);
		      setTimeout(() => { if (!sent3) { sent3 = true; try { child3.kill(); } catch (e) {} json(res, 200, { ok: false, message: "切换失败" }); } }, 10000);} else if (p === "/api/ding/settings") {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body || "{}");
        fs.writeFileSync(dingSettingsFile, JSON.stringify({ auto: !!data.auto }, null, 2), "utf8");
        return json(res, 200, { ok: true, auto: !!data.auto });
      }
      const s = readDingSettings();
      json(res, 200, { ok: true, auto: (s.auto === undefined) ? (dingCfg.autoSendOnWriteback !== false) : !!s.auto });
    } else if (p === "/api/ding/send" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const ids = (Array.isArray(data.ids) ? data.ids : []).map(Number).filter(n => n > 0);
      if (!ids.length) return json(res, 400, { error: "缺少要发送的 id" });
      enqueueDing(async () => { await runScript("notify.js", ["--id", ids.join(",")]); });
      json(res, 200, { ok: true, message: "已加入发送队列：" + ids.length + " 条" });
    } else if (p === "/api/ding/send-all" && req.method === "POST") {
      enqueueDing(async () => { await runScript("notify.js", ["--all"]); });
      json(res, 200, { ok: true, message: "已加入发送队列（全部未发/失败的）" });
    } else if (p === "/api/ding/tutor-map") {
      const m = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, "tutor_map.json"), "utf8")); } catch { return {}; } })();
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body || "{}");
        const name = String(data.tutor || "").trim();
        if (name) m[name] = { userId: String(data.userId || ""), openDingTalkId: String(data.openDingTalkId || ""), source: "manual", updatedAt: new Date().toISOString() };
        fs.writeFileSync(path.join(dataDir, "tutor_map.json"), JSON.stringify(m, null, 2), "utf8");
        return json(res, 200, { ok: true, map: m });
      }
      json(res, 200, { ok: true, map: m });
    } else if (p === "/api/send-dingtalk" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const text = String(data.text || "").trim();
      const id = Number(data.id) || 0;
      if (!text) return json(res, 400, { error: "text is required" });
      const webhook = config.dingtalkWebhook;
      if (!webhook) return json(res, 500, { error: "dingtalkWebhook not configured" });
      const payload = JSON.stringify({ msgtype: "markdown", markdown: { title: "客诉转办", text } });
      const u = new URL(webhook);
      const opts = { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) } };
      const nowStr = () => new Date().toLocaleString("zh-CN");
      const hr = https.request(opts, (rr) => { let b = ""; rr.on("data", c => b += c); rr.on("end", () => { try { const j = JSON.parse(b); const ok = j.errcode === 0; if (ok && id) { const rr5 = db.prepare("SELECT fill_period, fill_tutor, writeback_status FROM complaints WHERE id=?").get(id); const isF5 = rr5 && (rr5.fill_period==='系统未掉落' || (rr5.fill_tutor||'').includes('爱芯过滤') || (rr5.fill_tutor||'').includes('正价课拦截')); if (!rr5 || isF5 || rr5.writeback_status==='ok') { db.prepare("UPDATE complaints SET ding_status='ok', ding_msg=?, ding_at=?, processed='是', processed_at=? WHERE id=?").run("已发群消息", nowStr(), nowStr(), id); } else { db.prepare("UPDATE complaints SET ding_status='ok', ding_msg=?, ding_at=? WHERE id=?").run("已发群消息", nowStr(), id); } } json(res, 200, { ok, error: j.errmsg || "" }); } catch (e) { json(res, 200, { ok: false, error: "parse error" }); } }); });
      hr.on("error", (e) => json(res, 200, { ok: false, error: e.message }));
      hr.write(payload);
      hr.end();
    } else if (p === "/api/channel-lib") {
      if (req.method === "GET") {
        const q = (u.searchParams.get("q") || "").trim();
        const channel = (u.searchParams.get("channel") || "").trim();
        let sql = "SELECT id, prod_name, prod_id, channel FROM channel_lib";
        const params = [];
        const conds = [];
        if (q) { conds.push("(prod_name LIKE ? OR prod_id LIKE ?)"); params.push("%" + q + "%", "%" + q + "%"); }
        if (channel) { conds.push("channel = ?"); params.push(channel); }
        if (conds.length) sql += " WHERE " + conds.join(" AND ");
        sql += " ORDER BY id DESC";
        const rows = db.prepare(sql).all(...params);
        const chRows = db.prepare("SELECT channel, COUNT(*) n FROM channel_lib GROUP BY channel ORDER BY n DESC").all();
        json(res, 200, { ok: true, rows, channels: chRows });
      } else if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body || "{}");
        const prodName = String(data.prod_name || "").trim();
        const prodId = String(data.prod_id || "").trim();
        const channel = String(data.channel || "").trim();
        if (!prodName || !prodId || !channel) return json(res, 400, { ok: false, error: "商品名称、商品ID、渠道 不能为空" });
        const dup = db.prepare("SELECT id FROM channel_lib WHERE prod_id=? AND channel=?").get(prodId, channel);
        if (dup) return json(res, 200, { ok: false, error: "该商品ID+渠道已存在" });
        db.prepare("INSERT INTO channel_lib (prod_name, prod_id, channel) VALUES (?,?,?)").run(prodName, prodId, channel);
        json(res, 200, { ok: true });
      } else if (req.method === "DELETE") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const data = JSON.parse(body || "{}");
        const id = Number(data.id) || 0;
        if (!id) return json(res, 400, { ok: false, error: "id is required" });
        db.prepare("DELETE FROM channel_lib WHERE id=?").run(id);
        json(res, 200, { ok: true });
      } else {
        json(res, 405, { error: "method not allowed" });
      }
    } else if (p === "/api/channel-match" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const filePath = String(data.path || "").trim();
      if (!filePath || !fs.existsSync(filePath)) return json(res, 400, { ok: false, error: "文件不存在" });
      const pyScript = path.join(ROOT, "src", "channel_match.py");
      execFile("python", [pyScript, filePath], { cwd: ROOT, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return json(res, 200, { ok: false, error: (stderr || err.message) });
        try {
          const result = JSON.parse(String(stdout || ""));
          json(res, 200, result);
        } catch (e) {
          json(res, 200, { ok: false, error: "解析匹配结果失败" });
        }
      });
    } else if (p === "/api/channel-lib-import" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const filePath = String(data.path || "").trim();
      if (!filePath || !fs.existsSync(filePath)) return json(res, 400, { ok: false, error: "文件不存在" });
      const pyScript = path.join(ROOT, "src", "channel_import.py");
      execFile("python", [pyScript, filePath], { cwd: ROOT, timeout: 180000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return json(res, 200, { ok: false, error: (stderr || err.message) });
        try {
          const result = JSON.parse(String(stdout || ""));
          json(res, 200, result);
        } catch (e) {
          json(res, 200, { ok: false, error: "解析导入结果失败" });
        }
      });
    } else {
      json(res, 404, { error: "not found" });
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(port, () => {
  console.log("本地网页已启动: http://localhost:" + port);
  console.log("按 Ctrl+C 停止");
});
