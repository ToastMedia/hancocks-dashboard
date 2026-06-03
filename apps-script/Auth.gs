/**
 * Auth.gs — THE security boundary.
 *
 * IMPORTANT: the front-end login UI is cosmetic and fully bypassable. All real
 * security lives here, server-side. Every data request must present a Google
 * ID token (JWT). We verify it, then require its verified email to be on the
 * allowlist. No token / bad token / wrong audience / off-allowlist -> no data.
 *
 * VERIFICATION METHOD — why tokeninfo, not local RS256:
 *   A correct ID-token check needs the RS256 signature verified against
 *   Google's rotating public keys. Apps Script's Utilities service can SIGN
 *   with RSA but exposes NO public-key VERIFY primitive, so "local"
 *   verification would mean hand-rolling bignum RSA — untestable and a
 *   liability if subtly wrong. Instead we call Google's tokeninfo endpoint,
 *   which performs the cryptographic signature + expiry check on Google's
 *   side, and we additionally enforce audience, issuer and allowlist here.
 *   To avoid a network round-trip on every request we cache a successful
 *   verification keyed by a hash of the token, for the remainder of the
 *   token's own lifetime. This keeps the hot path fast while keeping the
 *   crypto where it belongs — with Google.
 */

var TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
var GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Verify a Google ID token and return its verified, lowercased email.
 * Throws on any failure; the caller maps that to an unauthorised JSON response.
 *
 * @param {string} idToken raw JWT from Google Identity Services
 * @return {string} verified email
 */
function verifyIdTokenAndGetEmail_(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('AUTH: malformed token');
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
  );
  var cachedEmail = cache.get(cacheKey);
  if (cachedEmail) {
    return cachedEmail; // already verified within this token's lifetime
  }

  // Ask Google to validate signature + expiry and decode the claims.
  var resp = UrlFetchApp.fetch(TOKENINFO_URL + encodeURIComponent(idToken), {
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('AUTH: token rejected by Google');
  }
  var claims = JSON.parse(resp.getContentText());

  // Enforce audience, issuer, verified email and expiry on our side too.
  var expectedAud = getProp_('OAUTH_CLIENT_ID');
  if (claims.aud !== expectedAud) {
    throw new Error('AUTH: wrong audience');
  }
  if (GOOGLE_ISSUERS.indexOf(claims.iss) === -1) {
    throw new Error('AUTH: wrong issuer');
  }
  var now = Math.floor(Date.now() / 1000);
  var exp = parseInt(claims.exp, 10);
  if (!exp || exp <= now) {
    throw new Error('AUTH: token expired');
  }
  // tokeninfo returns email_verified as the string "true".
  if (!claims.email || String(claims.email_verified) !== 'true') {
    throw new Error('AUTH: email not verified');
  }

  var email = String(claims.email).toLowerCase();
  if (getAllowlist_().indexOf(email) === -1) {
    throw new Error('AUTH: not authorised');
  }

  // Cache the verified email for the remainder of the token's life
  // (CacheService cap is 6h / 21600s).
  var ttl = Math.max(1, Math.min(exp - now, 21600));
  cache.put(cacheKey, email, ttl);
  return email;
}
