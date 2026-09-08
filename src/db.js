// SQLite 数据库（node:sqlite 内置）：内部处理表
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "kehu.db"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet TEXT NOT NULL,
      src_row INTEGER,
      feedback_date TEXT,
      customer_info TEXT,
      order_no TEXT,
      category TEXT,
      src_period TEXT,
      src_phone TEXT,
      src_tutor TEXT,
      fill_period TEXT,
      fill_phone TEXT,
      fill_tutor TEXT,
      query_status TEXT DEFAULT 'pending',
      query_site TEXT,
      query_remark TEXT,
      processed TEXT DEFAULT '',
      processed_at TEXT,
      internal_remark TEXT,
      created_at TEXT,
      date_key INTEGER,
      src_feedback TEXT,
      feedback_text TEXT,
      query_updated_at INTEGER,
      writeback_status TEXT DEFAULT '',
      writeback_msg TEXT,
      writeback_at TEXT,
      talk_script TEXT,
      talk_generated INTEGER DEFAULT 0,
      dedup_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_complaints_sheet ON complaints(sheet);
    CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(query_status);
  `);
  // 迁移：老库补充 date_key 列
  const cols = db.prepare("PRAGMA table_info(complaints)").all();
  if (!cols.some(c => c.name === "date_key")) {
    db.exec("ALTER TABLE complaints ADD COLUMN date_key INTEGER");
  }
  if (!cols.some(c => c.name === "src_feedback")) {
    db.exec("ALTER TABLE complaints ADD COLUMN src_feedback TEXT");
  }
  if (!cols.some(c => c.name === "feedback_text")) {
    db.exec("ALTER TABLE complaints ADD COLUMN feedback_text TEXT");
  }
  if (!cols.some(c => c.name === "query_updated_at")) {
    db.exec("ALTER TABLE complaints ADD COLUMN query_updated_at INTEGER");
  }
  if (!cols.some(c => c.name === "writeback_status")) {
    db.exec("ALTER TABLE complaints ADD COLUMN writeback_status TEXT DEFAULT ''");
  }
  if (!cols.some(c => c.name === "writeback_msg")) {
    db.exec("ALTER TABLE complaints ADD COLUMN writeback_msg TEXT");
  }
  if (!cols.some(c => c.name === "writeback_at")) {
    db.exec("ALTER TABLE complaints ADD COLUMN writeback_at TEXT");
  }
  if (!cols.some(c => c.name === "talk_script")) {
    db.exec("ALTER TABLE complaints ADD COLUMN talk_script TEXT");
  }
  if (!cols.some(c => c.name === "talk_generated")) {
    db.exec("ALTER TABLE complaints ADD COLUMN talk_generated INTEGER DEFAULT 0");
  }
  if (!cols.some(c => c.name === "is_blank")) {
    db.exec("ALTER TABLE complaints ADD COLUMN is_blank INTEGER DEFAULT 0");
  }
  if (!cols.some(c => c.name === "mismatch")) {
    db.exec("ALTER TABLE complaints ADD COLUMN mismatch INTEGER DEFAULT 0");
  }
  if (!cols.some(c => c.name === "ding_status")) {
    db.exec("ALTER TABLE complaints ADD COLUMN ding_status TEXT DEFAULT ''");
  }
  if (!cols.some(c => c.name === "ding_at")) {
    db.exec("ALTER TABLE complaints ADD COLUMN ding_at TEXT");
  }
  if (!cols.some(c => c.name === "ding_msg")) {
    db.exec("ALTER TABLE complaints ADD COLUMN ding_msg TEXT");
  }
  // 渠道库
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_lib (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prod_name TEXT NOT NULL,
      prod_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(prod_id, channel)
    )
  `);
  return db;
}

export function upsertComplaint(db, rec) {
  const key = rec.dedup_key || (rec.sheet + "|" + rec.src_row);
  const existing = db.prepare("SELECT id, query_status, processed, fill_period, fill_phone, fill_tutor, is_blank FROM complaints WHERE dedup_key = ?").get(key);
  const now = new Date().toISOString();
  if (existing) {
    // ????????????????????/??????????????????????
    const newStatus = rec.query_status ?? (existing.is_blank ? "pending" : null);
    db.prepare(`UPDATE complaints SET feedback_date=?, customer_info=?, order_no=?, category=?, src_period=?, src_phone=?, src_tutor=?, date_key=?, src_feedback=?,
      is_blank=0,
      fill_period=COALESCE(?, fill_period), fill_phone=COALESCE(?, fill_phone), fill_tutor=COALESCE(?, fill_tutor),
      query_status=CASE WHEN ? IS NOT NULL THEN ? ELSE query_status END,
      processed=CASE WHEN ? IS NOT NULL THEN ? ELSE processed END,
      processed_at=CASE WHEN ? IS NOT NULL THEN ? ELSE processed_at END,
      query_remark=CASE WHEN ? IS NOT NULL THEN ? ELSE query_remark END
      WHERE dedup_key=?`)
      .run(rec.feedback_date, rec.customer_info, rec.order_no, rec.category, rec.src_period, rec.src_phone, rec.src_tutor, rec.date_key ?? null, rec.src_feedback ?? null,
        rec.fill_period ?? null, rec.fill_phone ?? null, rec.fill_tutor ?? null,
        newStatus, newStatus,
        rec.processed ?? null, rec.processed ?? null,
        rec.processed_at ?? null, rec.processed_at ?? null,
        rec.query_remark ?? null, rec.query_remark ?? null,
        key);
    return { inserted: false, id: existing.id };
  }
  db.prepare(`INSERT INTO complaints
    (sheet, src_row, feedback_date, customer_info, order_no, category, src_period, src_phone, src_tutor, date_key, src_feedback,
     fill_period, fill_phone, fill_tutor, query_status, processed, processed_at, query_remark, created_at, dedup_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(rec.sheet, rec.src_row, rec.feedback_date, rec.customer_info, rec.order_no, rec.category, rec.src_period, rec.src_phone, rec.src_tutor, rec.date_key ?? null, rec.src_feedback ?? null,
      rec.fill_period ?? null, rec.fill_phone ?? null, rec.fill_tutor ?? null,
      rec.query_status ?? "pending", rec.processed ?? "", rec.processed_at ?? null, rec.query_remark ?? null, now, key);
  return { inserted: true, id: db.prepare("SELECT last_insert_rowid() AS id").get().id };
}

// 空白/日期残留行占位入库：仅当该行号不存在记录时插入（不覆盖真实记录）
export function upsertBlankRow(db, sheet, row) {
  const key = sheet + "|" + row;
  const existing = db.prepare("SELECT id FROM complaints WHERE dedup_key = ?").get(key);
  if (existing) return { inserted: false, id: existing.id };
  db.prepare(`INSERT INTO complaints (sheet, src_row, is_blank, query_status, processed, created_at, dedup_key)
    VALUES (?,?,1,'blank','',?,?)`)
    .run(sheet, row, new Date().toISOString(), key);
  return { inserted: true, id: db.prepare("SELECT last_insert_rowid() AS id").get().id };
}

export function pendingOrders(db) {
  return db.prepare("SELECT * FROM complaints WHERE query_status = 'pending' ORDER BY id").all();
}






