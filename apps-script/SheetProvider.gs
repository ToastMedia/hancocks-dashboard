/**
 * SheetProvider.gs — reads the (PRIVATE) Google Sheet.
 *
 * Works because the web app executes as the sheet owner (henry@), so it
 * retains access even though the sheet is no longer shared publicly. The sheet
 * id is read from Script Properties — never hardcoded, never sent to clients.
 *
 * Returns normalised JSON only. The existing 6 tabs are read as-is and never
 * restructured; future data sources get NEW tabs and NEW provider methods.
 */

/** Memoised spreadsheet handle for the duration of one execution. */
var _ss = null;
function getSpreadsheet_() {
  if (!_ss) _ss = SpreadsheetApp.openById(getProp_('SHEET_ID'));
  return _ss;
}

/**
 * Read a tab into an array of row objects keyed by header label.
 * Empty trailing rows are skipped. Numeric cells stay numbers.
 *
 * @param {string} tabName
 * @return {Array<Object>}
 */
function readTab_(tabName) {
  var sheet = getSpreadsheet_().getSheetByName(tabName);
  if (!sheet) throw new Error('Sheet tab not found: ' + tabName);
  var range = sheet.getDataRange();
  var values = range.getValues();
  if (values.length < 2) return [];

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var rowVals = values[r];
    // Skip fully empty rows.
    var hasData = rowVals.some(function (v) { return v !== '' && v !== null; });
    if (!hasData) continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = rowVals[c];
    }
    rows.push(obj);
  }
  return rows;
}

/* ----------------------- typed accessors per tab ------------------------- */

function readEventSummary_() { return readTab_(TABS.eventSummary); }
function readDailyTrend_()   { return readTab_(TABS.dailyTrend); }
function readBySource_()     { return readTab_(TABS.bySource); }
function readByLocation_()   { return readTab_(TABS.byLocation); }
function readByDow_()        { return readTab_(TABS.byDow); }

/**
 * By Device is LONG format (Device | Event | Count). Pivot to a per-device
 * total and a per-device×event map for whoever needs either shape.
 * @return {{ totals: Object, byEvent: Object }}
 */
function readByDevice_() {
  var rows = readTab_(TABS.byDevice);
  var totals = {};   // { Desktop: 1234, ... }
  var byEvent = {};  // { Desktop: { whatsapp_click: 12, ... }, ... }
  rows.forEach(function (row) {
    var device = String(row['Device'] || 'Unknown');
    var event = String(row['Event'] || '');
    var count = toNum_(row['Count']);
    totals[device] = (totals[device] || 0) + count;
    if (!byEvent[device]) byEvent[device] = {};
    byEvent[device][event] = (byEvent[device][event] || 0) + count;
  });
  return { totals: totals, byEvent: byEvent };
}

/* ------------------------------- helpers --------------------------------- */

/** Coerce a cell to a finite number (blanks/strings -> 0). */
function toNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (v === null || v === '' || v === undefined) return 0;
  var n = parseFloat(String(v).replace(/[, ]/g, ''));
  return isFinite(n) ? n : 0;
}

/** Parse a sheet date cell (Date object or string) to a JS Date or null. */
function toDate_(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
