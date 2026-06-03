/**
 * GA4Provider.gs — Google Analytics Data API (GA4) provider.
 *
 * The sheet is 100% event-COUNT data: no sessions, pageviews or page paths.
 * Anything session/traffic/page based MUST come from here.
 *
 * Uses UrlFetchApp + ScriptApp.getOAuthToken() (rather than the Analytics Data
 * advanced service) so the only setup is: enable the Google Analytics Data API
 * in the Cloud project + the analytics.readonly scope in appsscript.json.
 *
 * Phase 1 cuts: sessions by channel, new vs returning, top landing pages,
 * avg session duration, pages/session. (Best hour, scroll depth, exit pages,
 * search terms are Phase 2.)
 */

/** Low-level runReport wrapper. Returns parsed GA4 report JSON. */
function ga4RunReport_(requestBody) {
  var propertyId = getProp_('GA4_PROPERTY_ID');
  var url = 'https://analyticsdata.googleapis.com/v1beta/properties/' + propertyId + ':runReport';
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code !== 200) {
    throw new Error('GA4 API error ' + code + ': ' + text);
  }
  return JSON.parse(text);
}

/** GA4 date range for a rolling window of N days ending yesterday. */
function ga4DateRange_(windowDays) {
  return { startDate: windowDays + 'daysAgo', endDate: 'yesterday' };
}

/** Convenience: pull rows as arrays of {dimensions:[], metrics:[]} numbers. */
function ga4Rows_(report) {
  var rows = report.rows || [];
  return rows.map(function (row) {
    return {
      dims: (row.dimensionValues || []).map(function (d) { return d.value; }),
      mets: (row.metricValues || []).map(function (m) { return parseFloat(m.value) || 0; })
    };
  });
}

/* ----------------------------- Phase 1 reports --------------------------- */

/** Sessions by default channel group. -> [{ channel, sessions }] */
function ga4SessionsByChannel_(windowDays) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 25
  });
  return ga4Rows_(rep).map(function (r) {
    return { channel: r.dims[0] || 'Unassigned', sessions: r.mets[0] };
  });
}

/** New vs returning users. -> [{ type, users }] */
function ga4NewVsReturning_(windowDays) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'newVsReturning' }],
    metrics: [{ name: 'activeUsers' }]
  });
  return ga4Rows_(rep)
    .filter(function (r) { return r.dims[0]; })
    .map(function (r) {
      var label = r.dims[0] === 'new' ? 'New' : r.dims[0] === 'returning' ? 'Returning' : r.dims[0];
      return { type: label, users: r.mets[0] };
    });
}

/** Top landing pages by sessions. -> [{ page, sessions }] */
function ga4TopLandingPages_(windowDays, limit) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'landingPagePlusQueryString' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: limit || 10
  });
  return ga4Rows_(rep).map(function (r) {
    return { page: r.dims[0] || '(not set)', sessions: r.mets[0] };
  });
}

/**
 * Site-wide engagement totals: total sessions, avg session duration (s),
 * pages/session (screenPageViewsPerSession). -> { sessions, avgDurationSec, pagesPerSession }
 */
function ga4EngagementTotals_(windowDays) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    metrics: [
      { name: 'sessions' },
      { name: 'averageSessionDuration' },
      { name: 'screenPageViewsPerSession' }
    ]
  });
  var rows = ga4Rows_(rep);
  var m = rows.length ? rows[0].mets : [0, 0, 0];
  return { sessions: m[0], avgDurationSec: m[1], pagesPerSession: m[2] };
}

/**
 * Sessions per channel keyed for joins. -> { channelLower: sessions }
 */
function ga4SessionsByChannelMap_(windowDays) {
  var map = {};
  ga4SessionsByChannel_(windowDays).forEach(function (r) {
    map[String(r.channel).toLowerCase()] = r.sessions;
  });
  return map;
}

/**
 * Sessions by source/medium, keyed "source / medium" (lowercased) to join
 * against the sheet's By Traffic Source rows for Source Efficiency.
 * -> { "google / organic": 1234, ... }
 */
function ga4SessionsBySourceMediumMap_(windowDays) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 200
  });
  var map = {};
  ga4Rows_(rep).forEach(function (r) {
    var src = String(r.dims[0] || '(direct)').toLowerCase();
    var med = String(r.dims[1] || '(none)').toLowerCase();
    map[src + ' / ' + med] = r.mets[0];
  });
  return map;
}
