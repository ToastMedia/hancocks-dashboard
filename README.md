# Hancocks London — Analytics Dashboard

A secure, insight-led analytics dashboard for Hancocks London (luxury fine
jewellery). Dark-luxury UI, served from GitHub Pages, with all data flowing
through an authenticated Apps Script middleman.

**Live:** https://toastmedia.github.io/hancocks-dashboard/hancocks-dashboard.html
**Setup:** see [`SETUP.md`](./SETUP.md) for the one-time Google-console steps.

---

## Architecture

```
Browser (hancocks-dashboard.html)
  │  Google Identity Services → ID token (JWT)
  │  POST text/plain { idToken, module, params }   (no CORS preflight)
  ▼
Apps Script Web App  ── THE security boundary ──
  Code.gs      router: doPost → verify token → dispatch module
  Auth.gs      verify Google ID token (via Google) + email allowlist
  Config.gs    secrets (Script Properties), event defs, momentum weights, module registry
  Modules.gs   module builders: compose providers + value layer → normalised JSON
  ValueLayer.gs windowing, Commercial Momentum, So-What insight header
  Providers:
    SheetProvider.gs   reads the PRIVATE Google Sheet (6 tabs, event-count data)
    GA4Provider.gs     GA4 Data API runReport (sessions, pages, durations)
    GBPProvider.gs     Google Business Profile (local visibility)
    MetaProvider.gs    Instagram (Meta Graph API)
    GMCProvider.gs     Merchant Centre catalogue (product titles, categories, images)
```

### Security model (read this)
- The **login UI is bypassable** and is *not* the security boundary.
- Real security is **server-side**: every request must carry a Google ID token,
  which Apps Script verifies (signature + expiry via Google, then audience,
  issuer, verified-email and an **email allowlist** on our side) **before** any
  data is read. No valid token / off-allowlist → no data.
- The Sheet is **private**; the web app reaches it because it runs as the owner.
- `SHEET_ID`, `GA4_PROPERTY_ID`, `OAUTH_CLIENT_ID`, `ALLOWLIST` live in **Script
  Properties** — never in client code. (The OAuth client id *is* in the client,
  but it is public by design.)

### Data router & providers (extensibility)
- The dashboard requests a **module** (`conversions`, `business`, `traffic`,
  `audience`), never a tab. `Config.MODULES` maps module → builder.
- Each builder pulls from whatever **provider** fits. Adding a source (Meta,
  Pinterest, TikTok…) is a **new provider file**, not a refactor. New sources
  write to **new** sheet tabs; the existing 6 are never restructured.
- The front end renders from registry-style render functions, so new cards drop
  in declaratively.

---

## Modules & data sources

| Module | From Sheet | From GA4 API |
|---|---|---|
| **1 Conversion Performance** | 10 scorecards + %change, conversion trend, best day, funnel | *(P2: best hour, true rate)* |
| **5 Business Intelligence** | funnel, contact-channel split, newsletter/share, weekly/monthly | — |
| **2 Traffic & Acquisition** | referral sources, campaigns | sessions by channel, new vs returning, top landing pages, engagement |
| **3 Audience & Engagement** | countries/cities, device, day-of-week | avg session duration, pages/session, new vs returning |

> The sheet is **100% event-count data** — no sessions/pageviews/page paths.
> Anything session/traffic/page based comes from GA4.

## The value layer (the point of the product)
- **So-What header** — auto-generated plain-English summary: biggest mover,
  momentum direction, one watch-out (rules-based, server-side).
- **Commercial Momentum Score** — single weighted index (weights in
  `Config.MOMENTUM_WEIGHTS`, tunable), shown for the window + %change + sparkline.
- **Source Efficiency** — channels ranked by **enquiries & appointments per 100
  sessions** (sheet conversions ⋈ GA4 sessions), not raw volume.

Design principle: every module leads with the **headline number + direction +
context**; charts support the judgement, they don't replace it.

---

## Phasing
- **Phase 1 (this build):** Modules 1 & 5 from sheet; core GA4 traffic cuts;
  sheet slices of Modules 2 & 3; value layer (So-What, Momentum, Source
  Efficiency). Dark/gold shell, 7/30/90 toggle, refresh, loading/error states.
- **Phase 1.5:** weekly digest email (Apps Script).
- **Phase 2:** best hour, per-page scroll, exit pages, site-search terms
  (needs custom dimension), YoY/seasonality, targets & pace-to-goal,
  anomaly flags, client exec view, social platforms.

## Repo layout
```
hancocks-dashboard.html   front-end (single file, GitHub Pages)
apps-script/              server-side web app (deploy per SETUP.md)
  appsscript.json  Config.gs  Auth.gs  Code.gs
  SheetProvider.gs  GA4Provider.gs  ValueLayer.gs  Modules.gs
SETUP.md                  one-time Google-console runbook
```
