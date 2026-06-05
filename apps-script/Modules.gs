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

  // Direct Contact Actions — enquiries and appointments are INDEPENDENT actions
  // (a visitor can do either without the other), not a funnel. Plus a combined
  // total across every direct-contact channel.
  var directKeys = ['enquiry_click', 'appointment_click', 'whatsapp_click', 'phone_call_click', 'email_click'];
  var dcCurrent = directKeys.reduce(function (a, k) { return a + (byKey[k].current || 0); }, 0);
  var dcPrevious = directKeys.reduce(function (a, k) { return a + (byKey[k].previous || 0); }, 0);
  var directContact = {
    enquiries: byKey['enquiry_click'],
    appointments: byKey['appointment_click'],
    total: dcCurrent,
    totalPrevious: dcPrevious,
    totalChangePct: pctChange_(dcCurrent, dcPrevious)
  };

  // Weekly + monthly rollups of the current window.
  var weekly = rollup_(windows.days, weekKey_);
  var monthly = rollup_(windows.days, function (key) { return key.slice(0, 7); });

  return {
    source: 'sheet',
    soWhat: soWhat,
    momentum: momentum,
    directContact: directContact,
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

  // GA4 traffic deep-dive (Phase 2).
  var sessionsTrend = tryGa4_(function () { return ga4SessionsTrend_(w); });
  var sourceMediums = tryGa4_(function () { return ga4TopSourceMediums_(w, 10); });
  var geoSessions = tryGa4_(function () {
    return { countries: ga4SessionsByDimension_(w, 'country', 8), cities: ga4TopCitiesWithCountry_(w, 10) };
  });
  var deviceSessions = tryGa4_(function () { return ga4SessionsByDimension_(w, 'deviceCategory', 6); });

  // Source Efficiency (value layer): enquiries+appointments per 100 sessions,
  // joining the sheet's per-source/medium conversions to GA4 sessions.
  var sourceEfficiency = tryGa4_(function () {
    var sessMap = ga4SessionsBySourceMediumMap_(w);
    var ranked = [];
    src.forEach(function (r) {
      var source = String(r['Source'] || '(direct)').toLowerCase();
      var medium = String(r['Medium'] || '(none)').toLowerCase();
      // Skip unattributed noise: GA4 can't tie (not set) source/medium to anything actionable.
      if (source === '(not set)' || medium === '(not set)') return;
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
      engagement: engagement,
      sessionsTrend: sessionsTrend,
      sourceMediums: sourceMediums,
      geoSessions: geoSessions,
      deviceSessions: deviceSessions,
      aiReferral: tryGa4_(function () { return ga4AiReferralDetail_(w); })
    },
    sourceEfficiency: sourceEfficiency
  };
}

/* ===================== Local Visibility: Google Business Profile ========= */

/** Run a GBP-backed function; never let it break the whole module. */
function tryGBP_(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function buildLocalVisibilityModule_(params) {
  var w = params.window;

  // Not configured yet? Return a clean "connect" state, no error noise.
  var configured = !!PropertiesService.getScriptProperties().getProperty('GBP_LOCATION_ID');
  if (!configured) {
    return { source: 'gbp', configured: false };
  }

  var daily = tryGBP_(function () { return gbpDailyMetrics_(w); });
  var keywords = tryGBP_(function () { return gbpSearchKeywords_(Math.max(1, Math.ceil(w / 30)), 12); });

  var derived = null;
  if (daily.ok) {
    var t = daily.value.totals;
    function sum(keys) { return keys.reduce(function (a, k) { return a + (t[k] || 0); }, 0); }
    derived = {
      impressionsTotal: sum(GBP_IMPRESSION_METRICS),
      searchImpressions: sum(['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH']),
      mapsImpressions: sum(['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS']),
      desktopImpressions: sum(['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS']),
      mobileImpressions: sum(['BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS']),
      actions: {
        calls: t['CALL_CLICKS'] || 0,
        website: t['WEBSITE_CLICKS'] || 0,
        directions: t['BUSINESS_DIRECTION_REQUESTS'] || 0,
        messages: t['BUSINESS_CONVERSATIONS'] || 0,
        bookings: t['BUSINESS_BOOKINGS'] || 0
      },
      impressionsSeries: combineSeriesByDate_(daily.value.series, GBP_IMPRESSION_METRICS)
    };
  }

  return { source: 'gbp', configured: true, derived: derived, daily: daily, keywords: keywords };
}

/** Sum several GBP daily series into one [{date,value}] ordered by date. */
function combineSeriesByDate_(series, metricKeys) {
  var map = {};
  metricKeys.forEach(function (k) {
    (series[k] || []).forEach(function (p) { map[p.date] = (map[p.date] || 0) + p.value; });
  });
  return Object.keys(map).sort().map(function (d) { return { date: d, value: map[d] }; });
}

/* ============================= Instagram (Meta) ========================== */

/** Run a Meta-backed function; never let it break the whole module. */
function tryMeta_(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function buildInstagramModule_(params) {
  var w = params.window;
  var configured = !!PropertiesService.getScriptProperties().getProperty('IG_USER_ID');
  if (!configured) {
    return { source: 'instagram', configured: false };
  }

  var reach = tryMeta_(function () { return metaDaySeries_('reach', w); });
  var topMedia = tryMeta_(function () { return metaTopMedia_(12); });

  // Engagement rate = (likes + comments + saves) / reach × 100 for the period.
  // Uses the recent media we already fetched as the engagement numerator.
  var engagementRate = null;
  if (topMedia.ok && reach.ok) {
    var eng = topMedia.value.reduce(function (a, m) { return a + (m.likes || 0) + (m.comments || 0) + (m.saves || 0); }, 0);
    var reachTotal = reach.value.reduce(function (a, p) { return a + (p.value || 0); }, 0);
    engagementRate = reachTotal > 0 ? (eng / reachTotal * 100) : null;
  }

  return {
    source: 'instagram',
    configured: true,
    profile: tryMeta_(function () { return metaProfile_(); }),
    reach: reach,
    followers: tryMeta_(function () { return metaDaySeries_('follower_count', w); }),
    topMedia: topMedia,
    profileVisits: tryMeta_(function () { return metaAccountTotalValue_('profile_visits', w); }),
    linkClicks: tryMeta_(function () { return metaAccountTotalValue_('profile_links_taps', w); }),
    storyViews: tryMeta_(function () { return metaStoryViews_(); }),
    engagementRate: engagementRate,
    demographics: {
      age: tryMeta_(function () { return metaFollowerDemographics_(w, 'age'); }),
      gender: tryMeta_(function () { return metaFollowerDemographics_(w, 'gender'); }),
      cities: tryMeta_(function () { return metaFollowerDemographics_(w, 'city'); })
    }
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

/* ============== Product Intelligence (GA4 + Merchant Centre) ============= */

/** Turn a product page path into a readable name (fallback when no catalogue). */
function slugToName_(pagePath) {
  var p = String(pagePath || '').split('?')[0].split('#')[0].replace(/\/+$/, '');
  var seg = p.split('/').filter(function (s) { return s; }).pop() || p;
  seg = seg.replace(/[-_]+/g, ' ').trim();
  var name = seg.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  return name || pagePath;
}

/**
 * Known non-product root paths on hancockslondon.com. Products are flat
 * single-segment slugs at the root; these are the listing/info pages that also
 * live at the root and must be excluded. The Merchant Centre catalogue is the
 * primary product signal — this list only governs the fallback for pages not
 * in the catalogue (e.g. sold/archived pieces still getting traffic).
 */
var NON_PRODUCT_PATHS = (function () {
  var list = [
    '/', '/jewellery', '/engagement', '/wedding', '/makers', '/victoria-cross',
    '/discover', '/contact', '/about', '/about-us', '/journal', '/blog', '/news',
    '/press', '/stockists', '/services', '/bespoke', '/history', '/valuations',
    '/sell', '/privacy', '/privacy-policy', '/terms', '/terms-and-conditions',
    '/cookie-policy', '/faq', '/faqs', '/delivery', '/returns', '/shipping',
    '/cart', '/basket', '/checkout', '/account', '/login', '/register', '/search',
    '/wishlist', '/home', '/sitemap', '/newsletter', '/appointments'
  ];
  var set = {};
  list.forEach(function (p) { set[p] = true; });
  return set;
})();

/**
 * Is this GA4 page path a product page? A path is a product if it's in the
 * Merchant Centre catalogue (authoritative), or — fallback — a root-level
 * single-segment slug that isn't a known non-product page.
 */
function isProductPath_(pagePath, byPath) {
  var n = normalizePath_(pagePath);
  if (byPath && byPath[n]) return true;          // in the catalogue → definitely a product
  var segs = n.split('/').filter(function (s) { return s; });
  if (segs.length !== 1) return false;           // products are flat root slugs
  return !NON_PRODUCT_PATHS[n];
}

/**
 * Infer a product category from its name, for when the Merchant Centre feed
 * doesn't carry productType/googleProductCategory. For jewellery the piece type
 * is almost always in the title, so this yields useful buckets (Rings, Tiaras…).
 */
function categoryFromName_(name) {
  var s = ' ' + String(name || '').toLowerCase() + ' ';
  var rules = [
    [/tiara/, 'Tiaras'],
    [/brooch|hairpin|\bspray\b/, 'Brooches'],
    [/necklace|rivi[eè]re/, 'Necklaces'],
    [/pendant/, 'Pendants'],
    [/earring|ear ?clip|\bstud/, 'Earrings'],
    [/bracelet/, 'Bracelets'],
    [/bangle/, 'Bangles'],
    [/cuff ?link/, 'Cufflinks'],
    [/locket/, 'Lockets'],
    [/\bwatch|wristwatch/, 'Watches'],
    [/\bmedal\b/, 'Medals'],
    [/\brings?\b/, 'Rings'],
    [/\bpin\b/, 'Pins']
  ];
  for (var i = 0; i < rules.length; i++) { if (rules[i][0].test(s)) return rules[i][1]; }
  return 'Other';
}

/** Friendly label for a non-product page path ('/' -> Home). */
function pageName_(pagePath) {
  var n = normalizePath_(pagePath);
  if (n === '/') return 'Home';
  return slugToName_(n);
}

function buildProductsModule_(params) {
  var w = params.window;

  // Authoritative product catalogue — inert until GMC_MERCHANT_ID is set.
  var catR = tryGa4_(function () { return gmcBuildCatalogue_(); });
  var catalogue = (catR.ok && catR.value.configured) ? catR.value : null;
  var byPath = catalogue ? catalogue.byPath : {};
  var catalogueError = (gmcConfigured_() && !catR.ok) ? catR.error : null;

  var note = catalogue
    ? 'Product names, categories and images from your Google Merchant Centre catalogue.'
    : 'Product names derived from page URLs — connect Merchant Centre for real titles, categories and images.';

  var pagesR = tryGa4_(function () { return ga4ProductPageMetrics_(w, 400); });
  var searchR = tryGa4_(function () { return ga4SiteSearchTerms_(w, 20); });

  if (!pagesR.ok) {
    return { source: 'ga4', available: false, note: note, error: pagesR.error, searchTerms: searchR };
  }

  // Catalogue-bound lookups (fall back to URL-derived when not in the feed).
  function nameFor(pp) { var e = byPath[normalizePath_(pp)]; return (e && e.title) ? e.title : slugToName_(pp); }
  function imageFor(pp) { var e = byPath[normalizePath_(pp)]; return (e && e.image) ? e.image : ''; }
  function collectionFor(pp) {
    var e = byPath[normalizePath_(pp)];
    var c = (e && e.collection) ? e.collection : '';
    return c || categoryFromName_(nameFor(pp));   // infer from name when feed has no category
  }
  // When the catalogue is connected it's the source of truth for "is a product";
  // otherwise fall back to the URL heuristic.
  function isProduct(pp) {
    if (catalogue) return !!byPath[normalizePath_(pp)];
    return isProductPath_(pp, byPath);
  }
  function row(p, extra) {
    var r = { name: nameFor(p.pagePath), pagePath: p.pagePath, image: imageFor(p.pagePath) };
    for (var k in extra) { if (extra.hasOwnProperty(k)) r[k] = extra[k]; }
    return r;
  }

  var pages = pagesR.value.filter(function (p) { return isProduct(p.pagePath); });

  // High-traffic pages that aren't products (listing / content / info pages).
  var otherPages = pagesR.value.filter(function (p) { return !isProduct(p.pagePath); })
    .sort(function (a, b) { return b.views - a.views; }).slice(0, 12)
    .map(function (p) { return { name: pageName_(p.pagePath), pagePath: p.pagePath, sessions: p.sessions, views: p.views }; });

  // Most viewed (by sessions).
  var mostViewed = pages.slice().sort(function (a, b) { return b.sessions - a.sessions; }).slice(0, 10)
    .map(function (p) { return row(p, { sessions: p.sessions, views: p.views }); });

  // Most engaged (by avg time; require a little volume to avoid 1-session noise).
  var mostEngaged = pages.filter(function (p) { return p.sessions >= 5; })
    .sort(function (a, b) { return b.avgDurationSec - a.avgDurationSec; }).slice(0, 10)
    .map(function (p) { return row(p, { avgDurationSec: p.avgDurationSec, sessions: p.sessions }); });

  // Collection performance (sessions + sessions-weighted avg engagement),
  // grouped by product category.
  var colMap = {};
  pages.forEach(function (p) {
    var key = collectionFor(p.pagePath);
    if (!colMap[key]) colMap[key] = { collection: key, sessions: 0, durWeighted: 0 };
    colMap[key].sessions += p.sessions;
    colMap[key].durWeighted += (p.avgDurationSec || 0) * (p.sessions || 0);
  });
  var collections = Object.keys(colMap).map(function (k) {
    var c = colMap[k];
    return { collection: c.collection, sessions: c.sessions, avgDurationSec: c.sessions > 0 ? c.durWeighted / c.sessions : 0 };
  }).sort(function (a, b) { return b.sessions - a.sessions; });

  return {
    source: 'ga4',
    available: true,
    note: note,
    catalogueConfigured: !!catalogue,
    catalogueCount: catalogue ? catalogue.count : 0,
    catalogueError: catalogueError,
    mostViewed: mostViewed,
    mostEngaged: mostEngaged,
    collections: collections,
    otherPages: otherPages,
    searchTerms: searchR
  };
}
