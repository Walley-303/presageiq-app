# PresageIQ — Project Bible

Last updated: 2026-04-15 | Commit: 7d3041b

---

## PROJECT OVERVIEW

PresageIQ is a business intelligence SaaS for Kansas City food/retail operators,
built and operated by Towns & Walley Intelligence. Two faces:

- **Public marketing site** (presageiq.com) → sells four consulting tiers
- **Internal workspace** (presageiq.com/consult) → runs live sessions with clients

Hosted on Railway. Auto-deploys from GitHub push to `main`.

- **GitHub repo:** https://github.com/Walley-303/presageiq-app
- **Local path:** `C:\Users\usgho\OneDrive\Towns & Walley Intelligence\PresageIQ\presageiq-app`
- **Parent org folder:** `C:\Users\usgho\OneDrive\Towns & Walley Intelligence\PresageIQ\` (contains Archive, Brand & Marketing, Business Docs, Client Work, Decks)

---

## TECH STACK

- **Runtime:** Node.js (Express 4)
- **Database:** PostgreSQL (Railway-managed, accessed via pg Pool)
- **AI:** OpenAI GPT-4o-mini via `/api/chat` proxy (Anthropic-style response shape)
- **Scheduler:** node-cron (daily + weekly + monthly background jobs)
- **Hosting:** Railway (env vars set in Railway dashboard)
- **Frontend:** Vanilla JS / HTML — no build step, no bundler, no framework

---

## FILE STRUCTURE

```
presageiq-app/
├── server.js           — Express app, all routes, DB init, cron schedule
├── businessIntel.js    — Business intel pipeline (Places, search, scraping, AI)
├── collectors.js       — Background data collectors (Reddit, GDELT, KC Open Data, etc.)
├── package.json        — Dependencies
├── Procfile            — Railway process declaration
├── PROJECT_BIBLE.md    — This file
└── public/
    ├── presage-consult.html  — PUBLIC marketing site (served at /)
    ├── consult.html          — INTERNAL workspace (served at /consult)
    ├── index.html            — MarketIQ dashboard (served at /marketiq)
    └── presage-audit.html    — LEGACY (kept for reference, not linked)
```

---

## PAGE ROUTES (server.js)

| Route | Serves |
|---|---|
| `GET /` | `public/presage-consult.html` (marketing + contact form) |
| `GET /consult` | `public/consult.html` (internal client workspace) |
| `GET /marketiq` | `public/index.html` (market intelligence dashboard) |
| `GET /dashboard` | 301 redirect → `/marketiq` |
| `GET /presage-audit.html` | 301 redirect → `/consult` |
| `GET /presage-consult.html` | 301 redirect → `/` |
| `GET /presage-consult` | 301 redirect → `/` |
| `GET *` | fallback to `presage-consult.html` |

---

## API ROUTES (server.js)

### AI / Proxy

**POST `/api/chat`**
- Body: `{ model, system, messages[], max_tokens }`
- Proxies to OpenAI chat completions
- Returns: `{ content: [{ text }] }` (Anthropic-style shape for frontend)

**GET `/api/reddit-search?q=&sub=`**
- Proxies to Reddit search JSON API (avoids browser CORS)

### Data Collection (collectors.js)

**POST `/api/intel/collect/:source`**
- source: `reddit | gdelt | kc_open_data | census | foursquare | all`
- Fire-and-forget; returns 202 immediately

**GET `/api/intel/status`**
- Collection log: `by_source` (latest run per source) + `recent_runs[]`

**GET `/api/intel/stats`**
- Counts: community_intel by source, business_profiles by source, neighborhood_profiles

### Community Intelligence (DB)

**GET `/api/intel/community?neighborhood=&business_type=&source=&sentiment=&q=&limit=&offset=`**
- Paginated query of `community_intel` table
- Returns: `{ total, records[] }`

**GET `/api/intel/neighborhoods`**
- All `neighborhood_profiles` joined with business count

**POST `/api/intel/manual`**
- Body: `{ title, body, neighborhoods[], business_types[], sentiment, tags[], source_url }`
- Manual intel entry into `community_intel` table

### Business Intel (per-client, businessIntel.js pipeline)

**GET `/api/intel/business/:clientId`**
- Returns current intel status + all gathered data for client
- Status values: `not_started | pending | gathering | synthesizing | complete | error`

**POST `/api/intel/business/:clientId`**
- Body (optional): `{ force: true }` → deletes existing intel rows before re-gathering
- Triggers `gatherBusinessIntel()` in background (fire-and-forget → 202)
- Uses `client.bizname || client.name` as the business name
- Client profile data is NEVER deleted, even with force=true

**POST `/api/intel/press-live/:clientId`**
- Calls `scrapeKCReviewSources(businessName)` live (fixed KC sites fallback)
- Returns: `{ businessName, results[{ source, url, snippets[] }], count }`

**POST `/api/intel/web-search/:clientId`**
- Body (optional): `{ query }` (defaults to client's business name)
- Runs `searchAndScrapeWeb()` with the client's business name + neighborhood
- Returns: `{ businessName, query, results[{ source, url, snippet, relevance }], count }`

### Menu Uploads (Audit tier)

**POST `/api/intel/menu-upload/:clientId`**
- Body: `{ imageBase64, mimeType, filename, label }`
- Calls `extractMenuFromImage()` → GPT-4o-mini vision → extracts menu items
- Stores in `menu_uploads` table
- Returns: `{ success, upload_id, items[], count }`

**GET `/api/intel/menu-uploads/:clientId`**
- Lists all saved menu uploads for a client

**GET `/api/intel/menu-uploads/:clientId/image/:uploadId`**
- Returns raw image binary (for ↗ View links)

### Clients

**GET `/api/clients`** — All clients, sorted `created_at DESC`

**GET `/api/clients/:id`** — Single client

**PATCH `/api/clients/:id`**
- Accepts any of: `status, name, email, service, concept, neighborhood, phone, notes, bizname, biztype, business_name, business_type, years_in_business, avg_check, annual_revenue, size, challenge, pre_audit_notes`
- Used by consult.html for debounced profile auto-save
- Status must be `pending | active | complete` if provided

**POST `/api/contact`**
- Body: `{ name, email, service, concept, neighborhood, phone, notes, bizname, biztype }`
- Inserts into `clients` table
- Fires confirmation emails via Resend (if `RESEND_API_KEY` set)
- Auto-triggers `gatherBusinessIntel()` if `service === 'audit'`
- Returns: `{ success, id }`

---

## DATABASE TABLES (auto-created/migrated by initDb() on startup)

### clients
```
id, created_at, name, email, service, concept, neighborhood, phone, notes, status
bizname, biztype,
business_name, business_type, years_in_business,
avg_check, annual_revenue, size, challenge, pre_audit_notes
```
Status: `pending | active | complete`

### business_intel (one row per client)
```
id, client_id (FK→clients), business_name, place_id,
place_data (JSONB), competitors (JSONB), website_data (JSONB),
community_mentions (JSONB), ai_profile (TEXT), ai_competitors (TEXT),
ai_menu_items (TEXT), ai_photo_subjects (TEXT),
status, error_message, gathered_at
```
UNIQUE on client_id. Deleted + re-inserted on force re-scan.

### menu_uploads
```
id, client_id (FK→clients), filename, mime_type,
image_data (base64 TEXT), label, extracted_items (JSON TEXT), uploaded_at
```
Labels: `Menu | Happy Hour | Brunch | Seasonal | Drinks | Dessert | Other`

### community_intel
```
id, source (reddit|gdelt|manual|kc_open_data), source_id,
title, body, url, author, score,
neighborhoods TEXT[], business_types TEXT[], sentiment, tags TEXT[],
post_date, collected_at, raw_data (JSONB)
UNIQUE(source, source_id)
```

### neighborhood_profiles
```
id, name (UNIQUE), zip, population, median_income, median_age,
owner_occupied, renter_occupied, pct_poverty, pct_college,
pct_white, pct_black, pct_hispanic,
raw_data (JSONB), source, collected_at
```

### business_profiles (KC Open Data + Foursquare)
```
id, source, source_id, name, dba_name, address, neighborhood, zip,
lat, lng, business_type, license_type, license_status,
foursquare_id, foursquare_rating, raw_data (JSONB),
collected_at, updated_at
UNIQUE(source, source_id WHERE source_id IS NOT NULL)
```

### collection_log
```
id, source, started_at, completed_at,
status (running|success|error),
records_fetched, records_upserted, error_message,
triggered_by (scheduler|manual)
```

---

## BUSINESSINTEL.JS PIPELINE

### `gatherBusinessIntel(pool, clientId, businessName, neighborhood)`

1. **`findBusiness(name, neighborhood)`** → Google Places API (Text Search)
2. **`findCompetitors(lat, lng, radius=8km)`** → Google Places API (Nearby Search)
3. **`scrapeWebsite(place.websiteUri)`** → fetch + strip HTML, pull menu/home text
4. **Parallel block:**
   - `getCommunityMentions(pool, bizName)` → queries `community_intel` DB
   - `searchAndScrapeWeb(bizName, neighborhood)` → Google Custom Search across 22 KC sites + fetches + extracts snippets
   - `scrapeInstagram(bizName)` → finds IG handle via Google, scrapes public profile, extracts bio/captions + AI sentiment
5. **Parallel block:**
   - `analyzePhotos(photos, openaiKey)` → GPT-4o-mini vision on Google Maps photos → `ai_photo_subjects: [{ item, photos }]`
   - `extractMenuItems(menuText, ...)` → GPT-4o-mini extracts structured menu items
6. **`synthesizeIntel(...)`** → GPT-4o-mini writes `ai_profile` + `ai_competitors`

Writes to `business_intel` table (status: `gathering → synthesizing → complete | error`).

### Exported Functions

- `gatherBusinessIntel` — main orchestrator
- `extractMenuFromImage` — vision AI on uploaded menu photo
- `scrapeKCReviewSources` — legacy fixed-site scraper (fallback)
- `searchAndScrapeWeb` — Google Custom Search + page fetch + relevance scoring
- `scrapeInstagram` — Instagram public profile scrape + AI sentiment

### `searchAndScrapeWeb(businessName, neighborhood)`

Runs two Google Custom Search queries:
- `"[businessName] [neighborhood] Kansas City"`
- `"[businessName] Kansas City review"`

For each result URL:
- Skips social media (facebook, twitter, x, instagram, tiktok, linkedin, youtube, yelp, tripadvisor)
- Skips PDFs, DOC, XLS
- Fetches HTML, strips tags, searches for business name
- Returns `{ source, url, snippet, relevance (low|medium|high) }`

Falls back to `scrapeKCReviewSources()` if `GOOGLE_SEARCH_API_KEY` or `GOOGLE_SEARCH_CX` not configured.

### `scrapeInstagram(businessName)`

- Finds Instagram handle via Google Custom Search (`site:instagram.com`)
- Fetches public profile page (no auth needed)
- Extracts bio from meta tags + embedded `_sharedData` JSON
- Extracts up to 12 recent post captions + engagement counts
- Runs GPT-4o-mini sentiment analysis on captions
- Returns `{ handle, bio, recentPosts[], overallSentiment }`

---

## CONSULT.HTML — INTERNAL WORKSPACE (/consult)

Two-state SPA (no page reload):

### STATE 1 — Client Queue (default)
- Loads all clients via `GET /api/clients`
- Cards show: name, tier badge, neighborhood, date, status badge
- Filter chips: `All | Pending | Active | Complete`
- "New Session" button → modal to create client + enter immediately
- Status dropdowns update client via `PATCH /api/clients/:id`

### STATE 2 — Session View
- Topbar: ← Back to Queue | [Client Name] | [Tier Badge]
- Sidebar: tier-based module nav with progress bar + checkmarks
- Content area: panels swap on nav click

### Tier Routing
`tierFromService(service)` maps service string → tier key:
- `'launch'` if includes 'launch'
- `'audit'` if includes 'audit'
- `'retainer'` if includes 'retainer'
- default: `'consult'`

### TIER_MODULES (sidebar nav per tier)

| Tier | Modules |
|---|---|
| launch | Concept Setup, Market Viability, Community Intel, Financial Projection, Funding Pathways, Launch Report |
| consult | Client Setup, Review Signals, Competitor Intel, KC Press Coverage, Consult Brief |
| audit | Client Setup, Review Signals, Competitor Intel, Menu Analysis, Inventory & Supply, KC Press Coverage, Executive Brief |
| retainer | Client Setup, Monthly Signals, Trend Analysis, Monthly Brief |

### Session State Variables
```
currentClientId, currentTier, currentClient (full object),
moduleDone {}, intelPollTimer, menuItems [], vendorItems [],
_profileSaveTimer (for debounced auto-save)
```

### Client Profile Auto-Save (FIX 3)
- `attachProfileAutoSave()` binds `input` + `change` listeners to all setup fields on session enter
- `scheduleProfileSave()` debounces saves by 1000ms
- `saveClientProfile()` PATCHes all setup fields to `/api/clients/:id`
- Tracked fields: `s-client, s-biz, s-type, s-nbhd, s-years, s-revenue, s-check, s-size, s-challenge, s-notes, cc-client, cc-email, cc-nbhd, cc-concept`
- On load, `populateSetupFields(cl)` restores all fields including `years_in_business, annual_revenue, avg_check, size, challenge, pre_audit_notes`

### Intel Auto-Trigger on Session Load
`autoTriggerIntel(clientId)`:
- Checks existing status → triggers `POST` if needed
- Polls every 5s via `startIntelPoll()`
- On complete: `silentlyPopulateIntel(data)` fills review + competitor panels

### Refresh Intel (FIX 4)
`refreshIntel()`:
- Confirmation dialog: "This will run a fresh scan and replace cached intel results. Client profile and session notes will be preserved. Continue?"
- Calls `POST /api/intel/business/:clientId` with `{ force: true }`
- Server deletes existing `business_intel` row, re-gathers
- Client profile data NEVER touched
- Button lives on the Press panel

### AI Functions (all call `POST /api/chat` → OpenAI GPT-4o-mini)

- `callAI(payload)` — core proxy call
- `analyzeMenu()` — menu item scoring + opportunities
- `scanMenuReddit()` — Reddit mentions of business name
- `analyzeReviews()` — extract signals from pasted reviews
- `scanRedditReviews()` — Reddit review search
- `generateReviewResearchBrief()` — research brief for manual review gathering
- `analyzeInventory()` — supply chain + vendor analysis
- `analyzeCompetitors()` — competitor gap analysis
- `aiIdentifyCompetitors()` — AI identifies competitors from scratch
- `scanCompetitorReddit()` — Reddit competitor mentions
- `runPressAnalysis()` — DB query + live KC press scrape (parallel via `Promise.allSettled`)
- `runPressReddit()` — Reddit search for business + neighborhood
- `runMarketAnalysis()` — Launch tier: market viability score
- `runConceptReddit()` — Launch tier: Reddit concept scan
- `runCommunityAnalysis()` — Launch tier: paste + AI synthesis
- `runStoredCommunityAnalysis()` — Launch tier: query DB + AI synthesis
- `runFinancialProjection()` — Launch tier: startup cost + revenue model
- `runFundingAnalysis()` — Launch tier: KC funding pathways
- `uploadMenuPhoto()` — `POST /api/intel/menu-upload/:clientId`
- `autoPopulateMenu()` — pulls intel + uploads → populates menuItems[]
- `loadMenuUploads()` — loads saved menu uploads
- `generateBrief()` — tier-aware report generator:
  - launch tier → Presage Launch Report
  - consult tier → Consult Brief
  - audit tier → Presage Brief Extended
  - retainer tier → Monthly Brief

### Menu Item Deduplication
`addMenuItemIfNew(name, price, vol, mentions)`:
- Checks `menuItems[]` case-insensitive before inserting
- Updates price if existing has none
- Used by both `autoPopulateMenu()` + `uploadMenuPhoto()`

### Context Builders
- `getClientContext()` — pulls from audit setup fields (`s-biz, s-type, s-nbhd`, etc.)
- `getConsultContext()` — pulls from launch/consult setup fields (`cc-client, cc-nbhd`, etc.)

---

## PRESAGE-CONSULT.HTML — PUBLIC SITE (/)

### Sections
Hero → Services (4 tiers) → Audit Breakdown → How It Works → Compare Table → "The Window Is Now" (seasonal urgency) → Contact Form → Footer

### Tiers and Pricing

| Tier | Price | Description |
|---|---|---|
| Presage Launch | $500/session | pre-launch concept analysis |
| Presage Consult | $1,200/engagement | existing business intelligence |
| Presage Audit | $2,500/engagement | full deep-dive + supply chain |
| Presage Retainer | $600/month | ongoing monthly intelligence |

Contact form → `POST /api/contact` → saves client → sends Resend emails.

### Seasonal Section — "The Window Is Now"
References 2026 FIFA World Cup, Chiefs season, fall retail cycle, spring-to-summer dining shift. Positions a Presage Audit as the prep tool for these demand spikes.

### Data Source Language
All platform names scrubbed. Generic descriptions only ("live community signal analysis", "automated market intelligence profile", etc.).

---

## INDEX.HTML — MARKETIQ DASHBOARD (/marketiq)
Market intelligence research tool. Uses `community_intel` DB + AI synthesis.
Internal navigation: ◎ PresageIQ | Client Queue (/consult) | Market Intel (/marketiq)

---

## ENVIRONMENT VARIABLES (set in Railway dashboard)

### Required
- `DATABASE_URL` — PostgreSQL connection string (Railway provides)
- `OPENAI_API_KEY` — GPT-4o-mini for all AI analysis + vision

### Optional (features degrade gracefully if missing)
- `GOOGLE_PLACES_API_KEY` — Google Places API (New). Without this, businessIntel.js returns no business data.
- `GOOGLE_SEARCH_API_KEY` — Google Custom Search API. Without this, web search falls back to fixed KC site scraper.
- `GOOGLE_SEARCH_CX` — Programmable Search Engine ID. Current engine is scoped to 22 curated KC press/news/review sites.
- `RESEND_API_KEY` — Resend.com for confirmation emails on `/api/contact`. From: `noreply@presageiq.com`. To: `walley.research@gmail.com`.

### Notes
- `GOOGLE_PLACES_API_KEY` must have Places API (New) enabled, not legacy Places API
- `GOOGLE_SEARCH_API_KEY` requires Custom Search API enabled in the same Google Cloud project
- Custom Search free tier: 100 queries/day (plenty for normal client load). Paid: $5 per 1,000 queries.
- No `ANTHROPIC_API_KEY` — AI runs through OpenAI, not Anthropic SDK
- DB schema auto-migrates on startup (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for new columns)

### Custom Search Engine Scope

Current `GOOGLE_SEARCH_CX` engine is configured with these 22 sites:
```
www.kansascitymag.com         www.startlandnews.com
www.thepitchkc.com            www.reddit.com/r/kansascity
www.kcur.org                  www.kcsourcelink.com
www.kansascity.com            www.visitkc.com
www.bizjournals.com/kansascity www.kcchamber.com
www.kmbc.com                  www.yelp.com
www.kctv5.com                 www.tripadvisor.com
www.fox4kc.com                www.opentable.com
www.kshb.com                  google.com (required seed)
www.flatlandkc.org
www.thisiskc.com
www.kcrestaurantweek.com
www.infernokc.com
www.eater.com
```

---

## SCHEDULED JOBS (node-cron, runs on Railway server)

| Schedule | Job |
|---|---|
| Daily 3:00 AM UTC | Reddit + GDELT collection |
| Weekly Sun 4:00 AM UTC | KC Open Data + Foursquare collection |
| Monthly 1st 5:00 AM UTC | Census ACS collection |

---

## INTERNAL NAV (all internal pages)
◎ PresageIQ | Client Queue → /consult | Market Intel → /marketiq

---

## RECENTLY COMPLETED WORK (2026-04-15)

### FIX 1 — Google Search Agent
`searchAndScrapeWeb()` added to businessIntel.js. Uses Google Custom Search API to find press/review/community mentions across 22 curated KC sites. Fetches top result pages, extracts snippets containing the business name, scores relevance. Merges with legacy KC scraper results, deduplicated by URL. New route: `POST /api/intel/web-search/:clientId`.

### FIX 2 — Instagram Intel Scraping
`scrapeInstagram()` added. Finds business Instagram via Custom Search, fetches public profile page, extracts bio and up to 12 recent post captions with engagement. Runs GPT-4o-mini sentiment analysis on captions. Wired into gather pipeline and synthesis prompt as dedicated "INSTAGRAM / SOCIAL PRESENCE" section.

### FIX 3 — Client Profile Persistence
All setup form fields in consult.html auto-save to DB via debounced PATCH (1s delay) on input/change. Expanded `PATCH /api/clients/:id` to accept all profile fields. Added 8 new columns to `clients` table: `business_name, business_type, years_in_business, avg_check, annual_revenue, size, challenge, pre_audit_notes`. `populateSetupFields()` restores all fields on session load. Client info never needs re-entry once saved.

### FIX 4 — Re-scan Capability
"↻ Refresh Intel" button added to Press panel in consult.html. Shows confirmation dialog, then calls `POST /api/intel/business/:clientId` with `{ force: true }`. Server deletes existing `business_intel` row before re-gathering. Client profile, notes, and status are never touched on re-scan.

---

## KNOWN ISSUES / POTENTIAL REFINEMENTS

- **Custom Search limitation:** Engine was forced to have at least one seed site (google.com). Any refinement should consider removing google.com once the other 22 sites are validated as sufficient.
- **Instagram scraping is fragile:** Instagram frequently changes their embedded JSON structure. Current parser tries `_sharedData` first, falls back to bio meta. May need maintenance if IG changes.
- **No authentication on /consult:** It's internal but publicly accessible. If client data is sensitive, this should be gated.
- **`presage-audit.html` is dead code** — still in `/public` but has no active route.
- **Contact form auto-trigger** only matches `service === 'audit'` exactly. New tier names with price suffixes ("Presage Audit — $2,500") won't match. Consider updating to `includes('audit')` when full pricing string gets passed.
- **Menu panel missing optional context textareas** (`m-highlights`, `m-weak`, `m-reviews`) that `analyzeMenu()` gracefully skips if absent. Adding them would give AI richer context.

---

## GIT HISTORY (recent)

```
7d3041b  Add web search agent, Instagram scraping, client profile persistence, and refresh intel
714f1bb  Fix 3 bugs: analyzeMenu null refs, menu dedup on upload, press live scrape
3c10a85  Update presage-consult: remove source names, add early access callout + seasonal urgency
4239db7  Add consult.html - AI analysis functions and tier-aware report generation
acf3741  Add consult.html - session view and tier routing
0e438dc  Add consult.html - client queue view
9fd7e43  Routing restructure: /consult, /marketiq, 4-tier public site
```

---

## HOW TO RESUME IN A NEW CLAUDE CODE SESSION

1. Open VS Code (or terminal) pointed at:
   `C:\Users\usgho\OneDrive\Towns & Walley Intelligence\PresageIQ\presageiq-app`
2. Launch Claude Code from that directory.
3. Paste this at the start of the session:

> Read PROJECT_BIBLE.md to get current context on PresageIQ. We're continuing development — don't re-read the entire codebase unless you need specific files.

---
