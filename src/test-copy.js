// Quick test: open doc, switch to AI tab, copy from row 11298, report result
import { log, launch, openDoc, clickTab, copyFromRow, copySheet, readCell } from "./browser.js";

const sheet = process.argv[2] || "AI";
const startRow = Number(process.argv[3] || 11298);

const { ctx, page } = await launch();
try {
  await openDoc(page);
  const tabOk = await clickTab(page, sheet);
  log("Tab " + sheet + " active: " + tabOk);

  // Read C cell
  const cText = await readCell(page, "C" + startRow);
  log("C" + startRow + " = " + JSON.stringify(String(cText || "").slice(0, 100)));

  // Try copyFromRow
  log("--- Testing copyFromRow ---");
  try {
    const t1 = await copyFromRow(page, sheet, startRow, "");
    log("copyFromRow OK: " + t1.length + " chars");
    log("First 200: " + JSON.stringify(t1.slice(0, 200)));
  } catch (e) {
    log("copyFromRow FAILED: " + String(e.message || e).split("\n")[0]);

    // Fallback to copySheet
    log("--- Testing copySheet fallback ---");
    try {
      const t2 = await copySheet(page, sheet);
      log("copySheet OK: " + t2.length + " chars");
      log("First 200: " + JSON.stringify(t2.slice(0, 200)));
    } catch (e2) {
      log("copySheet also FAILED: " + String(e2.message || e2).split("\n")[0]);
    }
  }
} finally {
  await ctx.close().catch(() => {});
  log("Done.");
}
