// 钉钉通知模块：以"当前 dws 登录人"身份，把客诉消息发给对应顾问（单聊）
// 依赖：dws CLI（钉钉官方，https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli）
//   安装：npm install -g dingtalk-workspace-cli
//   登录：dws auth login（本机浏览器扫码；组织开启 CLI 访问或管理员批准一次）
// 用法：
//   node src/notify.js --id 1,2,3        手动发指定行（可重发）
//   node src/notify.js --all             发所有已生成话术但未发送/发送失败的行
//   node src/notify.js --auto            发所有回填成功且未发送的行（回填后自动模式）
//   node src/notify.js --id 1 --dry-run  只预览，不发送
// 说明：
//   - 每单发送状态写回 complaints.ding_status/ding_at/ding_msg（''=未发 ok=已发送 fail=失败 skip=跳过）
//   - 顾问姓名→钉钉 userId 首次通过 dws 通讯录搜索自动缓存到 data/tutor_map.json，可手动增改
//   - 自动模式用稳定 uuid（ding-auto-<id>）幂等；手动模式带时间戳，重发会真正再发一次
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import config from "../config.json" with { type: "json" };
import { openDb } from "./db.js";

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const db = openDb(dataDir);
const dingCfg = config.dingtalk || {};
const tutorMapFile = path.join(dataDir, "tutor_map.json");
const progressFile = path.join(dataDir, "ding_progress.json");
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : null; }
const IDS = String(arg("id") || "").split(",").map(s => Number(String(s).trim())).filter(n => n > 0);
const MODE = IDS.length ? "ids" : args.includes("--all") ? "all" : args.includes("--auto") ? "auto" : "none";
const DRY_RUN = args.includes("--dry-run");
const TMPL = dingCfg.messageTemplate || "【客诉提醒】订单 {order_no}（{feedback_date}）\n分类：{category}\n客户：{customer_info}\n期次/手机号：{fill_period} / {fill_phone}\n顾问：{fill_tutor}\n话术：{talk_script}";
const nowStr = () => new Date().toLocaleString("zh-CN");

function log(m) { console.log(m); }

function writeProgress(total, done) {
  try { fs.writeFileSync(progressFile, JSON.stringify({ total, done, updatedAt: Date.now() }), "utf8"); } catch (e) {}
}
function clearProgress() {
  try { fs.unlinkSync(progressFile); } catch (e) {}
}

function sendWebhook(text) {
  return new Promise((resolve) => {
    const webhook = config.dingtalkWebhook;
    if (!webhook) return resolve({ ok: false, error: "webhook not configured" });
    const payload = JSON.stringify({ msgtype: "markdown", markdown: { title: "客诉转办", text } });
    const u = new URL(webhook);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) } };
    const hr = https.request(opts, (rr) => { let b = ""; rr.on("data", c => b += c); rr.on("end", () => { try { const j = JSON.parse(b); resolve({ ok: j.errcode === 0, error: j.errmsg || "" }); } catch (e) { resolve({ ok: false, error: "parse error" }); } }); });
    hr.on("error", (e) => resolve({ ok: false, error: e.message }));
    hr.write(payload);
    hr.end();
  });
}

// ---------- dws 定位与调用 ----------
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
// 从 npm 安装的 dws.cmd 解析出真实 JS 入口，以便用 node 直接运行（不经 cmd，参数可完整传递）
function resolveDwsJs(bin) {
  const binDir = path.dirname(bin);
  const pkg = path.join(binDir, "node_modules", "dingtalk-workspace-cli", "package.json");
  try {
    const pj = JSON.parse(fs.readFileSync(pkg, "utf8"));
    const b = pj.bin;
    const rel = typeof b === "string" ? b : (b && (b.dws || b["dingtalk-workspace-cli"] || Object.values(b)[0])) || "";
    if (rel) return path.join(path.dirname(pkg), rel);
  } catch (e) {}
  return "";
}
function runDws(bin, dwsArgs, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const cb = (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    if (!/\.(cmd|bat)$/i.test(bin)) {
      execFile(bin, dwsArgs, { cwd: ROOT, timeout: timeoutMs, windowsHide: true }, cb);
      return;
    }
    const js = resolveDwsJs(bin);
    if (js && fs.existsSync(js)) {
      // 以 node 直接运行 dws 的 JS 入口：不经 cmd/shell，正文中的换行/引号可原样传递
      execFile(process.execPath, [js, ...dwsArgs], { cwd: ROOT, timeout: timeoutMs, windowsHide: true }, cb);
      return;
    }
    // 兜底：cmd/shell 启动（正文含空格/换行可能被拆，发送端应尽量保持单行）
    const child = spawn(bin, dwsArgs, { cwd: ROOT, shell: true, windowsHide: true });
    let stdout = "", stderr = "";
    const to = setTimeout(() => { child.kill(); cb({ message: "dws 调用超时" }, stdout, stderr); }, timeoutMs);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", (e) => { clearTimeout(to); cb(e, stdout, stderr); });
    child.on("close", (code) => { clearTimeout(to); cb(code === 0 ? null : { message: "exit code " + code }, stdout, stderr); });
  });
}
async function authStatus(bin) {
  const r = await runDws(bin, ["auth", "status", "--format", "json"], 15000);
  if (r.err) return { ok: false };
  const out = r.stdout + r.stderr;
  return { ok: authLooksLoggedIn(out) };
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
function collectCandidates(out, arr) {
  try {
    const d = JSON.parse(out);
    (function walk(o) {
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (o && typeof o === "object") {
        if (o.userId || o.openDingTalkId) arr.push(o);
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (Array.isArray(v)) { for (const x of v) walk(x); }
        }
      }
    })(d);
  } catch (e) {}
}
function dedupCands(arr) {
  const out = [];
  const seen = new Set();
  for (const c of arr) {
    const id = c.userId || c.openDingTalkId || "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }
  return out;
}
// 邮箱前缀精确匹配：助教名称 == 候选人邮箱 @ 前的部分（若接口返回邮箱字段）
function pickByEmailPrefix(arr, want) {
  if (!want) return null;
  for (const it of arr) {
    const em = it.orgAuthEmail || it.orgEmail || it.email || it.mail || it.emailAddress || "";
    if (typeof em === "string" && em.includes("@")) {
      const p = em.split("@")[0].trim().toLowerCase();
      if (p && p === want && (it.userId || it.openDingTalkId)) {
        return {
          userId: it.userId || "",
          openDingTalkId: it.openDingTalkId || "",
          name: String(it.name || it.nick || ""),
          email: em,
          emailPrefix: p,
        };
      }
    }
  }
  return null;
}
// 找人优先级：① 候选邮箱字段前缀精确匹配 ② 按"完整邮箱"搜索且唯一（等效邮箱前缀校验，主路径）
//            ③ 按姓名唯一候选 ④ aisearch 兜底 ⑤ 失败不发送。
// 返回 { hit, count }，hit 为 null 表示未确认（调用方不得发送）。
async function findTutorUser(bin, name) {
  const want = String(name || "").trim().toLowerCase();
  const domain = (config.dingtalk && config.dingtalk.emailDomain) || "";
  const searchCands = async (q) => {
    const r = await runDws(bin, ["contact", "user", "search", "--query", q, "--format", "json"], 30000);
    if (r.err) return [];
    const arr = [];
    collectCandidates(r.stdout + r.stderr, arr);
    return dedupCands(arr);
  };
  const cands = await searchCands(name);
  const emailHit = pickByEmailPrefix(cands, want);
  if (emailHit) return { hit: emailHit, count: 1, via: "email" };
  // ② 按完整邮箱搜索：唯一候选即证明"邮箱前缀 == 助教名"
  if (domain) {
    const emailCands = await searchCands(want + "@" + domain);
    if (emailCands.length === 1) {
      const c = emailCands[0];
      return {
        hit: { userId: c.userId || "", openDingTalkId: c.openDingTalkId || "", name: String(c.name || c.nick || ""), email: want + "@" + domain, emailPrefix: want },
        count: 1,
        via: "email-search",
      };
    }
    if (emailCands.length > 1) return { hit: null, count: emailCands.length, via: "email-search" };
  }
  // ③ 按姓名唯一候选
  if (cands.length === 1) {
    const c = cands[0];
    return { hit: { userId: c.userId || "", openDingTalkId: c.openDingTalkId || "", name: String(c.name || c.nick || "") }, count: 1, via: "unique" };
  }
  if (cands.length > 1) return { hit: null, count: cands.length };
  // ④ contact 搜索 0 个 → aisearch 全维度兜底
  const r2 = await runDws(bin, ["aisearch", "person", "--keyword", name, "--dimension", "all", "--format", "json"], 30000);
  if (!r2.err) {
    const c2 = [];
    collectCandidates(r2.stdout + r2.stderr, c2);
    const emailHit2 = pickByEmailPrefix(c2, want);
    if (emailHit2) return { hit: emailHit2, count: 1, via: "email" };
    const u2 = dedupCands(c2);
    if (u2.length === 1) {
      const c = u2[0];
      return { hit: { userId: c.userId || "", openDingTalkId: c.openDingTalkId || "", name: String(c.name || c.nick || "") }, count: 1, via: "unique" };
    }
    if (u2.length > 1) return { hit: null, count: u2.length };
  }
  return { hit: null, count: 0 };
}

// ---------- 顾问映射缓存 ----------
function loadTutorMap() { try { return JSON.parse(fs.readFileSync(tutorMapFile, "utf8")); } catch { return {}; } }
function saveTutorMap(m) { try { fs.writeFileSync(tutorMapFile, JSON.stringify(m, null, 2), "utf8"); } catch (e) { log("映射缓存写入失败: " + e.message); } }

// ---------- 消息 ----------
// 与 web/index.html 的 talkBlock 保持同规则：服务端按配置生成话术，保证"生成后发送"的内容一致
function extractCourse(ci) {
  const lines = String(ci || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
  const re = /(升初一|升初二|升初三|升高一|升高二|升高三|老梦|梦亚|果冻|清北|初一|初二|初三|高一|高二|高三|长期|短期|寒假|暑假|春季|秋季)/;
  const hit = lines.find(l => re.test(l) && !/^\d+$/.test(l) && !/\d{10,}/.test(l));
  return hit ? hit.replace(/\+$/, "").trim() : "";
}
function extractNewContact(ci) {
  const s = String(ci || "");
  const m = s.match(/更换通知方式\s*(\d{6,})/) || s.match(/通知\s*(\d{6,})/);
  return m ? m[1] : "";
}
// 通用提取 11 位手机号（1[3-9] 开头、前后非数字——19 位订单号不会误匹配），取最后一个匹配
function extractPhoneFromText(ci) {
  const ms = [...String(ci || "").matchAll(/(?<!\d)1[3-9]\d{9}(?!\d)/g)];
  return ms.length ? ms[ms.length - 1][0] : "";
}
function extractProblem(ci) {
  const lines = String(ci || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return last.replace(/\+$/, "").trim();
}
function computeTalk(row) {
  const st = row.query_status || "";
  const cat = row.category || "";
  const remark = row.query_remark || "";
  const period = row.fill_period || row.src_period || "";
  const phone = row.fill_phone || row.src_phone || "";
  const tutor = row.fill_tutor || row.src_tutor || "";
  const isNotFound = st === "not_found" || period === "系统未掉落";
  const isSpecial = st === "special" || remark.includes("爱芯过滤") || remark.includes("正价课拦截") || cat.includes("爱芯过滤") || cat.includes("正价课拦截");
  if (isNotFound || isSpecial || !tutor || !period || !phone) return "";
  const oldNote = (config.periodRule && config.periodRule.oldNote) || "二转";
  const isSecond = tutor === oldNote;
  const tmpl = (config.talkScripts || {})[cat];
  if (isSecond) {
    const problem = extractProblem(row.customer_info) || cat;
    return problem + " " + oldNote;
  }
  if (tmpl) {
    let newContact = extractNewContact(row.customer_info);
    // 与 web/index.html 同规则：更换联系方式类，C 列窄正则抓不到时通用提取 11 位手机号；
    // 提取不到或与登记电话一致 → 用哆啦号
    if (cat === "更换通知方式" || cat === "更换联系方式") {
      if (!newContact) newContact = extractPhoneFromText(row.customer_info);
      if (!newContact || newContact === phone) newContact = phone;
    }
    return String(tmpl)
      .replace(/\{期次\}/g, period)
      .replace(/\{电话\}/g, phone)
      .replace(/\{手机号\}/g, phone)
      .replace(/\{课程\}/g, extractCourse(row.customer_info))
      .replace(/\{新联系方式\}/g, newContact);
  }
  return "";
}
function buildText(t) {
  const period = t.fill_period || t.src_period || "";
  const phone = t.fill_phone || t.src_phone || "";
  const tutor = t.fill_tutor || t.src_tutor || "";
  const course = extractCourse(t.customer_info);
  const talk = String(t.talk_script || "") || computeTalk(t);
  const map = {
    "{order_no}": String(t.order_no || ""),
    "{feedback_date}": String(t.feedback_date || ""),
    "{category}": String(t.category || ""),
    "{customer_info}": String(t.customer_info || ""),
    "{fill_period}": period,
    "{fill_phone}": phone,
    "{课程}": course,
    "{tutor}": tutor,
    "{fill_tutor}": tutor,
    "{talk_script}": talk,
    "{src_row}": String(t.src_row || ""),
    "{sheet}": String(t.sheet || ""),
  };
  let s = TMPL;
  for (const k of Object.keys(map)) s = s.split(k).join(map[k]);
  // 去掉空占位留下的空行（如课程缺失时），保留每行内容
  return s.split("\n").map(x => x.trim()).filter(Boolean).join("\n");
}

// ---------- 发送 ----------
// 钉钉服务端有间歇性错误（THREADPOOL_BUSY/HSF 线程池满、超时等，dws 会标 retryable:true），
// 必须自动重试，否则批量发送会出现一批随机失败；uuid 幂等保证重试不会重复投递。
const SEND_ATTEMPTS = 3;
function dwsOutputJson(r) {
  const raw = String(r.stderr || "") + "\n" + String(r.stdout || "");
  const s = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}
function dwsSendOk(r) {
  if (r.err) return false;
  const j = dwsOutputJson(r);
  if (j && j.success === false) return false;
  return true;
}
function isRetryableDws(r) {
  const raw = String(r.stderr || "") + "\n" + String(r.stdout || "") + "\n" + String((r.err && r.err.message) || "");
  if (/调用超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(raw)) return true;
  const j = dwsOutputJson(r);
  if (j) {
    const e = j.error || j;
    if (e.retryable === true) return true;
    const blob = JSON.stringify(j);
    if (/THREADPOOL_BUSY|thread pool|busy|throttl|rate[._ ]?limit|限流|频繁|timeout|超时/i.test(blob)) return true;
  }
  return false;
}
function dwsErrorText(r) {
  const j = dwsOutputJson(r);
  let text;
  if (j) text = (j.error && (j.error.message || j.error.hint || j.error.technical_detail)) || j.errorMsg || j.message || JSON.stringify(j);
  else text = (r.err && r.err.message) || String(r.stderr || r.stdout || "").trim() || "未知错误";
  return String(text).replace(/\s+/g, " ").slice(0, 200);
}
async function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
async function sendMsg(bin, recv, text, uuid) {
  if (!recv.userId && !recv.openDingTalkId) return { err: new Error("没有可用的 userId/openDingTalkId") };
  // userId 通道优先；若服务端报 cannot resolve（tutor_map 缓存的 userId 失效），自动降级 openDingTalkId
  const modes = recv.userId ? ["user", "open"] : ["open"];
  let last = null;
  for (let m = 0; m < modes.length; m++) {
    const useOpen = modes[m] === "open";
    for (let i = 1; i <= SEND_ATTEMPTS; i++) {
      const base = ["chat", "message", "send"];
      if (useOpen) base.push("--open-dingtalk-id", recv.openDingTalkId);
      else base.push("--user", recv.userId);
      base.push("--text", text, "--uuid", uuid, "--format", "json");
      const r1 = await runDws(bin, [...base, "--yes"], 60000);
      if (!r1.err && /unknown (flag|shorthand)/i.test(String(r1.stderr + r1.stdout))) {
        last = await runDws(bin, base, 60000);   // 旧版不接受 --yes 时去掉重试
      } else {
        last = r1;
      }
      if (dwsSendOk(last)) return last;
      const blob = String(last.stderr || "") + String(last.stdout || "") + String((last.err && last.err.message) || "");
      if (!useOpen && /cannot resolve/i.test(blob)) break;   // userId 无效，换通道（不做无谓重试）
      if (i < SEND_ATTEMPTS && isRetryableDws(last)) { await sleep(i * 2000); continue; }
      break;
    }
    if (m === modes.length - 1 || !/cannot resolve/i.test(String(last.stderr || "") + String(last.stdout || "") + String((last.err && last.err.message) || ""))) return last;
  }
  return last;
}

// ---------- 主流程 ----------
const upd = db.prepare("UPDATE complaints SET ding_status=?, ding_msg=?, ding_at=? WHERE id=?");
const updProcessed = db.prepare("UPDATE complaints SET processed='是', processed_at=? WHERE id=?");
async function main() {
  if (MODE === "none") { log("用法：--id 1,2,3 / --all / --auto [--dry-run]"); db.close(); process.exit(1); }
  const bin = await findDwsBin();
  if (!bin) {
    log("未检测到 dws，请先安装：npm install -g dingtalk-workspace-cli（或修改 config.json 的 dingtalk.binPath）");
    db.close(); process.exit(1);
  }
  let targets = [];
  if (MODE === "ids") {
    const ph = IDS.map(() => "?").join(",");
    targets = db.prepare(`SELECT * FROM complaints WHERE id IN (${ph})`).all(...IDS);
  } else if (MODE === "auto") {
    targets = db.prepare(`SELECT * FROM complaints WHERE writeback_status='ok' AND (ding_status IS NULL OR ding_status='') AND fill_tutor IS NOT NULL AND fill_tutor != ''`).all();
  } else if (MODE === "all") {
    // 爱芯过滤/正价课拦截 也选进来，循环里统一标"过滤"（不发送、不算失败）
    targets = db.prepare(`SELECT * FROM complaints WHERE query_status != 'not_found' AND fill_tutor IS NOT NULL AND fill_tutor != '' AND fill_period IS NOT NULL AND fill_period != '' AND fill_period != '系统未掉落' AND fill_phone IS NOT NULL AND fill_phone != '' AND (ding_status IS NULL OR ding_status='' OR ding_status='fail')`).all();
  }
  if (!targets.length) {
    clearProgress();
    log("__DING_JSON__" + JSON.stringify({ ok: true, sent: 0, fail: 0, skipped: 0, reason: "没有待发送的记录" }));
    db.close(); process.exit(0);
  }
  const auth = await authStatus(bin);
  const tutorMap = loadTutorMap();
  let sent = 0, fail = 0, skipped = 0;
  let done = 0;
  const total = targets.length;
  const results = [];
  writeProgress(total, 0);
  // 单条处理（原来是大 for 循环串行；拆出来配合下面的并发池，失败重试逻辑见 sendMsg）
  async function processOne(t) {
    const tutor = String(t.fill_tutor || t.src_tutor || "").trim();
    let searchHint = "";
    if (!tutor) {
      upd.run("skip", "无顾问，跳过", nowStr(), t.id);
      return { kind: "skip", obj: { id: t.id, status: "skip", reason: "无顾问" } };
    }
    const oldNote = (config.periodRule && config.periodRule.oldNote) || "二转";
    // 爱芯过滤（线索已下发、爱芯侧过滤未分配）/ 正价课拦截（线索未下发爱芯）→ 无需通知，
    // 直接标"过滤"，绝不走单聊（fill_tutor 是整段备注，匹配不到联系人会被标"失败"）
    const _ft = String(t.fill_tutor || "");
    const _fb = String((t.query_remark || "") + "|" + (t.category || ""));
    if (_ft.includes("爱芯过滤") || _ft.includes("正价课拦截") || _fb.includes("爱芯过滤") || _fb.includes("正价课拦截")) {
      upd.run("filtered", "爱芯过滤/正价课拦截：线索未下发或被爱芯侧过滤，无需钉钉通知", nowStr(), t.id);
      log(`[${t.id}] ${t.sheet} 单${t.order_no} 过滤单（爱芯过滤/正价课拦截）→ 标记 filtered，不发送`);
      return { kind: "skip", obj: { id: t.id, status: "filtered", reason: "过滤单（爱芯过滤/正价课拦截）" } };
    }
    if (tutor === oldNote) {
      // 二转 → 走 webhook 机器人发群消息
      const text = buildText(t);
      const wr = await sendWebhook(text);
      if (wr.ok) {
        upd.run("ok", "已发群消息（" + tutor + "）", nowStr(), t.id);
        updProcessed.run(nowStr(), t.id);
        log(`[${t.id}] ${t.sheet} 单${t.order_no} 已发群消息（${tutor}）`);
        return { kind: "ok", obj: { id: t.id, status: "ok", reason: "webhook-" + tutor } };
      }
      upd.run("fail", "群消息发送失败：" + (wr.error || ""), nowStr(), t.id);
      log(`[${t.id}] ${t.sheet} 单${t.order_no} 群消息发送失败: ${wr.error}`);
      return { kind: "fail", obj: { id: t.id, status: "fail", reason: "webhook: " + (wr.error || "") } };
    }
    if (!auth.ok) {
      upd.run("fail", "钉钉未登录，请点网页【钉钉登录】或运行 dws auth login", nowStr(), t.id);
      return { kind: "fail", obj: { id: t.id, status: "fail", reason: "钉钉未登录" } };
    }
    // 收件人解析：手动映射优先；自动匹配要求"唯一候选"才算确认（dws 无邮箱字段，无法做邮箱前缀校验）
    let recv = null;
    const cached = tutorMap[tutor];
    if (cached && (cached.userId || cached.openDingTalkId)) {
      recv = cached;
    } else {
      const found = await findTutorUser(bin, tutor);
      recv = found.hit;
      if (recv) {
        tutorMap[tutor] = { userId: recv.userId, openDingTalkId: recv.openDingTalkId, name: recv.name, email: recv.email || "", emailPrefix: recv.emailPrefix || "", source: "auto", updatedAt: new Date().toISOString() };
        saveTutorMap(tutorMap);
      } else {
        searchHint = found.count === 0 ? "未找到任何人" : ("候选 " + found.count + " 人，需手动确认");
      }
    }
    if (!recv || (!recv.userId && !recv.openDingTalkId)) {
      upd.run("fail", "未匹配到顾问（需唯一确认）：" + tutor + "（" + (searchHint || "可在 data/tutor_map.json 手动补充 userId") + "）", nowStr(), t.id);
      return { kind: "fail", obj: { id: t.id, status: "fail", reason: "未确认顾问：" + tutor } };
    }
    const text = buildText(t);
    const uuid = MODE === "auto" ? ("ding-auto-" + t.id) : ("ding-man-" + t.id + "-" + Date.now());
    if (DRY_RUN) {
      log(`[dry-run] id=${t.id} 单${t.order_no} → ${tutor}(${recv.userId || recv.openDingTalkId}) uuid=${uuid}\n` + text);
      return { kind: "dry", obj: null };
    }
    const r = await sendMsg(bin, recv, text, uuid);
    if (!dwsSendOk(r)) {
      const reason = dwsErrorText(r);
      upd.run("fail", "发送失败（重试 " + SEND_ATTEMPTS + " 次后）：" + reason, nowStr(), t.id);
      log(`[${t.id}] 发送失败: ${reason}`);
      return { kind: "fail", obj: { id: t.id, status: "fail", reason } };
    }
    upd.run("ok", "已发送给顾问：" + tutor, nowStr(), t.id);
    const wbRow4 = db.prepare("SELECT writeback_status, fill_period, fill_tutor FROM complaints WHERE id=?").get(t.id);
    const isFilt4 = wbRow4 && (wbRow4.fill_period === '系统未掉落' || (wbRow4.fill_tutor||'').includes('爱芯过滤') || (wbRow4.fill_tutor||'').includes('正价课拦截'));
    if (!wbRow4 || isFilt4 || wbRow4.writeback_status === 'ok') updProcessed.run(nowStr(), t.id);
    log(`[${t.id}] ${t.sheet} 单${t.order_no} 已发送给 ${tutor}`);
    return { kind: "ok", obj: { id: t.id, status: "ok", tutor } };
  }
  // 并发池：每条消息单独起一个 dws 进程（~3s），串行 30+ 条要 5 分钟；3 路并发 + 失败重试
  const CONC = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const t = targets[cursor++];
      const r = await processOne(t);
      if (r.kind === "ok") sent++;
      else if (r.kind === "fail") fail++;
      else if (r.kind === "skip") skipped++;
      if (r.obj) results.push(r.obj);
      done++;
      writeProgress(total, done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, worker));
  clearProgress();
  log("钉钉发送完成: 成功 " + sent + ", 失败 " + fail + ", 跳过 " + skipped);
  log("__DING_JSON__" + JSON.stringify({ ok: fail === 0, sent, fail, skipped, results }));
  db.close();
}
main().catch((e) => { log("notify 出错: " + e.message); db.close(); process.exit(1); });
