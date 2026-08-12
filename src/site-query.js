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
  await page.waitForTimeout(3500);
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
  const res = await searchOnPage(page, orderNo);
  if (!res.ok) return { found: false, loginRequired: res.url && res.url.includes("login.dingtalk.com") };
  for (const row of res.rows) {
    const rec = {};
    COL.forEach((k, i) => rec[k] = row[i] !== undefined ? row[i] : "");
    if (rec.order === String(orderNo)) return { found: true, rec };
  }
  return { found: false };
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

if (!fs.existsSync(sessionFile)) { log("未找到会话快照，请先运行 start-login.bat"); process.exit(1); }

const db = openDb(dataDir);
const REQUERY_HOURS = 2;
let where = "(query_status = 'pending' OR (query_status = 'query_fail' AND query_updated_at < ?) OR (query_status = 'not_found' AND (query_updated_at IS NULL OR query_updated_at < ?)))";
const requeryThreshold = Date.now() - REQUERY_HOURS * 3600 * 1000;
const params0 = [requeryThreshold, requeryThreshold];
const params = params0;
if (rowsFilter) {
  const [a, b] = rowsFilter.split("-").map(Number);
  where += " AND src_row BETWEEN ? AND ?"; params.push(a, b || a);
}
if (sheetFilter) { where += " AND sheet = ?"; params.push(sheetFilter); }
const orders = db.prepare(`SELECT * FROM complaints WHERE ${where} ORDER BY id LIMIT ?`).all(...params, limit);
log(`待处理 ${orders.length} 条（limit=${limit}）`);

cleanProfileLock();
await new Promise(r => setTimeout(r, 1000));
const ctx = await chromium.launchPersistentContext(config.profileDir, { channel: "msedge", headless: true });
const state = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
if (state.cookies?.length) await ctx.addCookies(state.cookies);
const page = await ctx.newPage();

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

	for (const o of orders) {
	  if (!o.order_no) { skipNoOrder++; updNoOrder.run(Date.now(), o.id); log(`[${o.id}] 无订单号，跳过查询 → 标记为 no_order`); continue; }
	  const sites = orderedSites(o.sheet);
	  let foundRec = null, foundSite = null;
	  let thisNetFail = 0;
	  for (const site of sites) {
	    const r = await queryOrder(page, site, o.order_no);
	    if (r.loginRequired) { log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} @${site} 登录失效`); loginFail++; break; }
	    if (r.pageTimeout) { log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} @${site} 超时，尝试下一站...`); netFail++; thisNetFail++; continue; }
	    if (r.found) { foundRec = r.rec; foundSite = site; break; }
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
	    // 站点可用但都查不到该订单
	    upd.run(config.rules.notFoundPeriod, "", "", "not_found", "multi", "", Date.now(), o.id);
	    notFound++;
	    log(`[${o.id}] ${o.sheet}行${o.src_row} 订单${o.order_no} 多站查不到 → 系统未掉落`);
	  }
	  await page.waitForTimeout(600);
	}

await ctx.close().catch(() => {});
const queryFail = db.prepare("SELECT COUNT(*) n FROM complaints WHERE query_status='query_fail'").get().n;
log(`完成: 成功 ${ok}, 查不到 ${notFound}, 登录失效 ${loginFail}, 网络超时 ${netFail}, 站点全挂暂存 ${queryFail}, 无订单号跳过 ${skipNoOrder}`);
db.close();






