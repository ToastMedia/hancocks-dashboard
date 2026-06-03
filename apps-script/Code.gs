/**
 * Code.gs — the data router (web app entry point).
 *
 * The dashboard never asks for a specific tab; it asks for a MODULE. This
 * router authenticates every request, then dispatches to the module builder
 * registered in Config.gs (MODULES), which in turn pulls from whatever
 * provider(s) fit (SheetProvider today, GA4Provider in Phase 1).
 *
 * Transport: the front-end POSTs a text/plain body (a JSON string) so the
 * browser treats it as a "simple request" and skips the CORS preflight that
 * Apps Script's ContentService cannot answer. Body shape:
 *   { "idToken": "...", "module": "conversions", "params": { "window": 30 } }
 */

function doPost(e) {
  try {
    var body = parseBody_(e);
    var idToken = body.idToken;
    var moduleName = body.module;
    var params = body.params || {};

    // --- security boundary: verify token + allowlist BEFORE any data access.
    var email = verifyIdTokenAndGetEmail_(idToken);

    var builder = MODULES[moduleName];
    if (!builder) {
      return json_({ ok: false, error: 'Unknown module: ' + String(moduleName) }, 400);
    }

    // Normalise the requested window to one of the supported sizes.
    params.window = normaliseWindow_(params.window);

    var data = builder(params);
    return json_({
      ok: true,
      module: moduleName,
      window: params.window,
      requestedBy: email,
      generatedAt: new Date().toISOString(),
      data: data
    });
  } catch (err) {
    var msg = String(err && err.message ? err.message : err);
    var isAuth = msg.indexOf('AUTH:') === 0;
    return json_({ ok: false, error: isAuth ? 'Not authorised' : msg }, isAuth ? 401 : 500);
  }
}

/**
 * doGet exists only so the deployment is reachable / health-checkable in a
 * browser. It returns NO data — all data flows through doPost behind auth.
 */
function doGet() {
  return json_({ ok: true, service: 'hancocks-dashboard', message: 'POST with an ID token to read data.' });
}

/** Parse the text/plain JSON body; tolerate form-style fallbacks. */
function parseBody_(e) {
  if (e && e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (err) {
      throw new Error('Invalid request body (expected JSON).');
    }
  }
  // Fallback for ?idToken=&module= style (not used by the app, handy for tests).
  if (e && e.parameter && e.parameter.module) {
    return {
      idToken: e.parameter.idToken,
      module: e.parameter.module,
      params: e.parameter
    };
  }
  throw new Error('Empty request body.');
}

/** Clamp the date window to the supported 7 / 30 / 90 day toggle. */
function normaliseWindow_(w) {
  var n = parseInt(w, 10);
  return (n === 7 || n === 30 || n === 90) ? n : 30;
}

/**
 * ContentService JSON response. Note: Apps Script ignores the status code on
 * ContentService output (responses are 200 + redirect), so we ALSO carry an
 * `ok` boolean in the payload that the front-end checks. The `status` arg is
 * kept for clarity / future migration.
 */
function json_(obj, status) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
