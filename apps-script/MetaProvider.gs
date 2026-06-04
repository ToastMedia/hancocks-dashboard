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
 *
 * Metric notes (current as of the 2025 v21/v22 changes):
 *   - profile_views / website_clicks (time series) were DEPRECATED → use
 *     profile_visits and profile_links_taps (metric_type=total_value).
 *   - audience_city / audience_age_gender DEPRECATED → use follower_demographics
 *     (metric_type=total_value, period=lifetime, breakdown=age|gender|city).
 *   - story 'impressions' → 'views'; story insights exist only for ACTIVE
 *     stories (last ~24h), so a period total is not available historically.
 */

var META_BASE = 'https://graph.facebook.com/v22.0';

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

/** Map a 7/30/90 window to the timeframe enum follower_demographics accepts. */
function metaTimeframe_(windowDays) {
  if (windowDays <= 14) return 'last_14_days';
  if (windowDays <= 30) return 'last_30_days';
  return 'last_90_days';
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

/**
 * An aggregated account metric over the window using the newer total_value
 * shape (e.g. profile_visits, profile_links_taps). Falls back to summing a time
 * series if total_value isn't present. -> number
 */
function metaAccountTotalValue_(metric, windowDays, extra) {
  var r = metaUnixRange_(windowDays);
  var p = { metric: metric, metric_type: 'total_value', period: 'day', since: r.since, until: r.until };
  if (extra) Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
  var d = metaFetch_('/' + metaIgId_() + '/insights', p);
  var node = d.data && d.data[0];
  if (!node) return 0;
  if (node.total_value && typeof node.total_value.value !== 'undefined') return node.total_value.value || 0;
  return (node.values || []).reduce(function (a, v) { return a + (v.value || 0); }, 0);
}

/** Recent media ranked by engagement (likes + comments + saves). -> [{...}] */
function metaTopMedia_(limit) {
  var base = 'caption,media_type,permalink,timestamp,like_count,comments_count';
  var d;
  // Try to pull 'saved' via field expansion; if a media type rejects it, fall
  // back to the base fields so the posts table still renders.
  try {
    d = metaFetch_('/' + metaIgId_() + '/media', { fields: base + ',insights.metric(saved)', limit: limit || 12 });
  } catch (e) {
    d = metaFetch_('/' + metaIgId_() + '/media', { fields: base, limit: limit || 12 });
  }
  var rows = (d.data || []).map(function (m) {
    var likes = m.like_count || 0, comments = m.comments_count || 0;
    var saves = 0;
    if (m.insights && m.insights.data) {
      m.insights.data.forEach(function (it) {
        if (it.name === 'saved') {
          if (it.total_value && typeof it.total_value.value !== 'undefined') saves = it.total_value.value || 0;
          else if (it.values && it.values[0]) saves = it.values[0].value || 0;
        }
      });
    }
    return {
      caption: (m.caption || '').replace(/\s+/g, ' ').slice(0, 80),
      type: m.media_type || '',
      permalink: m.permalink || '',
      timestamp: m.timestamp || '',
      likes: likes, comments: comments, saves: saves,
      engagement: likes + comments + saves
    };
  });
  rows.sort(function (a, b) { return b.engagement - a.engagement; });
  return rows.slice(0, limit || 10);
}

/**
 * Story views for currently-active stories (last ~24h). Story insights are not
 * available historically, so this is a live snapshot. -> { views, count }
 */
function metaStoryViews_() {
  var d = metaFetch_('/' + metaIgId_() + '/stories', { fields: 'id,media_type,timestamp,insights.metric(views)' });
  var stories = d.data || [];
  var total = 0;
  stories.forEach(function (s) {
    if (s.insights && s.insights.data) s.insights.data.forEach(function (it) {
      if (it.total_value && typeof it.total_value.value !== 'undefined') total += it.total_value.value || 0;
      else if (it.values && it.values[0]) total += it.values[0].value || 0;
    });
  });
  return { views: total, count: stories.length };
}

/**
 * Follower demographics by a single breakdown (age | gender | city).
 * -> [{ key, value }]
 */
function metaFollowerDemographics_(windowDays, breakdown) {
  var d = metaFetch_('/' + metaIgId_() + '/insights', {
    metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value',
    timeframe: metaTimeframe_(windowDays), breakdown: breakdown
  });
  var node = d.data && d.data[0];
  var bd = node && node.total_value && node.total_value.breakdowns && node.total_value.breakdowns[0];
  var results = (bd && bd.results) || [];
  return results.map(function (r) {
    return { key: (r.dimension_values || []).join(', '), value: r.value || 0 };
  }).filter(function (x) { return x.key; });
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
