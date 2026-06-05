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

/* --------------------- Traffic deep-dive (Phase 2) ----------------------- */

/** Daily sessions across the window, ascending by date. -> [{ date:'YYYY-MM-DD', sessions }] */
function ga4SessionsTrend_(windowDays) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 400
  });
  return ga4Rows_(rep).map(function (r) {
    var d = String(r.dims[0] || '');           // GA4 returns YYYYMMDD
    var iso = d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : d;
    return { date: iso, sessions: r.mets[0] };
  });
}

/** Top source/medium pairs by sessions. -> [{ source, medium, sessions }] */
function ga4TopSourceMediums_(windowDays, limit) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: limit || 10
  });
  return ga4Rows_(rep).map(function (r) {
    return { source: r.dims[0] || '(direct)', medium: r.dims[1] || '(none)', sessions: r.mets[0] };
  });
}

/** Sessions by a single dimension (country, city, deviceCategory, …). -> [{ name, sessions }] */
function ga4SessionsByDimension_(windowDays, dimName, limit) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: dimName }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: limit || 10
  });
  return ga4Rows_(rep).map(function (r) {
    return { name: r.dims[0] || '(not set)', sessions: r.mets[0] };
  });
}

/**
 * Top cities WITH their country, so the front end can flag remarkable non-UK
 * demand (e.g. Singapore for a Mayfair jeweller). -> [{ name, country, sessions }]
 */
function ga4TopCitiesWithCountry_(windowDays, limit) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'city' }, { name: 'country' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: limit || 10
  });
  return ga4Rows_(rep).map(function (r) {
    return { name: r.dims[0] || '(not set)', country: r.dims[1] || '', sessions: r.mets[0] };
  });
}

/* ----------------------- AI referral deep-dive --------------------------- */

/**
 * Session sources that represent AI assistants. NOTE: the AI never passes the
 * user's actual prompt — only its domain — so the closest proxy for "what they
 * asked" is the landing page the AI chose to cite (see ga4AiReferralDetail_).
 */
var AI_SOURCES = [
  'chatgpt.com', 'chat.openai.com', 'openai.com',
  'perplexity.ai', 'www.perplexity.ai',
  'gemini.google.com', 'bard.google.com',
  'copilot.microsoft.com', 'claude.ai'
];

/** A GA4 dimensionFilter limiting a report to AI-assistant sources. */
function ga4AiSourceFilter_() {
  return { filter: { fieldName: 'sessionSource', inListFilter: { values: AI_SOURCES, caseSensitive: false } } };
}

/**
 * Everything we can learn about AI-assistant traffic from GA4. The headline
 * insight is `landingPages` — the pages AIs cite, the best available proxy for
 * the underlying questions (GA4 never receives the prompt itself).
 * -> { totals, bySource, landingPages, trend, newVsReturning }
 */
function ga4AiReferralDetail_(windowDays) {
  var range = ga4DateRange_(windowDays);
  var filter = ga4AiSourceFilter_();

  // Site-wide AI totals: sessions, avg duration, pages/session.
  var totalsRep = ga4RunReport_({
    dateRanges: [range], dimensionFilter: filter,
    metrics: [{ name: 'sessions' }, { name: 'averageSessionDuration' }, { name: 'screenPageViewsPerSession' }]
  });
  var tm = ga4Rows_(totalsRep);
  var t = tm.length ? tm[0].mets : [0, 0, 0];
  var totals = { sessions: t[0], avgDurationSec: t[1], pagesPerSession: t[2] };

  // Per-assistant breakdown.
  var bySourceRep = ga4RunReport_({
    dateRanges: [range], dimensionFilter: filter,
    dimensions: [{ name: 'sessionSource' }], metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 25
  });
  var bySource = ga4Rows_(bySourceRep).map(function (r) {
    return { source: r.dims[0] || '(unknown)', sessions: r.mets[0] };
  });

  // Pages AIs cite — the proxy for "what people asked".
  var landingRep = ga4RunReport_({
    dateRanges: [range], dimensionFilter: filter,
    dimensions: [{ name: 'landingPagePlusQueryString' }], metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 12
  });
  var landingPages = ga4Rows_(landingRep).map(function (r) {
    return { page: r.dims[0] || '(not set)', sessions: r.mets[0] };
  });

  // Daily AI sessions trend.
  var trendRep = ga4RunReport_({
    dateRanges: [range], dimensionFilter: filter,
    dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400
  });
  var trend = ga4Rows_(trendRep).map(function (r) {
    var d = String(r.dims[0] || '');
    var iso = d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) : d;
    return { date: iso, sessions: r.mets[0] };
  });

  // New vs returning for AI visitors (discovery vs loyalty).
  var nvrRep = ga4RunReport_({
    dateRanges: [range], dimensionFilter: filter,
    dimensions: [{ name: 'newVsReturning' }], metrics: [{ name: 'activeUsers' }]
  });
  var newVsReturning = ga4Rows_(nvrRep)
    .filter(function (r) { return r.dims[0]; })
    .map(function (r) {
      var label = r.dims[0] === 'new' ? 'New' : r.dims[0] === 'returning' ? 'Returning' : r.dims[0];
      return { type: label, users: r.mets[0] };
    });

  return { totals: totals, bySource: bySource, landingPages: landingPages, trend: trend, newVsReturning: newVsReturning };
}

/* ----------------------- Product Intelligence ---------------------------- */

/**
 * Per-page metrics for the top pages by views. Product detection happens
 * downstream (Modules.buildProductsModule_) by joining these paths to the
 * Merchant Centre catalogue and excluding known non-product paths — Hancocks'
 * products are flat root-level slugs, so a URL-pattern filter here would miss
 * them. -> [{ pagePath, sessions, views, avgDurationSec }]
 *
 * NB: averageSessionDuration is session-scoped, so against pagePath it reads as
 * "avg duration of sessions that viewed this page" — a sound proxy for time on
 * product (the UI tooltip says as much).
 */
function ga4ProductPageMetrics_(windowDays, limit) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }, { name: 'averageSessionDuration' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: limit || 400
  });
  return ga4Rows_(rep).map(function (r) {
    return { pagePath: r.dims[0] || '', sessions: r.mets[0], views: r.mets[1], avgDurationSec: r.mets[2] };
  });
}

/**
 * Count of a given event by page. -> { pagePath: eventCount }
 * Used for scroll_50_product and enquiry_click; the module filters these to
 * product paths via the catalogue + exclusion list.
 */
function ga4ProductEventMap_(windowDays, eventName) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: eventName } } },
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 400
  });
  var map = {};
  ga4Rows_(rep).forEach(function (r) { map[r.dims[0] || ''] = r.mets[0]; });
  return map;
}

/**
 * Top on-site search terms. -> [{ term, count }]
 * Requires GA4 site-search (enhanced measurement) or a registered search_term
 * custom dimension to populate `searchTerm`; returns [] if not configured.
 */
function ga4SiteSearchTerms_(windowDays, limit) {
  var rep = ga4RunReport_({
    dateRanges: [ga4DateRange_(windowDays)],
    dimensions: [{ name: 'searchTerm' }],
    metrics: [{ name: 'eventCount' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: (limit || 20) + 5
  });
  return ga4Rows_(rep)
    .map(function (r) { return { term: r.dims[0] || '', count: r.mets[0] }; })
    .filter(function (x) { return x.term && x.term !== '(not set)'; })
    .slice(0, limit || 20);
}
