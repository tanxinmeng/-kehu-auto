// M3: 内部网站查询补全（期次/手机号/顾问）
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import config from "../config.json" with { type: "json" };
import { openDb } from "./db.js";
import { currentPeriodLabel, periodsBeforeCurrent } from "./period.js";

const ROOT = process.cwd();
const dataDir = path.join(ROOT, config.dataDir || "data");
const sessionFile = path.join(dataDir, "session.json");
const logFile = path.join(dataDir, "sync.log");
function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN")}] ${msg}`;
  console.log(line);
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(logFile, line + "\n"); } catch {}
}

function cleanProfileLock() {
  const profileDir = path.resolve(ROOT, config.profileDir);
  const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "Lockfile"];
  for (const f of lockFiles) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch {}
  }
}

// 结果表列顺序（已用实验确认）
const COL = ["id","created","assigned","period","plan","channel","biz","product","type","c1","c2","platform","grade","nick","unionid","phone","vphone","order","tutor","tutor_wx","remark"];

async function readResultTable(page) {
  return await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    if (!tables.length) return { ok: false, body: (document.body.innerText || "").slice(0, 200) };
    const t = tables[tables.length - 1];
    const rows = Array.from(t.querySelectorAll("tr")).map(tr =>
      Array.from(tr.querySelectorAll("th,td")).map(c => (c.innerText || "").replace(/\s+/g, " ").trim())
    ).filter(r => r.some(x => x !== ""));
    return { ok: true, rows, url: location.href };
  });
}

async function searchOnPage(page, orderNo) {
  const input = page.getByPlaceholder("订单号").first();
  await input.waitFor({ state: "visible", timeout: 15000 });
  await input.fill(String(orderNo));
  await page.waitForTimeout(400);
  const btn = page.getByRole("button", { name: "搜索", exact: true });
  await btn.click();
  // 固定 3.5s 在站点卡顿时会读到未渲染完的空表 → 误判"查不到"（错误写"系统未掉落"）。
  // 改为：等网络空闲后读表，命中目标订单立即返回；连续两轮读表结果一致才认定"确实没有"。
  const want = String(orderNo);
  let prev = "", emptyStreak = 0;
  for (let i = 0; i < 8; i++) {
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    // networkidle 可能在搜索请求发出前就空闲，读表前固定等一下让站点渲染
    await page.waitForTimeout(1200);
    const res = await readResultTable(page);
    if (res.ok && res.rows.some(r => r.includes(want))) return res;
    // 站点点击搜索后会先闪"暂无数据"再渲染真实结果，所以必须连续两轮都是空态才算查不到
    const emptyTip = await page.evaluate(() => (document.body.innerText || "").includes("暂无数据")).catch(() => false);
    emptyStreak = emptyTip ? emptyStreak + 1 : 0;
    if (emptyStreak >= 2) return res;
    const sig = JSON.stringify(res.rows || []);
    if (sig && sig === prev && i >= 3) return res;
    prev = sig;
    await page.waitForTimeout(800);
  }
  return await readResultTable(page);
}

async function ensureSite(page, siteKey) {
  const site = config.sites[siteKey];
  const clueMarker = "#/clue/index";
  const cur = await page.url();
  if (cur.includes(site.host) && cur.includes(clueMarker) && (await page.getByPlaceholder("订单号").count()) > 0) return;
  // 导航一次，耐心等待 SSO 落地（不打断）
  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    let curUrl = ""; try { curUrl = page.url(); } catch {}
    if (curUrl.includes("login.dingtalk.com")) throw new Error("LOGIN_REQUIRED:" + curUrl.slice(0, 100));
    throw new Error("PAGE_TIMEOUT:" + String(e.message || e).split("\n")[0].slice(0, 150));
  }
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(1000);
    const u = await page.url();
    if (u.includes(site.host) && u.includes(clueMarker) && (await page.getByPlaceholder("订单号").count()) > 0) return;
    if (u.includes("login.dingtalk.com")) throw new Error("LOGIN_REQUIRED:" + u.slice(0, 100));
  }
  const finalUrl = (await page.url()).slice(0, 100);
  if (finalUrl.includes("login.dingtalk.com")) throw new Error("LOGIN_REQUIRED:" + finalUrl);
  throw new Error("PAGE_TIMEOUT:" + finalUrl + " (页面未出现订单号搜索框，可能是网络慢或站点异常)");
}

// 页面会话内直接调列表接口（鉴权走 cookie），无渲染竞态。
// 根因：页面 UI 点击搜索后会先闪"暂无数据"再渲染结果，时序不稳，曾三次把能查到的单误判成"系统未掉落"。
function apiPath(siteKey) {
  return siteKey === "aiDuola" ? "/prod-api/flowtracker-yy-ai/clue/info/list" : "/prod-api/flowtracker-yy/clue/info/list";
}

async function queryOrderApi(page, siteKey, orderNo) {
  return await page.evaluate(async ({ p, orderNo }) => {
    try {
      const resp = await fetch(p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickName: "", nickNames: [], mobile: "", mobiles: [], orderNo: String(orderNo), virtualMobile: "", orderNos: [String(orderNo)], virtualMobiles: [], current: 1, size: 10, recordId: "", recordIds: [] })
      });
      const j = await resp.json();
      if (j.code !== "000000") return { ok: false, msg: j.mesg || resp.status };
      return { ok: true, rows: j.data || [] };
    } catch (e) { return { ok: false, msg: String(e).slice(0, 120) }; }
  }, { p: apiPath(siteKey), orderNo });
}

async function queryOrder(page, siteKey, orderNo) {
  try {
    await ensureSite(page, siteKey);
  } catch (e) {
    const emsg = String(e.message || e);
    if (emsg.startsWith("LOGIN_REQUIRED")) return { loginRequired: true };
    if (emsg.startsWith("PAGE_TIMEOUT") || emsg.includes("ERR_CONNECTION") || emsg.includes("ERR_TIMED_OUT") || emsg.includes("net::ERR_")) return { pageTimeout: true, msg: emsg.split("\n")[0].slice(0, 200) };
    throw e;
  }
  const url0 = await page.url();
  if (url0.includes("login.dingtalk.com")) return { loginRequired: true };
  // 首选直接调接口
  const api = await queryOrderApi(page, siteKey, orderNo);
  if (api.ok) {
    for (const row of api.rows) {
      if (String(row.orderNo) === String(orderNo)) {
        return { found: true, rec: { period: row.serverTerm || "", phone: row.mobile || "", tutor: row.clueTeacherUserName || "", remark: row.remark || "" } };
      }
    }
    return { found: false };
  }
  // 接口异常（鉴权/接口变更/站点抖动）→ 回退页面搜索
  log(`[${orderNo}] @${siteKey} 接口查询异常(${api.msg})，回退页面搜索`);
  const res = await searchOnPage(page, orderNo);
  if (!res.ok) return { found: false, loginRequired: res.url && res.url.includes("login.dingtalk.com"), apiError: true };
  for (const row of res.rows) {
    const rec = {};
    COL.forEach((k, i) => rec[k] = row[i] !== undefined ? row[i] : "");
    if (rec.order === String(orderNo)) return { found: true, rec };
  }
  return { found: false, apiError: true };
}

// 规则：期次/手机号/顾问
// 业务规则：能查到且 期次/电话/助教 均无误时，若订单期次比当前期旧超过 periodRule.oldThreshold 期（5期及以上），
// 助教栏写 periodRule.oldNote（默认"二转"），不写原助教；特殊单（爱芯过滤/正价课拦截）保留原说明。
function applyRules(rec) {
  const rawPeriod = (rec.period || "").trim();
  let fillPeriod = rawPeriod;
  if (/^\d{8}$/.test(rawPeriod)) {
    const year = rawPeriod.slice(0, 4);
    fillPeriod = year === String(new Date().getFullYear()) ? rawPeriod.slice(4) : rawPeriod;
  }
  const remark = (rec.remark || "").trim();
  const special = config.rules.specialKeywords.some(k => remark.includes(k));
  const rawTutor = (rec.tutor || "").trim();
  let fillTutor = special ? remark : rawTutor;
  // 二转规则：非特殊单 + 期次/电话/助教齐全 + 期次比当前期旧超过阈值
  const pr = config.periodRule;
  if (!special && pr && pr.enabled !== false && fillPeriod && (rec.phone || "").trim() && rawTutor) {
    const cur = currentPeriodLabel(new Date(), pr);
    const back = cur ? periodsBeforeCurrent(fillPeriod, cur) : null;
    if (back !== null && back > Number(pr.oldThreshold || 4)) {
      fillTutor = String(pr.oldNote || "二转");
    }
  }
  return { fillPeriod, fillPhone: (rec.phone || "").trim(), fillTutor, special, remark };
}

// 参数
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : null; }
const limit = Number(arg("limit") || 30);
const rowsFilter = arg("rows");       // "10858-10869"
const sheetFilter = arg("sheet");     // AI / 高
const idsFilter = arg("ids");         // "1,2,3" 指定 id 强制补全（绕过 query_status 过滤）

if (!fs.existsSync(sessionFile)) { log("未找到会话快照，请先运行 start-login.bat"); process.exit(1); }

const db = openDb(dataDir);
const REQUERY_HOURS = 2;
let where, params;
if (idsFilter) {
  const ids = idsFilter.split(",").map(Number).filter(n => n > 0);
  if (!ids.length) { log("无效的 ids 参数"); process.exit(0); }
  where = "id IN (" + ids.map(() => "?").join(",") + ")";
  params = [...ids];
} else {
  where = "(query_status = 'pending' OR (query_status = 'query_fail' AND query_updated_at < ?) OR (query_status = 'query_fail' AND query_remark LIKE '%站点波动%' AND query_updated_at < ?) OR (query_status = 'not_found' AND (query_updated_at IS NULL OR query_updated_at < ?)))";
  const requeryThreshold = Date.now() - REQUERY_HOURS * 3600 * 1000;
  const requeryFast = Date.now() - 10 * 60 * 1000;   // 站点波动导致的失败 10 分钟后即可重查（波动一般 1~2 分钟）
  params = [requeryThreshold, requeryFast, requeryThreshold];
  if (rowsFilter) {
    const [a, b] = rowsFilter.split("-").map(Number);
    where += " AND src_row BETWEEN ? AND ?"; params.push(a, b || a);
  }
  if (sheetFilter) { where += " AND sheet = ?"; params.push(sheetFilter); }
}
const orders = db.prepare(`SELECT * FROM complaints WHERE ${where} ORDER BY id${idsFilter ? "" : " LIMIT ?"}`).all(...(idsFilter ? params : [...params, limit]));
log(`待处理 ${orders.length} 条${idsFilter ? "（ids 指定）" : "（limit=" + limit + "）"}`);

cleanProfileLock();
await new Promise(r => setTimeout(r, 1000));
const ctx = await chromium.launchPersistentContext(config.profileDir, { channel: "msedge", headless: true });
const state = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
if (state.cookies?.length) await ctx.addCookies(state.cookies);
const page = await ctx.newPage();
if (process.env.QRY_DEBUG) {
  const dbg = [];
  page.on('request', req => { if (req.url().includes('clue/info/list')) dbg.push(new Date().toISOString().slice(11, 23) + ' REQ ' + (req.postData() || '').slice(0, 220)); });
  page.on('response', async resp => {
    if (resp.url().includes('clue/info/list')) {
      try { const t = await resp.text(); dbg.push(new Date().toISOString().slice(11, 23) + ' RESP len=' + t.length + ' ' + t.slice(0, 180).replace(/\s+/g, ' ')); } catch {}
    }
  });
  setInterval(() => { if (dbg.length) { try { fs.appendFileSync(path.join(dataDir, "query_net.log"), dbg.splice(0).join("\n") + "\n"); } catch {} } }, 2000);
}

let currentSite = null;
let ok = 0, notFound = 0, loginFail = 0, netFail = 0, skipNoOrder = 0;
	const siteBySheet = config.sheetSite;
	const allSites = Object.keys(config.sites).filter(k => k !== "tencentDoc");
	const updNoOrder = db.prepare("UPDATE complaints SET query_status='no_order', query_remark='源表无订单号', query_updated_at=? WHERE id=?");
	const upd = db.prepare(`UPDATE complaints SET fill_period=COALESCE(NULLIF(?,''), fill_period), fill_phone=COALESCE(NULLIF(?,''), fill_phone), fill_tutor=COALESCE(NULLIF(?,''), fill_tutor), query_status=?, query_site=?, query_remark=?, processed=processed, query_updated_at=? WHERE id=?`);
	const updFail = db.prepare("UPDATE complaints SET query_status='query_fail', query_remark=?, query_updated_at=? WHERE id=?");

	// 按优先级排列站点：对应主站最前，其他站点依次兜底
	function orderedSites(sheet) {
	  const primary = siteBySheet[sheet];
	  const others = allSites.filter(s => s !== primary);
	  return [primary, ...others];
	}

	// 对照单（金丝雀）：站点会间歇性抖动（接口返回 HTML 错误页或批量空结果，持续 1~2 分钟），
	// 此时"查不到"不可信。判 not_found 前先查一条刚成功过的订单，对照也查不到 → query_fail 稍后重查。
	let canary = null;
	function pickCanary(excludeOrderNo) {
	  const row = db.prepare("SELECT order_no, query_site FROM complaints WHERE query_status IN ('filled','special') AND order_no IS NOT NULL AND order_no != '' AND order_no != ? ORDER BY query_updated_at DESC LIMIT 1").get(String(excludeOrderNo || ""));
	  if (!row) return null;
	  const site = row.query_site && row.query_site !== "multi" && allSites.includes(row.query_site) ? row.query_site : (siteBySheet["高"] || allSites[0]);
	  return { orderNo: row.order_no, site, checkedAt: 0, ok: false };
	}
	async function canaryHealthy() {
	  if (!canary) canary = pickCanary(null);
	  if (!canary) return true;  // 库里没有已查到的单可对照（如首次运行），只能信任查询结果
	  if (Date.now() - canary.checkedAt < 30000) return canary.ok;
	  const c = await queryOrder(page, canary.site, canary.orderNo);
	  canary.checkedAt = Date.now();
	  canary.ok = !!c.found;
	  if (!canary.ok) log(`对照单 ${canary.orderNo} @${canary.site} 也查不到 → 站点处于异常波动期`);
	  return canary.ok;
	}

	for (const o of orders) {
	  if (!o.order_no) { skipNoOrder++; updNoOrder.run(Date.now(), o.id); log(`[${o.id}] 无订单号，跳过查询 → 标记为 no_order`); continue; }
	  const sites = orderedSites(o.sheet);
	  let foundRec = null, foundSite = null;
	  let thisNetFail = 0;
	  for (const site of sites) {
	    const r = await queryOrder(page, site, o.order_no);
	    if (r.loginRequired) { log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} @${site} 登录失效`); loginFail++; break; }
	    if (r.pageTimeout) { log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} @${site} 超时，尝试下一站...`); netFail++; thisNetFail++; continue; }
	    if (r.found) { foundRec = r.rec; foundSite = site; canary = { orderNo: o.order_no, site: foundSite, checkedAt: Date.now(), ok: true }; break; }
	    // 该站没查到，尝试下一个站点
	  }
	  if (loginFail) break;  // 登录失效才终止全部
	  if (foundRec) {
	    const rules = applyRules(foundRec);
	    upd.run(rules.fillPeriod, rules.fillPhone, rules.fillTutor, rules.special ? "special" : "filled", foundSite, rules.remark, Date.now(), o.id);
	    ok++;
	    log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} @${foundSite} → 期次${rules.fillPeriod} 手机${rules.fillPhone} 顾问${(rules.fillTutor || "").slice(0, 20)} ${rules.special ? "[特殊]" : ""}`);
	  } else if (thisNetFail >= sites.length) {
	    // 该记录所有站点都超时
	    updFail.run("所有站点网络超时或不可用", Date.now(), o.id);
	    log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} 全部站点不可用 → query_fail (稍后重试)`);
	  } else {
	    // 都查不到：先对照校验，站点异常时绝不写"系统未掉落"
	    // 接口报错本身不能证明是站点波动（可能是该订单号触发的个别错误）——以对照单结果为准
	    const healthy = await canaryHealthy();
	    if (!healthy) {
	      updFail.run("站点波动/接口异常(对照校验未通过)，稍后自动重查", Date.now(), o.id);
	      log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} 站点异常 → query_fail (不写系统未掉落，稍后重查)`);
	    } else {
	      upd.run(config.rules.notFoundPeriod, "", "", "not_found", "multi", "", Date.now(), o.id);
	      notFound++;
	      log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} 多站查不到 → 系统未掉落`);
	    }
	  }
	  await page.waitForTimeout(600);
	}

await ctx.close().catch(() => {});
const queryFail = db.prepare("SELECT COUNT(*) n FROM complaints WHERE query_status='query_fail'").get().n;
log(`完成: 成功 ${ok}, 查不到 ${notFound}, 登录失效 ${loginFail}, 网络超时 ${netFail}, 站点全挂暂存 ${queryFail}, 无订单号跳过 ${skipNoOrder}`);
db.close();






