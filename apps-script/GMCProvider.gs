/**
 * GMCProvider.gs — Google Merchant Centre catalogue via the **Merchant API**
 * (merchantapi.googleapis.com), the supported successor to the now-deprecated
 * Content API for Shopping. Both use the same auth/content OAuth scope.
 *
 * Purpose: the authoritative product catalogue. GA4 only knows page paths;
 * Merchant Centre knows which of those paths are real products, their proper
 * titles, their category, and their image. We join the two on URL path.
 *
 * Hancocks' product pages are flat root-level slugs
 * (e.g. /4-06ct-elongated-asscher-diamond-platinum-ring), so the catalogue's
 * `link` path matches GA4 `pagePath` directly.
 *
 * SETUP (one-off):
 *   1. Cloud Console → enable the "Merchant API".
 *   2. appsscript.json → add scope .../auth/content  (forces a re-authorise).
 *   3. Script Property GMC_MERCHANT_ID = your Merchant Centre account id.
 * Until GMC_MERCHANT_ID is set this provider is inert and the Product
 * Intelligence section falls back to URL-derived names (no images/categories).
 */

/** Merchant Centre account id, or '' if not configured. */
function gmcMerchantId_() {
  return PropertiesService.getScriptProperties().getProperty('GMC_MERCHANT_ID') || '';
}

/** True once GMC_MERCHANT_ID is set. */
function gmcConfigured_() {
  return !!gmcMerchantId_();
}

/**
 * Normalise any URL or path to a comparable path key:
 * strip protocol+host, query and hash, lowercase, drop trailing slash.
 * '/' stays '/'. Shared by GA4 paths and GMC links so the join lines up.
 */
function normalizePath_(urlOrPath) {
  var s = String(urlOrPath || '').trim();
  s = s.replace(/^https?:\/\/[^\/]+/i, '');   // drop scheme + host if present
  s = s.split('#')[0].split('?')[0];          // drop hash + query
  s = s.toLowerCase();
  if (s.length > 1) s = s.replace(/\/+$/, ''); // drop trailing slash (keep bare '/')
  if (!s) s = '/';
  return s;
}

/**
 * Pick a single human collection from a product's category data.
 * Prefers the merchant's own productType taxonomy (top level), then Google's
 * product category leaf. Returns '' when nothing usable.
 */
function gmcCollectionFromTypes_(productTypes, googleProductCategory) {
  var t = '';
  if (productTypes && productTypes.length) {
    t = String(productTypes[0] || '');
    // "Rings > Engagement Rings > Solitaire" -> "Rings" (broad, few buckets).
    t = t.split('>')[0].trim();
  }
  if (!t && googleProductCategory) {
    var g = String(googleProductCategory);
    var parts = g.split('>');
    t = parts[parts.length - 1].trim();      // Google's leaf is the specific one
  }
  return t;
}

/**
 * Fetch all products from the Merchant API products sub-API, following
 * pagination. Bounded to MAX_PAGES so a huge catalogue can't run us out of
 * quota/time. Each product carries its fields under `attributes`.
 * -> [ product resource, ... ]
 */
function gmcFetchAllProducts_() {
  var merchantId = gmcMerchantId_();
  if (!merchantId) throw new Error('GMC_MERCHANT_ID not set.');

  // Merchant API: accounts/{account}/products, up to 1000 per page.
  var base = 'https://merchantapi.googleapis.com/products/v1beta/accounts/' +
    encodeURIComponent(merchantId) + '/products?pageSize=1000';
  var MAX_PAGES = 40;                          // 40 × 1000 = 40k product safety cap
  var out = [];
  var pageToken = '';

  for (var i = 0; i < MAX_PAGES; i++) {
    var url = base + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    var text = resp.getContentText();
    if (code === 403) {
      throw new Error('GMC 403: enable the "Merchant API" in the Cloud project ' +
        'and ensure the .../auth/content scope is authorised (re-deploy). ' + text);
    }
    if (code !== 200) {
      throw new Error('GMC API error ' + code + ': ' + text);
    }
    var json = JSON.parse(text);
    (json.products || []).forEach(function (p) { out.push(p); });
    pageToken = json.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

/**
 * The catalogue as a path-keyed lookup for joining to GA4:
 *   { configured, count, byPath: { '/slug': { title, image, collection } } }
 * Cached for 6h (compact form) to avoid refetching on every dashboard load.
 * Throws on hard API errors so the caller can decide to fall back gracefully.
 */
function gmcBuildCatalogue_() {
  if (!gmcConfigured_()) return { configured: false, count: 0, byPath: {} };

  var cache = CacheService.getScriptCache();
  var cacheKey = 'gmc_catalogue_' + gmcMerchantId_();
  var cached = cache.get(cacheKey);
  if (cached) {
    var parsed = JSON.parse(cached);
    return { configured: true, count: parsed.count, byPath: parsed.byPath };
  }

  var products = gmcFetchAllProducts_();
  var byPath = {};
  products.forEach(function (p) {
    var a = p.attributes || {};               // Merchant API nests fields here
    if (!a.link) return;
    var key = normalizePath_(a.link);
    if (!key || key === '/') return;
    // First write wins; many feeds carry per-variant rows sharing a link.
    if (byPath[key]) return;
    byPath[key] = {
      title: String(a.title || '').trim(),
      image: a.imageLink || '',
      collection: gmcCollectionFromTypes_(a.productTypes, a.googleProductCategory)
    };
  });

  var payload = { count: Object.keys(byPath).length, byPath: byPath };
  try {
    var serialised = JSON.stringify(payload);
    if (serialised.length < 95000) cache.put(cacheKey, serialised, 21600); // 6h
  } catch (e) { /* cache is best-effort; ignore overflow */ }

  return { configured: true, count: payload.count, byPath: byPath };
}
