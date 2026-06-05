/**
 * Config.gs — central configuration for the Hancocks dashboard data router.
 *
 * SECRETS / DEPLOYMENT-SPECIFIC VALUES live in Script Properties, never here:
 *   SHEET_ID         — the (now PRIVATE) Google Sheet id
 *   GA4_PROPERTY_ID  — e.g. 465868062
 *   OAUTH_CLIENT_ID  — the Web OAuth client id; used as the JWT `aud` we accept
 *   ALLOWLIST        — comma-separated lowercase emails allowed to read data
 *
 * Set them in: Apps Script editor → Project Settings → Script Properties.
 * Code in this repo is PUBLIC, so nothing sensitive is committed here.
 */

/** Read a required Script Property or throw a clear error. */
function getProp_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) {
    throw new Error('Missing Script Property: ' + key + '. Set it in Project Settings → Script Properties.');
  }
  return v;
}

/** Parsed, lowercased allowlist of emails permitted to read any data. */
function getAllowlist_() {
  return getProp_('ALLOWLIST')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s.length > 0; });
}

/**
 * The 10 tracked events, with type and the column header used in the sheet's
 * wide-format tabs. Order here is the canonical display order.
 */
var EVENTS = [
  { key: 'whatsapp_click',    label: 'WhatsApp',       type: 'conversion', col: 'WhatsApp' },
  { key: 'phone_call_click',  label: 'Phone Call',     type: 'conversion', col: 'Call Us' },
  { key: 'enquiry_click',     label: 'Enquiry',        type: 'conversion', col: 'Enquiry' },
  { key: 'appointment_click', label: 'Appointment',    type: 'conversion', col: 'Book Appt' },
  { key: 'email_click',       label: 'Email Click',    type: 'conversion', col: 'Email' },
  { key: 'newsletter_signup', label: 'Newsletter',     type: 'engagement', col: 'Newsletter' },
  { key: 'site_search',       label: 'Site Search',    type: 'engagement', col: 'Site search' },
  { key: 'content_click',     label: 'Content Click',  type: 'engagement', col: 'Content click' },
  { key: 'scroll_50_product', label: 'Product Scroll', type: 'engagement', col: '50% scroll' },
  { key: 'share_click',       label: 'Share',          type: 'engagement', col: 'Share' }
];

/**
 * Commercial Momentum Score weights (tunable). Higher = more commercially
 * valuable signal. Mirrored on the front end for display only; this server
 * copy is authoritative for any server-computed momentum.
 */
var MOMENTUM_WEIGHTS = {
  appointment_click: 10,
  enquiry_click: 6,
  phone_call_click: 5,
  whatsapp_click: 4,
  email_click: 4,
  newsletter_signup: 2,
  content_click: 1,
  scroll_50_product: 1,
  site_search: 1,
  share_click: 1
};

/** Sheet tab names — never rename these; new sources get NEW tabs. */
var TABS = {
  eventSummary: 'Event Summary',
  dailyTrend: 'Daily Trend',
  bySource: 'By Traffic Source',
  byLocation: 'By Location',
  byDevice: 'By Device',
  byDow: 'By Day of Week'
};

/**
 * Module registry: maps a requested module name to the function that builds
 * its normalised payload. Adding a module = add a key here + a builder.
 */
var MODULES = {
  conversions: function (params) { return buildConversionsModule_(params); }, // Module 1 (sheet)
  business:    function (params) { return buildBusinessModule_(params); },    // Module 5 (sheet)
  audience:    function (params) { return buildAudienceModule_(params); },    // Module 3 slice (sheet) + GA4
  traffic:     function (params) { return buildTrafficModule_(params); },     // Module 2 slice (sheet) + GA4
  localvisibility: function (params) { return buildLocalVisibilityModule_(params); }, // Google Business Profile
  instagram:   function (params) { return buildInstagramModule_(params); },   // Instagram (Meta Graph API)
  products:    function (params) { return buildProductsModule_(params); }     // Product Intelligence (GA4 page-level)
};
