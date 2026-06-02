# Hancocks Dashboard — Phase 1 Setup Runbook

This is the click-by-click list of the **manual Google-console steps** that only
you (henry@toastmedia.co.uk) can do. The code is all in this repo; these steps
wire it to your Google account and deploy it. Do them in order.

> **Cutover note:** Step 1 makes the Sheet private, which breaks the *old*
> public-`gviz` dashboard immediately. The new secure path isn't live until
> step 7. Expect a short window where the live URL errors. Do steps 1–8 in one
> sitting to minimise it.

---

## 1. Make the Google Sheet private
1. Open the Sheet (`1yUb4aqW9VWUHifXscw5Tf8m9qkN5Z-gwkv06LtSH-VU`).
2. **Share** → remove "Anyone with the link". Leave **you** as owner.
   The Apps Script keeps access because it runs **as you**.

## 2. Enable the Google Analytics Data API
1. Go to <https://console.cloud.google.com/> → select (or create) the Cloud
   project that the Apps Script will use. *(If your Apps Script is a "default"
   project, see step 6a to attach a standard Cloud project first — needed for
   the OAuth consent screen anyway.)*
2. **APIs & Services → Library** → search **"Google Analytics Data API"** →
   **Enable**.

## 3. OAuth consent screen (Testing mode)
1. **APIs & Services → OAuth consent screen.**
2. User type **External**, app name e.g. "Hancocks Dashboard", support email = you.
3. Leave **Publishing status = Testing**.
4. **Test users → Add users:** `henry@toastmedia.co.uk` (add the Hancocks client
   email here too when you have it — they must be a test user to sign in).

## 4. Create the OAuth Web Client ID
1. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
2. Application type: **Web application**.
3. **Authorised JavaScript origins:** `https://toastmedia.github.io`
   *(exactly that — no path, no trailing slash).*
4. Leave redirect URIs empty (GIS uses the origin).
5. **Create** → copy the **Client ID** (looks like `xx…apps.googleusercontent.com`).
   This is **public** by design — it is safe in client code.

## 5. Create the Apps Script project and add the code

**Recommended: push from the terminal with clasp** (no manual copy-paste).
See [§ Pushing with clasp](#pushing-with-clasp) below for the full one-time
setup. In short:
```bash
npm install -g @google/clasp
clasp login                                   # opens your browser
# Create a standalone project (one time):
clasp create --type standalone --title "Hancocks London Dashboard"
# clasp writes a .clasp.json — set "rootDir" to "apps-script" (see example file),
# then push everything in apps-script/ (the 7 .gs files + appsscript.json):
clasp push -f
clasp open                                     # opens the project in the editor
```

**Manual alternative:** at <https://script.google.com> → **New project**,
recreate each file from `apps-script/` (same names: `Config.gs`, `Auth.gs`,
`Code.gs`, `SheetProvider.gs`, `GA4Provider.gs`, `ValueLayer.gs`, `Modules.gs`),
then **Project Settings → "Show appsscript.json manifest in editor" → ON** and
paste in `apps-script/appsscript.json`.

Either way, confirm the manifest has `executeAs: USER_DEPLOYING` and
`access: ANYONE_ANONYMOUS` and the three OAuth scopes.

## 6. Set Script Properties (the server-side secrets)
**Project Settings → Script Properties → Add script property** (4 entries):

| Property | Value |
|---|---|
| `SHEET_ID` | `1yUb4aqW9VWUHifXscw5Tf8m9qkN5Z-gwkv06LtSH-VU` |
| `GA4_PROPERTY_ID` | `465868062` |
| `OAUTH_CLIENT_ID` | the Client ID from step 4 |
| `ALLOWLIST` | `henry@toastmedia.co.uk` (comma-separate to add the client later) |

**6a. (If prompted) attach a standard Cloud project:** Project Settings →
**Google Cloud Platform (GCP) Project → Change project** → enter the project
number from step 2. This must be the same project where you enabled the GA4 API
and made the consent screen.

## 7. Deploy the web app
1. Editor → **Deploy → New deployment → type: Web app**.
2. **Execute as:** *Me (henry@…)*. **Who has access:** *Anyone*.
3. **Deploy** → authorise the scopes when prompted (Sheets read, Analytics read,
   external requests). → copy the **Web app URL** (ends in `/exec`).

## 8. Point the front-end at your deployment
In `hancocks-dashboard.html`, edit the `CONFIG` block near the bottom:
```js
const CONFIG = {
  OAUTH_CLIENT_ID: '<paste Client ID from step 4>',
  WEB_APP_URL: '<paste Web app URL from step 7>',
  ...
};
```
Commit & push. GitHub Pages serves it at
<https://toastmedia.github.io/hancocks-dashboard/hancocks-dashboard.html>.

---

## Verify
- Open the live URL → you should see the **sign-in** screen.
- Sign in with `henry@toastmedia.co.uk` → dashboard loads.
- Sign in with any non-allowlisted Google account → "not authorised", no data.
- GA4 cards: if you skipped step 2, they show a localised "GA4 unavailable"
  message while the sheet cards still work — enable the API and they light up.

## Re-deploying after code changes
Apps Script → **Deploy → Manage deployments → (edit) → New version**. The
`/exec` URL stays the same, so the front-end needs no change.

## Pushing with clasp

[clasp](https://github.com/google/clasp) lets you push the `apps-script/` files
straight from this repo instead of pasting into the editor.

**One-time setup**
1. **Install:** `npm install -g @google/clasp`
2. **Enable the Apps Script API** for your account (once):
   <https://script.google.com/home/usersettings> → turn **Google Apps Script
   API** ON.
3. **Log in:** `clasp login` (opens a browser; authorises clasp on your account).
4. **Get a `.clasp.json`** in the repo root — two ways:
   - **New project:** `clasp create --type standalone --title "Hancocks London Dashboard"`,
     then edit the generated `.clasp.json` so it reads:
     ```json
     { "scriptId": "…the id clasp just created…", "rootDir": "apps-script" }
     ```
   - **Existing project (made in the editor):** copy `.clasp.json.example` to
     `.clasp.json` and paste your **Script ID** (Apps Script → Project Settings
     → IDs → Script ID).

   `.clasp.json` is git-ignored on purpose (this repo is public and it carries
   the script id); `.clasp.json.example` is the committed template.

**Everyday use**
```bash
clasp push -f      # push apps-script/ to the project (overwrites server copy)
clasp open         # open the project in the browser
```
`rootDir: "apps-script"` means clasp pushes the 7 `.gs` files **and**
`appsscript.json` from that folder — nothing else. After pushing code changes
you still need to cut a **new deployment version** (SETUP step "Re-deploying").

> clasp pushes source only. It cannot create the OAuth client, set Script
> Properties, or click "Deploy" for you — those stay manual (steps 3–7).

## Phase 2 note (not now)
Site-search **terms** only return from GA4 if `search_term` is registered as a
**custom dimension** (Admin → Custom definitions) — a ~5-min step before that
panel can work.
