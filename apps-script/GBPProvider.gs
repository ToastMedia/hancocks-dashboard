/**
 * GBPProvider.gs — Google Business Profile ("Local Visibility").
 *
 * Uses the Business Profile Performance API via UrlFetchApp + getOAuthToken
 * (scope: business.manage). Needs Script Property GBP_LOCATION_ID — the numeric
 * location id (run gbpListLocations() once to discover it; see below).
 *
 * IMPORTANT: the Business Profile APIs require a one-time ACCESS APPROVAL for
 * the Cloud project (a Google form, separate from enabling the API). Until that
 * is granted, calls return PERMISSION_DENIED and the module degrades
 * gracefully (the dashboard shows a "not connected" state).
 *
 * Data also lags: GBP performance metrics are typically a few days behind, so
 * the most recent 2-3 days may read zero — that's the source, not a bug.
 */

var GBP_PERF_BASE = 'https://businessprofileperformance.googleapis.com/v1';

/** The metrics we pull, grouped for the derived summary. */
var GBP_IMPRESSION_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS'
];
var GBP_ACTION_METRICS = [
  'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS',
  'BUSINESS_CONVERSATIONS', 'BUSINESS_BOOKINGS'
];

function gbpLocationName_() {
  return 'locations/' + getProp_('GBP_LOCATION_ID');
}

function gbpFetch_(url) {
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code !== 200) throw new Error('GBP API error ' + code + ': ' + text);
  return JSON.parse(text);
}

function gbpPad2_(n) { return (n < 10 ? '0' : '') + n; }

/**
 * Daily metric time series over the window.
 * -> { totals: {metric:sum}, series: {metric:[{date,value}]} }
 */
function gbpDailyMetrics_(windowDays) {
  var metrics = GBP_IMPRESSION_METRICS.concat(GBP_ACTION_METRICS);
  var end = new Date(); end.setDate(end.getDate() - 1);           // yesterday
  var start = new Date(end.getTime() - (windowDays - 1) * 86400000);

  var params = metrics.map(function (m) { return 'dailyMetrics=' + m; });
  params.push('dailyRange.start_date.year=' + start.getFullYear());
  params.push('dailyRange.start_date.month=' + (start.getMonth() + 1));
  params.push('dailyRange.start_date.day=' + start.getDate());
  params.push('dailyRange.end_date.year=' + end.getFullYear());
  params.push('dailyRange.end_date.month=' + (end.getMonth() + 1));
  params.push('dailyRange.end_date.day=' + end.getDate());

  var url = GBP_PERF_BASE + '/' + gbpLocationName_() + ':fetchMultiDailyMetricsTimeSeries?' + params.join('&');
  var data = gbpFetch_(url);

  var totals = {}, series = {};
  (data.multiDailyMetricTimeSeries || []).forEach(function (entry) {
    var dm = entry.dailyMetricTimeSeries || {};
    var metric = dm.dailyMetric;
    if (!metric) return;
    var dv = (dm.timeSeries && dm.timeSeries.datedValues) || [];
    var sum = 0, arr = [];
    dv.forEach(function (p) {
      var v = parseInt(p.value || '0', 10) || 0;
      sum += v;
      var dt = p.date || {};
      arr.push({ date: dt.year + '-' + gbpPad2_(dt.month) + '-' + gbpPad2_(dt.day), value: v });
    });
    totals[metric] = sum;
    series[metric] = arr;
  });
  return { totals: totals, series: series };
}

/**
 * Monthly search keywords driving impressions, top N.
 * Low counts are returned by Google as a threshold (e.g. "< 15"); we surface
 * the threshold value and flag it approximate.
 * -> [{ keyword, value, approx }]
 */
function gbpSearchKeywords_(months, limit) {
  var end = new Date();
  var start = new Date(end.getFullYear(), end.getMonth() - (months - 1), 1);
  var url = GBP_PERF_BASE + '/' + gbpLocationName_() + '/searchkeywords/impressions/monthly'
    + '?monthlyRange.start_month.year=' + start.getFullYear()
    + '&monthlyRange.start_month.month=' + (start.getMonth() + 1)
    + '&monthlyRange.end_month.year=' + end.getFullYear()
    + '&monthlyRange.end_month.month=' + (end.getMonth() + 1);
  var data = gbpFetch_(url);

  var rows = (data.searchKeywordsCounts || []).map(function (k) {
    var iv = k.insightsValue || {};
    var approx = iv.value == null && iv.threshold != null;
    var val = iv.value != null ? parseInt(iv.value, 10) : (iv.threshold != null ? parseInt(iv.threshold, 10) : 0);
    return { keyword: k.searchKeyword, value: val || 0, approx: approx };
  });
  rows.sort(function (a, b) { return b.value - a.value; });
  return rows.slice(0, limit || 10);
}

/**
 * DISCOVERY HELPER — run manually from the editor (Run ▶ gbpListLocations)
 * once GBP access is approved and the business.manage scope is authorised.
 * It logs your account name(s) and location id(s); copy the numeric id from a
 * location name like "locations/1234567890" into the GBP_LOCATION_ID property.
 */
function gbpListLocations() {
  var token = ScriptApp.getOAuthToken();
  var accResp = UrlFetchApp.fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  Logger.log('ACCOUNTS (%s): %s', accResp.getResponseCode(), accResp.getContentText());
  var accounts = (JSON.parse(accResp.getContentText()).accounts) || [];
  accounts.forEach(function (a) {
    var locResp = UrlFetchApp.fetch(
      'https://mybusinessbusinessinformation.googleapis.com/v1/' + a.name +
      '/locations?readMask=name,title,storefrontAddress&pageSize=100',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    Logger.log('LOCATIONS for %s (%s): %s', a.name, locResp.getResponseCode(), locResp.getContentText());
  });
}
