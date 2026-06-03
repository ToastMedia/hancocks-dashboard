/**
 * MetaProvider.gs — Instagram (via the Meta Graph API).
 *
 * Uses UrlFetchApp (no Google scope needed; external_request already declared).
 * Needs two Script Properties:
 *   IG_USER_ID         — the Instagram Business account id (numeric)
 *   META_ACCESS_TOKEN  — a long-lived token with instagram_basic +
 *                        instagram_manage_insights + pages_read_engagement +
 *                        pages_show_list
 *
 * NOTE: Meta deprecates/renames Instagram insight metrics fairly often, so this
 * is written defensively and each call is wrapped (tryMeta_) — if a metric goes
 * away, that card degrades but the rest keep working. Long-lived tokens last
 * ~60 days; metaRefreshToken_() extends one before it lapses.
 */

var META_BASE = 'https://graph.facebook.com/v21.0';

function metaToken_() { return getProp_('META_ACCESS_TOKEN'); }
function metaIgId_() { return getProp_('IG_USER_ID'); }

function metaFetch_(path, params) {
  params = params || {};
  params.access_token = metaToken_();
  var q = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var resp = UrlFetchApp.fetch(META_BASE + path + '?' + q, { muteHttpExceptions: true });
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code !== 200) throw new Error('Meta API error ' + code + ': ' + text);
  return JSON.parse(text);
}

/** Profile basics. -> { username, followers, mediaCount, picture } */
function metaProfile_() {
  var d = metaFetch_('/' + metaIgId_(), { fields: 'username,followers_count,media_count,profile_picture_url' });
  return {
    username: d.username || '',
    followers: d.followers_count || 0,
    mediaCount: d.media_count || 0,
    picture: d.profile_picture_url || ''
  };
}

function metaUnixRange_(windowDays) {
  var until = Math.floor(Date.now() / 1000);
  return { since: until - windowDays * 86400, until: until };
}

/** A daily insight metric (e.g. reach, follower_count) as [{date,value}]. */
function metaDaySeries_(metric, windowDays) {
  var r = metaUnixRange_(windowDays);
  var d = metaFetch_('/' + metaIgId_() + '/insights', {
    metric: metric, period: 'day', since: r.since, until: r.until
  });
  var vals = (d.data && d.data[0] && d.data[0].values) || [];
  return vals.map(function (v) {
    return { date: String(v.end_time || '').slice(0, 10), value: v.value || 0 };
  });
}

/** Recent media ranked by engagement (likes + comments). -> [{...}] */
function metaTopMedia_(limit) {
  var d = metaFetch_('/' + metaIgId_() + '/media', {
    fields: 'caption,media_type,permalink,timestamp,like_count,comments_count',
    limit: limit || 12
  });
  var rows = (d.data || []).map(function (m) {
    var likes = m.like_count || 0, comments = m.comments_count || 0;
    return {
      caption: (m.caption || '').replace(/\s+/g, ' ').slice(0, 80),
      type: m.media_type || '',
      permalink: m.permalink || '',
      timestamp: m.timestamp || '',
      likes: likes, comments: comments, engagement: likes + comments
    };
  });
  rows.sort(function (a, b) { return b.engagement - a.engagement; });
  return rows.slice(0, limit || 10);
}

/**
 * TOKEN MAINTENANCE — exchange the current long-lived token for a fresh one
 * (extends ~60 days). Run on a time trigger every ~50 days, or manually.
 * Requires META_APP_ID + META_APP_SECRET in Script Properties.
 */
function metaRefreshToken_() {
  var props = PropertiesService.getScriptProperties();
  var resp = UrlFetchApp.fetch(META_BASE + '/oauth/access_token?' + [
    'grant_type=fb_exchange_token',
    'client_id=' + encodeURIComponent(props.getProperty('META_APP_ID')),
    'client_secret=' + encodeURIComponent(props.getProperty('META_APP_SECRET')),
    'fb_exchange_token=' + encodeURIComponent(props.getProperty('META_ACCESS_TOKEN'))
  ].join('&'), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Token refresh failed: ' + resp.getContentText());
  var token = JSON.parse(resp.getContentText()).access_token;
  if (token) props.setProperty('META_ACCESS_TOKEN', token);
  return 'ok';
}

/**
 * DISCOVERY HELPER — run manually to find your IG Business account id.
 * Lists the Pages your token can see and their connected IG account.
 */
function metaListIgAccounts() {
  var d = metaFetch_('/me/accounts', { fields: 'name,instagram_business_account{id,username}' });
  Logger.log(JSON.stringify(d, null, 2));
}
