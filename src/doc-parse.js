// 解析腾讯文档导出的 xlsx：提取 AI 和 高 两个 sheet 的登记数据
import JSZip from "jszip";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import sax from "sax";

const SHARED_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function parseXmlSimple(xml) {
  // 用 sax 解析并返回 { tags: [...], text } 太麻烦；这里实现专门的小解析器
  // 简单方案：直接遍历事件收集
  const parser = sax.parser(true);
  const result = { root: null };
  const stack = [];
  parser.onopentag = (node) => {
    const el = { name: node.name, attrs: node.attributes, children: [], text: "" };
    if (stack.length) stack[stack.length - 1].children.push(el);
    else result.root = el;
    stack.push(el);
  };
  parser.ontext = (t) => { if (stack.length) stack[stack.length - 1].text += t; };
  parser.onclosetag = () => stack.pop();
  parser.write(xml).close();
  return result.root;
}

export async function parseDocXlsx(filePath) {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  // workbook.xml -> sheet names
  const wbXml = await zip.file("xl/workbook.xml").async("string");
  const wb = parseXmlSimple(wbXml);
  const sheets = [];
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const rels = parseXmlSimple(relsXml);
  const relMap = {};
  if (rels && rels.children) {
    for (const r of rels.children) {
      if (r.name === "Relationship") relMap[r.attrs.Id] = r.attrs.Target;
    }
  }
  if (wb && wb.children) {
    for (const sh of wb.children) {
      if (sh.name === "sheets") {
        for (const s of sh.children) {
          if (s.name === "sheet") {
            sheets.push({ name: s.attrs.name, rel: s.attrs["r:id"] });
          }
        }
      }
    }
  }
  // shared strings
  const shared = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    const ssXml = await ssFile.async("string");
    const ss = parseXmlSimple(ssXml);
    if (ss && ss.children) {
      for (const si of ss.children) {
        if (si.name === "si") {
          let txt = "";
          const collect = (el) => {
            if (el.name === "t") txt += el.text || "";
            for (const c of el.children || []) collect(c);
          };
          collect(si);
          shared.push(txt);
        }
      }
    }
  }
  const out = {};
  for (const s of sheets) {
    if (s.name !== "AI" && s.name !== "高") continue;
    let target = relMap[s.rel];
    if (!target) continue;
    let fn = target.startsWith("xl/") ? target : "xl/" + target.replace(/^\//, "");
    if (!fn.endsWith(".xml")) fn += ".xml";
    const file = zip.file(fn);
    if (!file) continue;
    const sheetXml = await file.async("string");
    const root = parseXmlSimple(sheetXml);
    const rows = [];
    const walk = (el) => {
      if (el.name === "row") {
        const rn = Number(el.attrs.r);
        const cells = {};
        for (const c of el.children || []) {
          if (c.name !== "c") continue;
          const ref = c.attrs.r;
          const t = c.attrs.t;
          let val = null;
          const vEl = (c.children || []).find(x => x.name === "v");
          if (t === "s" && vEl) { val = shared[Number(vEl.text)] ?? null; }
          else if (t === "inlineStr") {
            const isEl = (c.children || []).find(x => x.name === "is");
            if (isEl) {
              let txt = "";
              const collect = (e2) => { if (e2.name === "t") txt += e2.text || ""; for (const cc of e2.children || []) collect(cc); };
              collect(isEl);
              val = txt;
            }
          } else if (vEl) { val = vEl.text; }
          if (val !== null) cells[ref] = val;
        }
        rows.push({ rn, cells });
      }
      for (const c of el.children || []) walk(c);
    };
    walk(root);
    out[s.name] = rows;
  }
  return out;
}

// 自测：仅在直接运行时执行（避免 import 时产生副作用）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
// 自测：解析本地 480MB 文件
const p = "C:/Users/EDY/Documents/Codex/2026-08-06/1-excel-2-1-2-3-2/work/自播需求.xlsx";
console.time("parse");
const data = await parseDocXlsx(p);
console.timeEnd("parse");
for (const k of Object.keys(data)) {
  console.log(k, "rows:", data[k].length);
  // 打印表头和前2行
  const r2 = data[k].find(r => r.rn === 2);
  console.log("  header:", Object.entries(r2 ? r2.cells : {}).map(([c,v]) => c+"="+String(v).slice(0,12)).join(" | "));
  const r3 = data[k].find(r => r.rn === 3);
  console.log("  R3:", Object.entries(r3 ? r3.cells : {}).map(([c,v]) => c+"="+String(v).slice(0,20)).join(" | "));
}


}

