/**
 * Modules.gs — module builders. Each composes one or more PROVIDERS into the
 * normalised payload its dashboard card renders. Registered in Config.MODULES.
 *
 * GA4 calls are wrapped in tryGa4_ so that, before the Data API is enabled (or
 * if it errors), the sheet-backed parts of a module still return cleanly and
 * the front end shows a localised "GA4 unavailable" state instead of failing
 * the whole request.
 */

/** Run a GA4-backed function; never let it break the whole module. */
function tryGa4_(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** Enquiry -> appointment funnel from a windows aggregate. */
function buildFunnel_(windows) {
  var enq = windows.current.sums.enquiry_click || 0;
  var appt = windows.current.sums.appointment_click || 0;
  var prevEnq = windows.previous.sums.enquiry_click || 0;
  var prevAppt = windows.previous.sums.appointment_click || 0;
  return {
    enquiries: enq,
    appointments: appt,
    conversionPct: enq > 0 ? appt / enq : null,
    prevConversionPct: prevEnq > 0 ? prevAppt / prevEnq : null
  };
}

/* ============================ Module 1: Conversions ====================== */

function buildConversionsModule_(params) {
  var windows = getDailyWindows_(params.window);
  var deltas = computeEventDeltas_(windows);
  var momentum = computeMomentum_(windows);
  var funnel = buildFunnel_(windows);
  var soWhat = computeSoWhat_(windows, momentum, deltas, funnel, params.window);

  // Best day of week (purpose-built tab).
  var dow = readByDow_().map(function (r) {
    return { day: String(r['Day'] || ''), conversions: toNum_(r['Total conversions']), engagement: toNum_(r['Total engagement']) };
  });
  var bestDay = dow.slice().sort(function (a, b) { return b.conversions - a.conversions; })[0] || null;

  return {
    source: 'sheet',
    soWhat: soWhat,
    momentum: momentum,
    scorecards: deltas,
    trend: windows.days.map(function (d) {
      return { date: d.date, conversions: d.conversions, engagement: d.engagement, total: d.total };
    }),
    bestDay: bestDay,
    dayOfWeek: dow,
    funnel: funnel,
    lastDataDate: windows.maxDate
  };
}

/* ============================ Module 5: Business ========================= */

function buildBusinessModule_(params) {
  var windows = getDailyWindows_(params.window);
  var momentum = computeMomentum_(windows);
  var deltas = computeEventDeltas_(windows);
  var funnel = buildFunnel_(windows);
  var soWhat = computeSoWhat_(windows, momentum, deltas, funnel, params.window);

  var byKey = {};
  deltas.forEach(function (d) { byKey[d.key] = d; });

  // How clients reach out — the contact channel split (conversions only).
  var channelSplit = ['whatsapp_click', 'phone_call_click', 'email_click', 'enquiry_click', 'appointment_click']
    .map(function (k) { return { key: k, label: byKey[k].label, current: byKey[k].current, previous: byKey[k].previous, changePct: byKey[k].changePct }; });

  // Weekly + monthly rollups of the current window.
  var weekly = rollup_(windows.days, weekKey_);
  var monthly = rollup_(windows.days, function (key) { return key.slice(0, 7); });

  return {
    source: 'sheet',
    soWhat: soWhat,
    momentum: momentum,
    funnel: funnel,
    channelSplit: channelSplit,
    share: byKey['share_click'],
    newsletter: byKey['newsletter_signup'],
    shareSparkline: windows.days.map(function (d) { return { date: d.date, value: d.counts.share_click || 0 }; }),
    newsletterSparkline: windows.days.map(function (d) { return { date: d.date, value: d.counts.newsletter_signup || 0 }; }),
    weekly: weekly,
    monthly: monthly,
    lastDataDate: windows.maxDate
  };
}

/** Group days by a key function, summing conversions/engagement/total. */
function rollup_(days, keyFn) {
  var map = {};
  var order = [];
  days.forEach(function (d) {
    var k = keyFn(d.date);
    if (!map[k]) { map[k] = { period: k, conversions: 0, engagement: 0, total: 0 }; order.push(k); }
    map[k].conversions += d.conversions;
    map[k].engagement += d.engagement;
    map[k].total += d.total;
  });
  return order.map(function (k) { return map[k]; });
}

/** ISO-ish week key (year-Www) for a YYYY-MM-DD string. */
function weekKey_(dayStr) {
  var d = new Date(dayStr + 'T00:00:00');
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  return Utilities.formatDate(d, tz, "YYYY-'W'ww");
}

/* ===================== Module 3 slice: Audience + GA4 ==================== */

function buildAudienceModule_(params) {
  var w = params.window;

  // Countries / cities (sheet) — aggregate By Location.
  var loc = readByLocation_();
  var countries = aggregateBy_(loc, 'Country', 'Total conversions', 'Total engagement');
  var cities = topRows_(loc.map(function (r) {
    return {
      label: String(r['City'] || 'Unknown') + (r['Country'] ? ', ' + r['Country'] : ''),
      conversions: toNum_(r['Total conversions']),
      engagement: toNum_(r['Total engagement'])
    };
  }), 'conversions', 10);

  // Devices (sheet, long format pivot).
  var devTotals = readByDevice_().totals;
  var devices = Object.keys(devTotals).map(function (k) { return { device: k, count: devTotals[k] }; })
    .sort(function (a, b) { return b.count - a.count; });

  // Day of week (sheet).
  var dayOfWeek = readByDow_().map(function (r) {
    return { day: String(r['Day'] || ''), conversions: toNum_(r['Total conversions']), engagement: toNum_(r['Total engagement']) };
  });

  // GA4: engagement quality + new vs returning.
  var engagement = tryGa4_(function () { return ga4EngagementTotals_(w); });
  var newVsReturning = tryGa4_(function () { return ga4NewVsReturning_(w); });

  return {
    source: 'sheet+ga4',
    countries: topRows_(countries, 'conversions', 10),
    cities: cities,
    devices: devices,
    dayOfWeek: dayOfWeek,
    ga4: {
      engagement: engagement,           // { ok, value:{sessions, avgDurationSec, pagesPerSession} }
      newVsReturning: newVsReturning     // { ok, value:[{type, users}] }
    }
  };
}

/* ===================== Module 2 slice: Traffic + GA4 ===================== */

function buildTrafficModule_(params) {
  var w = params.window;
  var src = readBySource_();

  // Referral sources (sheet) — aggregate By Traffic Source by Source.
  var sources = topRows_(
    aggregateBy_(src, 'Source', 'Total conversions', 'Total engagement'),
    'conversions', 10
  );

  // Campaigns (sheet) — rows that name a campaign.
  var campaigns = topRows_(
    aggregateBy_(
      src.filter(function (r) { return r['Campaign'] && String(r['Campaign']).trim() && String(r['Campaign']) !== '(not set)'; }),
      'Campaign', 'Total conversions', 'Total engagement'
    ),
    'conversions', 10
  );

  // GA4 traffic cuts.
  var sessionsByChannel = tryGa4_(function () { return ga4SessionsByChannel_(w); });
  var newVsReturning = tryGa4_(function () { return ga4NewVsReturning_(w); });
  var topLandingPages = tryGa4_(function () { return ga4TopLandingPages_(w, 10); });
  var engagement = tryGa4_(function () { return ga4EngagementTotals_(w); });

  // Source Efficiency (value layer): enquiries+appointments per 100 sessions,
  // joining the sheet's per-source/medium conversions to GA4 sessions.
  var sourceEfficiency = tryGa4_(function () {
    var sessMap = ga4SessionsBySourceMediumMap_(w);
    var ranked = [];
    src.forEach(function (r) {
      var source = String(r['Source'] || '(direct)').toLowerCase();
      var medium = String(r['Medium'] || '(none)').toLowerCase();
      var sessions = sessMap[source + ' / ' + medium] || 0;
      if (sessions < 20) return; // ignore low-volume noise
      var hi = toNum_(r['Enquiry']) + toNum_(r['Book Appt']);
      ranked.push({
        source: r['Source'] || '(direct)',
        medium: r['Medium'] || '(none)',
        campaign: r['Campaign'] || '',
        sessions: sessions,
        enquiriesAndAppointments: hi,
        per100Sessions: sessions > 0 ? (hi / sessions) * 100 : 0
      });
    });
    ranked.sort(function (a, b) { return b.per100Sessions - a.per100Sessions; });
    return ranked.slice(0, 10);
  });

  return {
    source: 'sheet+ga4',
    sources: sources,
    campaigns: campaigns,
    ga4: {
      sessionsByChannel: sessionsByChannel,
      newVsReturning: newVsReturning,
      topLandingPages: topLandingPages,
      engagement: engagement
    },
    sourceEfficiency: sourceEfficiency
  };
}

/* ------------------------------- helpers --------------------------------- */

/** Aggregate sheet rows by a dimension column, summing two metric columns. */
function aggregateBy_(rows, dimCol, convCol, engCol) {
  var map = {};
  var order = [];
  rows.forEach(function (r) {
    var label = String(r[dimCol] || 'Unknown').trim() || 'Unknown';
    if (!map[label]) { map[label] = { label: label, conversions: 0, engagement: 0 }; order.push(label); }
    map[label].conversions += toNum_(r[convCol]);
    map[label].engagement += toNum_(r[engCol]);
  });
  return order.map(function (k) { return map[k]; });
}

/** Sort by a numeric field desc and take the top N. */
function topRows_(rows, field, n) {
  return rows.slice().sort(function (a, b) { return (b[field] || 0) - (a[field] || 0); }).slice(0, n);
}
