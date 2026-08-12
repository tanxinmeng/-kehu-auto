// M4: 本地网页服务器（内部处理表 + 手动同步按钮 + 勾选是否处理 + 备注）
// 注意：同步/查询都用同一个 Edge 配置，必须串行执行（jobQueue），否则会互抢配置文件
import http from "node:http";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import config from "../config.json" with { type: "json" };
import { openDb } from "./db.js";

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const db = openDb(dataDir);
const port = config.web.port || 8766;
const dingCfg = config.dingtalk || {};
const dingSettingsFile = path.join(dataDir, "ding_settings.json");
function readDingSettings() { try { return JSON.parse(fs.readFileSync(dingSettingsFile, "utf8")); } catch { return {}; } }
function dingAutoEnabled() {
  if (dingCfg.enabled === false) return false;
  const s = readDingSettings();
  return (s.auto === undefined) ? (dingCfg.autoSendOnWriteback !== false) : !!s.auto;
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
    execFile(process.execPath, [path.join(ROOT, "src", script), ...args], { cwd: ROOT, timeout: timeoutMs },
      (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
  });
}

// 浏览器任务队列：同步/查询/回写 串行
let jobChain = Promise.resolve();
const jobState = { running: false, type: "", startedAt: null, doneAt: null };
function enqueue(fn, type) {
  const JOB_TIMEOUT = 5 * 60 * 1000;  // 单个任务最长 5 分钟，防止卡死阻塞队列
  jobChain = jobChain.then(async () => {
    jobState.running = true;
    jobState.type = type || "任务";
    jobState.startedAt = Date.now();
    jobState.doneAt = null;
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(type + " 超时（5分钟）")), JOB_TIMEOUT));
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
          enqueue(async () => { await runScript("notify.js", ["--auto"]); }, "钉钉自动发送");
        }
        const tail = String(r.stdout || "").split("\n").filter(Boolean).slice(-3);
        console.log("[" + typeName + "批] id=" + snapshot.join(",") + " " + tail.join(" | "));
        if (r.err) console.log("[" + typeName + "批] 进程出错: " + (r.err.message || "").split("\n")[0]);
      } finally {
        active = false;
        if (ids.size) run();   // 运行期间新勾选/新反馈 → 紧接着再起一批
      }
    }, typeName);
  };
  const mark = (id) => {
    ids.add(Number(id));
    if (!active) run();
  };
  return { mark };
}
const wbBatch = makeWbBatcher(["--confirm"], "回写", { dingAuto: true });
const wbFeedbackBatch = makeWbBatcher(["--feedback", "--confirm"], "回写反馈");

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
      json(res, 200, {
        running: jobState.running, type: jobState.type,
        startedAt: jobState.startedAt, doneAt: jobState.doneAt,
        lastResult: jobState.lastResult || null, lastPhase: jobState.lastPhase || null,
        total: db.prepare("SELECT COUNT(*) n FROM complaints").get().n,
        records: db.prepare("SELECT COUNT(*) n FROM complaints WHERE is_blank=0").get().n,
        pending: map.pending || 0, filled: map.filled || 0, not_found: map.not_found || 0, special: map.special || 0,
        dingSent: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='ok'").get().n,
        dingFail: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='fail'").get().n,
      });
    } else if (p === "/api/stats") {
      const s = db.prepare(`SELECT query_status, COUNT(*) n FROM complaints GROUP BY query_status`).all();
      const p2 = db.prepare(`SELECT processed, COUNT(*) n FROM complaints GROUP BY processed`).all();
      let syncState = {};
      try { syncState = JSON.parse(fs.readFileSync(path.join(dataDir, "sync_state.json"), "utf8")); } catch {}
      json(res, 200, { status: s, processed: p2, total: db.prepare("SELECT COUNT(*) n FROM complaints").get().n, syncState, dingSent: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='ok'").get().n, dingFail: db.prepare("SELECT COUNT(*) n FROM complaints WHERE ding_status='fail'").get().n });
    } else if (p === "/api/reset" && req.method === "POST") {
      db.prepare("DELETE FROM complaints").run();
      try { fs.writeFileSync(path.join(dataDir, "sync_state.json"), "{}", "utf8"); } catch {}
      json(res, 200, { ok: true, message: "????????" });
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
      const syncResult = await enqueue(async () => {
        const r1 = await runScript("sync.js", ["--sheet", sheet, "--start-row", String(startRow)]);
        const lines = String(r1.stdout || "").split("\n").filter(Boolean);
        return { log: lines.slice(-4), err: r1.err ? r1.err.message : "" };
      }, "同步");
      json(res, 200, { ok: true, result: syncResult });
      enqueue(async () => { await runScript("site-query.js", ["--sheet", sheet, "--limit", "500"]); }, "查询补全");
    } else if (p === "/api/query" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || "{}");
      const sheet = data.sheet || "";
      const args = ["--limit", "500"];
      if (sheet) args.push("--sheet", sheet);
      json(res, 200, { ok: true, message: "查询已开始" });
      enqueue(async () => { await runScript("site-query.js", args); }, "查询补全");
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
      // 清除旧结果，启动异步任务
      jobState.lastResult = null;
      jobState.lastPhase = phase;
      enqueue(async () => {
        const rr = await runScript("writeback.js", ["--batch", "--sheet", sheet, "--phase", phase]);
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
          enqueue(async () => { await runScript("notify.js", ["--auto"]); }, "钉钉自动发送");
        }
        return result;
      }, "批量回填" + (phase === "exec" ? "执行" : "检查"));
      json(res, 200, { ok: true, async: true, phase });
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
      let available = !!bin, loggedIn = false;
      if (bin) {
        const r = await runDws(bin, ["auth", "status", "--format", "json"], 15000);
        const out = String(r.stdout || "") + String(r.stderr || "");
        loggedIn = !r.err && authLooksLoggedIn(out);
      }
      const s = readDingSettings();
      json(res, 200, {
        available,
        loggedIn,
        auto: (s.auto === undefined) ? (dingCfg.autoSendOnWriteback !== false) : !!s.auto,
      });
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
      enqueue(async () => { await runScript("notify.js", ["--id", ids.join(",")]); }, "钉钉发送");
      json(res, 200, { ok: true, message: "已加入发送队列：" + ids.length + " 条" });
    } else if (p === "/api/ding/send-all" && req.method === "POST") {
      enqueue(async () => { await runScript("notify.js", ["--all"]); }, "钉钉发送全部");
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
