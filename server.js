const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cron = require('node-cron');
const { makeCollectors, fetchCensusData, fetchHmdaData, fetchEJScreen, fetchKCNeighborhoodPop } = require('./collectors');
const { gatherBusinessIntel, extractMenuFromImage, scrapeKCReviewSources, searchAndScrapeWeb, scrapeInstagram } = require('./businessIntel');
const { computeAndStore } = require('./opportunityScore');
const { DATA_SOURCES, getHolcData } = require('./dataSources');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presage-consult.html')));
app.get('/consult', (req, res) => res.sendFile(path.join(__dirname, 'public', 'consult.html')));
app.get('/marketiq', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Legacy redirects
app.get('/dashboard', (req, res) => res.redirect(301, '/marketiq'));
app.get('/presage-audit.html', (req, res) => res.redirect(301, '/consult'));
app.get('/presage-consult.html', (req, res) => res.redirect(301, '/'));
app.get('/presage-consult', (req, res) => res.redirect(301, '/'));

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  // ── Original clients table ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      service     TEXT,
      concept     TEXT,
      neighborhood TEXT,
      phone       TEXT,
      notes       TEXT,
      status      TEXT DEFAULT 'pending'
    )
  `);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS bizname TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS biztype TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_name TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_type TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS years_in_business TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS avg_check TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS annual_revenue TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS size TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS challenge TEXT`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS pre_audit_notes TEXT`);

  // ── Neighborhood demographic profiles (Census ACS) ────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS neighborhood_profiles (
      id             SERIAL PRIMARY KEY,
      name           TEXT NOT NULL,
      zip            TEXT,
      population     INTEGER,
      median_income  NUMERIC(10,2),
      median_age     NUMERIC(5,1),
      owner_occupied NUMERIC(5,2),
      renter_occupied NUMERIC(5,2),
      pct_poverty    NUMERIC(5,2),
      pct_college    NUMERIC(5,2),
      pct_white      NUMERIC(5,2),
      pct_black      NUMERIC(5,2),
      pct_hispanic   NUMERIC(5,2),
      raw_data       JSONB,
      source         TEXT DEFAULT 'census',
      collected_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT uq_neighborhood_name UNIQUE (name)
    )
  `);

  // ── Community intelligence (Reddit, GDELT, manual) ────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_intel (
      id             SERIAL PRIMARY KEY,
      source         TEXT NOT NULL,
      source_id      TEXT,
      title          TEXT,
      body           TEXT,
      url            TEXT,
      author         TEXT,
      score          INTEGER DEFAULT 0,
      neighborhoods  TEXT[],
      business_types TEXT[],
      sentiment      TEXT,
      tags           TEXT[],
      post_date      TIMESTAMPTZ,
      collected_at   TIMESTAMPTZ DEFAULT NOW(),
      raw_data       JSONB,
      CONSTRAINT uq_community_intel_source UNIQUE (source, source_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ci_neighborhoods  ON community_intel USING GIN (neighborhoods)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ci_business_types ON community_intel USING GIN (business_types)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ci_source         ON community_intel (source)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ci_collected      ON community_intel (collected_at DESC)`);

  // ── Business profiles (KC Open Data + Foursquare) ─────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_profiles (
      id                  SERIAL PRIMARY KEY,
      source              TEXT NOT NULL,
      source_id           TEXT,
      name                TEXT NOT NULL,
      dba_name            TEXT,
      address             TEXT,
      neighborhood        TEXT,
      zip                 TEXT,
      lat                 NUMERIC(10,7),
      lng                 NUMERIC(10,7),
      business_type       TEXT,
      license_type        TEXT,
      license_status      TEXT,
      foursquare_id       TEXT UNIQUE,
      foursquare_rating   NUMERIC(4,2),
      raw_data            JSONB,
      collected_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_business_source_id
    ON business_profiles (source, source_id)
    WHERE source_id IS NOT NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bp_neighborhood ON business_profiles (neighborhood)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bp_business_type ON business_profiles (business_type)`);

  // ── Business intelligence per client (audit use) ─────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_intel (
      id                 SERIAL PRIMARY KEY,
      client_id          INTEGER UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
      business_name      TEXT,
      place_id           TEXT,
      place_data         JSONB,
      competitors        JSONB,
      website_data       JSONB,
      community_mentions JSONB,
      ai_profile         TEXT,
      ai_competitors     TEXT,
      ai_menu_items      TEXT,
      ai_photo_subjects  TEXT,
      status             TEXT DEFAULT 'pending',
      error_message      TEXT,
      gathered_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE business_intel ADD COLUMN IF NOT EXISTS ai_menu_items TEXT`);
  await pool.query(`ALTER TABLE business_intel ADD COLUMN IF NOT EXISTS ai_photo_subjects TEXT`);
  await pool.query(`ALTER TABLE business_intel ADD COLUMN IF NOT EXISTS opportunity_score NUMERIC(5,2)`);
  await pool.query(`ALTER TABLE business_intel ADD COLUMN IF NOT EXISTS score_breakdown JSONB`);
  await pool.query(`ALTER TABLE business_intel ADD COLUMN IF NOT EXISTS social_intel JSONB`);
  await pool.query(`ALTER TABLE business_intel ADD COLUMN IF NOT EXISTS status_message TEXT`);
  await pool.query(`ALTER TABLE business_intel ADD COLUMN IF NOT EXISTS demographic_intel JSONB`);

  // ── Menu uploads (agent/business-uploaded menu photos) ───────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS menu_uploads (
      id             SERIAL PRIMARY KEY,
      client_id      INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      filename       TEXT,
      mime_type      TEXT,
      image_data     TEXT,
      label          TEXT DEFAULT 'Menu',
      extracted_items TEXT,
      uploaded_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Collection job log ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collection_log (
      id               SERIAL PRIMARY KEY,
      source           TEXT NOT NULL,
      started_at       TIMESTAMPTZ DEFAULT NOW(),
      completed_at     TIMESTAMPTZ,
      status           TEXT DEFAULT 'running',
      records_fetched  INTEGER DEFAULT 0,
      records_upserted INTEGER DEFAULT 0,
      error_message    TEXT,
      triggered_by     TEXT DEFAULT 'scheduler'
    )
  `);

  // ── KC neighborhood boundaries ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kc_neighborhoods (
      id           SERIAL PRIMARY KEY,
      name         TEXT UNIQUE NOT NULL,
      slug         TEXT UNIQUE NOT NULL,
      polygon      JSONB,
      centroid_lat FLOAT,
      centroid_lng FLOAT,
      bbox_north   FLOAT,
      bbox_south   FLOAT,
      bbox_east    FLOAT,
      bbox_west    FLOAT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Opportunity Atlas mobility metrics by census tract ────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS opportunity_atlas (
      id                          SERIAL PRIMARY KEY,
      tract_id                    TEXT UNIQUE NOT NULL,
      state_fips                  TEXT,
      county_fips                 TEXT,
      tract_fips                  TEXT,
      neighborhood_name           TEXT,
      kfr_pooled_pooled_mean      FLOAT,
      kfr_black_pooled_mean       FLOAT,
      kfr_white_pooled_mean       FLOAT,
      kfr_hisp_pooled_mean        FLOAT,
      jail_pooled_pooled_mean     FLOAT,
      jail_black_pooled_mean      FLOAT,
      emp_pooled_pooled_mean      FLOAT,
      teenbrth_pooled_pooled_mean FLOAT,
      created_at                  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── KCMO 311 service requests ─────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kc_311_requests (
      id           SERIAL PRIMARY KEY,
      request_id   TEXT UNIQUE,
      category     TEXT,
      type         TEXT,
      description  TEXT,
      neighborhood TEXT,
      status       TEXT,
      created_date TIMESTAMPTZ,
      closed_date  TIMESTAMPTZ,
      lat          FLOAT,
      lng          FLOAT,
      fetched_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('Database ready.');
}

async function initDbWithRetry(attempts = 5, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await initDb();
      return;
    } catch (err) {
      console.error(`DB init attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.error('DB init failed after all attempts — database features will not work.');
}

// ── POST /api/chat ─ OpenAI proxy ────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  }
  try {
    const { model, system, messages, max_tokens } = req.body;
    const openaiMessages = [];
    if (system) openaiMessages.push({ role: 'system', content: system });
    if (messages) openaiMessages.push(...messages);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: openaiMessages, max_tokens: max_tokens || 1000 }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });
    const text = data.choices?.[0]?.message?.content || '';
    res.json({ content: [{ text }] });
  } catch (err) {
    console.error('OpenAI proxy error:', err);
    res.status(502).json({ error: 'Upstream error' });
  }
});

// ── GET /api/reddit-search ─ Reddit proxy ─────────────────────────────────────
app.get('/api/reddit-search', async (req, res) => {
  const { q, sub } = req.query;
  if (!q) return res.status(400).json({ error: 'q param required' });
  const subreddit = sub || 'kansascity';
  try {
    const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=relevance&t=year&limit=10`;
    const r = await fetch(url, { headers: { 'User-Agent': 'PresageIQ-Internal/1.0', 'Accept': 'application/json' } });
    if (!r.ok) return res.status(r.status).json({ error: `Reddit returned ${r.status}` });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── POST /api/intel/collect/:source ─ Trigger a collector manually ────────────
app.post('/api/intel/collect/:source', async (req, res) => {
  const { source } = req.params;
  const valid = ['reddit', 'gdelt', 'kc_open_data', 'census', 'foursquare', 'all'];
  if (!valid.includes(source)) return res.status(400).json({ error: `source must be one of: ${valid.join(', ')}` });

  const collectors = makeCollectors(pool);
  const opts = { triggeredBy: 'manual' };

  // Fire and forget — return immediately, collection runs in background
  const run = async () => {
    if (source === 'all') {
      await collectors.collectReddit(opts).catch(e => console.error('[manual] reddit:', e.message));
      await collectors.collectGdelt(opts).catch(e => console.error('[manual] gdelt:', e.message));
      await collectors.collectKcOpenData(opts).catch(e => console.error('[manual] kc_open_data:', e.message));
      await collectors.collectCensus(opts).catch(e => console.error('[manual] census:', e.message));
      await collectors.collectFoursquare(opts).catch(e => console.error('[manual] foursquare:', e.message));
    } else {
      const fn = {
        reddit: collectors.collectReddit,
        gdelt: collectors.collectGdelt,
        kc_open_data: collectors.collectKcOpenData,
        census: collectors.collectCensus,
        foursquare: collectors.collectFoursquare,
      }[source];
      await fn(opts).catch(e => console.error(`[manual] ${source}:`, e.message));
    }
  };

  run(); // do not await
  res.status(202).json({ started: true, source, message: `Collection started — check /api/intel/status for results` });
});

// ── GET /api/intel/status ─ Collection log ────────────────────────────────────
app.get('/api/intel/status', async (req, res) => {
  try {
    const bySource = await pool.query(`
      SELECT DISTINCT ON (source) source, status, started_at, completed_at,
             records_fetched, records_upserted, error_message, triggered_by
      FROM collection_log
      ORDER BY source, started_at DESC
    `);
    const recent = await pool.query(`
      SELECT * FROM collection_log ORDER BY started_at DESC LIMIT 20
    `);
    const sourceMap = {};
    bySource.rows.forEach(r => { sourceMap[r.source] = r; });
    res.json({ by_source: sourceMap, recent_runs: recent.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/stats ─ Data library summary counts ───────────────────────
app.get('/api/intel/stats', async (req, res) => {
  try {
    const [ciStats, bpStats, npStats] = await Promise.all([
      pool.query(`SELECT source, COUNT(*) as total, MAX(collected_at) as last_collected FROM community_intel GROUP BY source`),
      pool.query(`SELECT source, COUNT(*) as total FROM business_profiles GROUP BY source`),
      pool.query(`SELECT COUNT(*) as total, MAX(updated_at) as last_updated FROM neighborhood_profiles`),
    ]);

    const ciBySource = {};
    let ciTotal = 0;
    let ciLast = null;
    ciStats.rows.forEach(r => {
      ciBySource[r.source] = { total: parseInt(r.total), last_collected: r.last_collected };
      ciTotal += parseInt(r.total);
      if (!ciLast || r.last_collected > ciLast) ciLast = r.last_collected;
    });

    const bpBySource = {};
    let bpTotal = 0;
    bpStats.rows.forEach(r => { bpBySource[r.source] = parseInt(r.total); bpTotal += parseInt(r.total); });

    res.json({
      community_intel: { total: ciTotal, by_source: ciBySource, last_collected: ciLast },
      business_profiles: { total: bpTotal, by_source: bpBySource },
      neighborhood_profiles: { total: parseInt(npStats.rows[0]?.total || 0), last_updated: npStats.rows[0]?.last_updated },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/community ─ Query stored community intel ──────────────────
app.get('/api/intel/community', async (req, res) => {
  const { neighborhood, business_type, source, sentiment, q, limit = 50, offset = 0 } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200);
  const off = parseInt(offset) || 0;

  const conditions = [];
  const params = [];

  if (neighborhood) { params.push([neighborhood]); conditions.push(`neighborhoods @> $${params.length}::TEXT[]`); }
  if (business_type) { params.push([business_type]); conditions.push(`business_types @> $${params.length}::TEXT[]`); }
  if (source) { params.push(source); conditions.push(`source = $${params.length}`); }
  if (sentiment) { params.push(sentiment); conditions.push(`sentiment = $${params.length}`); }
  if (q) { params.push(`%${q}%`); conditions.push(`(title ILIKE $${params.length} OR body ILIKE $${params.length})`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(`SELECT COUNT(*) FROM community_intel ${where}`, params);
    params.push(lim, off);
    const dataRes = await pool.query(`
      SELECT id, source, title, body, url, author, score, neighborhoods, business_types, sentiment, tags, post_date, collected_at
      FROM community_intel ${where}
      ORDER BY collected_at DESC, score DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ total: parseInt(countRes.rows[0].count), records: dataRes.rows });
  } catch (err) {
    console.error('Community intel query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/neighborhoods ─ Neighborhood profiles ─────────────────────
app.get('/api/intel/neighborhoods', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT np.*, COUNT(bp.id) as business_count
      FROM neighborhood_profiles np
      LEFT JOIN business_profiles bp ON bp.neighborhood = np.name
      GROUP BY np.id
      ORDER BY np.name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/intel/manual ─ Manual paste-and-tag entry ──────────────────────
app.post('/api/intel/manual', async (req, res) => {
  const { title, body, neighborhoods, business_types, sentiment, tags, source_url } = req.body;
  if (!body && !title) return res.status(400).json({ error: 'title or body required' });

  try {
    const result = await pool.query(`
      INSERT INTO community_intel
        (source, source_id, title, body, url, neighborhoods, business_types, sentiment, tags, post_date)
      VALUES ('manual', NULL, $1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING id
    `, [
      (title || '').substring(0, 500),
      (body || '').substring(0, 5000),
      source_url || '',
      neighborhoods || [],
      business_types || [],
      sentiment || 'neutral',
      tags || [],
    ]);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/business/:clientId ─ Get gathered business intelligence ───
app.get('/api/intel/business/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (!clientId) return res.status(400).json({ error: 'Invalid clientId' });
  try {
    const result = await pool.query(`SELECT * FROM business_intel WHERE client_id=$1`, [clientId]);
    if (!result.rows.length) return res.json({ status: 'not_started' });
    const row = result.rows[0];
    // Parse JSONB fields
    ['place_data', 'competitors', 'website_data', 'community_mentions', 'ai_menu_items', 'ai_photo_subjects', 'social_intel', 'demographic_intel'].forEach(f => {
      if (typeof row[f] === 'string') try { row[f] = JSON.parse(row[f]); } catch(e) {}
    });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/intel/business/:clientId ─ Trigger business intelligence gather ─
app.post('/api/intel/business/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (!clientId) return res.status(400).json({ error: 'Invalid clientId' });
  try {
    const client = await pool.query(`SELECT * FROM clients WHERE id=$1`, [clientId]);
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });
    const { bizname, name, neighborhood } = client.rows[0];
    const businessName = bizname || name;
    if (!businessName) return res.status(400).json({ error: 'No business name on this client record' });

    // If force=true, wipe all cached intel for this client before re-scraping
    const force = req.body?.force === true;
    if (force) {
      await pool.query(`DELETE FROM business_intel WHERE client_id=$1`, [clientId]);
      console.log(`[intel] Force refresh: wiped all cached intel for client ${clientId}`);
    }

    // Fire and return — full pipeline runs in background
    gatherBusinessIntel(pool, clientId, businessName, neighborhood)
      .then(async () => {
        // Auto-trigger opportunity scoring after gather completes
        try {
          const intelRes = await pool.query(`SELECT * FROM business_intel WHERE client_id=$1`, [clientId]);
          if (!intelRes.rows.length || intelRes.rows[0].status !== 'complete') return;
          const row = intelRes.rows[0];
          ['place_data', 'competitors', 'website_data', 'community_mentions'].forEach(f => {
            if (typeof row[f] === 'string') try { row[f] = JSON.parse(row[f]); } catch(e) {}
          });
          await computeAndStore(pool, clientId, row, businessName, neighborhood);
          await pool.query(`UPDATE business_intel SET status_message='Refresh complete.' WHERE client_id=$1`, [clientId]);
          console.log(`[intel] Auto-scoring complete for client ${clientId}`);
        } catch (e) {
          console.error(`[intel] Auto-scoring failed for client ${clientId}:`, e.message);
        }
      })
      .catch(e => console.error(`[intel] Background gather error: ${e.message}`));

    res.status(202).json({ started: true, force, message: `Intelligence gathering started for "${businessName}"` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/intel/menu-upload/:clientId ─ Upload + extract menu from image ──
app.post('/api/intel/menu-upload/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (!clientId) return res.status(400).json({ error: 'Invalid clientId' });
  const { imageBase64, mimeType, filename, label } = req.body;
  if (!imageBase64 || !mimeType) return res.status(400).json({ error: 'imageBase64 and mimeType required' });
  try {
    // Extract items via vision AI
    const extracted = await extractMenuFromImage(imageBase64, mimeType, label || 'Menu');

    // Store upload + extracted items
    const result = await pool.query(`
      INSERT INTO menu_uploads (client_id, filename, mime_type, image_data, label, extracted_items)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, uploaded_at
    `, [clientId, filename || 'menu', mimeType, imageBase64, label || 'Menu', JSON.stringify(extracted)]);

    res.json({ success: true, upload_id: result.rows[0].id, items: extracted, count: extracted.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/menu-uploads/:clientId ─ List all menu uploads for client ─
app.get('/api/intel/menu-uploads/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (!clientId) return res.status(400).json({ error: 'Invalid clientId' });
  try {
    const result = await pool.query(`
      SELECT id, filename, label, mime_type, extracted_items, uploaded_at
      FROM menu_uploads WHERE client_id=$1 ORDER BY uploaded_at DESC
    `, [clientId]);
    const rows = result.rows.map(r => ({
      ...r,
      extracted_items: typeof r.extracted_items === 'string' ? JSON.parse(r.extracted_items) : (r.extracted_items || [])
    }));
    res.json(rows);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/intel/menu-uploads/:clientId/image/:uploadId ─ Return image data ─
app.get('/api/intel/menu-uploads/:clientId/image/:uploadId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mime_type, image_data FROM menu_uploads WHERE id=$1 AND client_id=$2`,
      [req.params.uploadId, req.params.clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const { mime_type, image_data } = result.rows[0];
    const buf = Buffer.from(image_data, 'base64');
    res.set('Content-Type', mime_type);
    res.send(buf);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/intel/press-live/:clientId ─ Live KC press scrape for a business ─
app.post('/api/intel/press-live/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (!clientId) return res.status(400).json({ error: 'Invalid clientId' });
  try {
    const client = await pool.query(`SELECT bizname, name FROM clients WHERE id=$1`, [clientId]);
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });
    const { bizname, name } = client.rows[0];
    const businessName = (bizname || name || '').trim();
    if (!businessName) return res.status(400).json({ error: 'No business name on this client record' });

    const results = await scrapeKCReviewSources(businessName);
    res.json({ businessName, results, count: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/intel/web-search/:clientId ─ Google search agent for a client ──
app.post('/api/intel/web-search/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (!clientId) return res.status(400).json({ error: 'Invalid clientId' });
  try {
    const client = await pool.query(`SELECT bizname, name, neighborhood FROM clients WHERE id=$1`, [clientId]);
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });
    const { bizname, name, neighborhood } = client.rows[0];
    const businessName = (bizname || name || '').trim();
    if (!businessName) return res.status(400).json({ error: 'No business name on this client record' });

    const query = req.body?.query || businessName;
    const results = await searchAndScrapeWeb(query, neighborhood);

    // Save results to business_intel web_search_data
    await pool.query(`
      UPDATE business_intel SET community_mentions = COALESCE(community_mentions, '[]'::JSONB)
      WHERE client_id=$1
    `, [clientId]);

    res.json({ businessName, query, results, count: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/contact ─ save client + send emails ────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, service, concept, neighborhood, phone, notes, bizname, biztype } = req.body;
  if (!name || !email || !service || !concept) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO clients (name, email, service, concept, neighborhood, phone, notes, bizname, biztype, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') RETURNING id, created_at`,
      [name, email, service, concept, neighborhood || null, phone || null, notes || null, bizname || null, biztype || null]
    );
    const client = result.rows[0];
    sendEmails({ id: client.id, name, email, service, concept, neighborhood, phone, notes })
      .catch(err => console.error('Email send error:', err));

    // Auto-trigger business intelligence gathering for audit requests
    if (service === 'audit' && (bizname || name)) {
      gatherBusinessIntel(pool, client.id, bizname || name, neighborhood || '')
        .catch(e => console.error(`[intel] Auto-gather failed for client ${client.id}: ${e.message}`));
    }

    res.json({ success: true, id: client.id });
  } catch (err) {
    console.error('Contact save error:', err);
    res.status(500).json({ error: 'Failed to save request', detail: err.message });
  }
});

async function sendEmails({ id, name, email, service, concept, neighborhood, phone, notes }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const serviceLabel = service === 'consult' ? 'Presage Consult ($500)' : 'Presage Audit ($2,500)';
  const nbhd = neighborhood || 'Not specified';
  const ph = phone || 'Not provided';
  const nt = notes || 'None';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'PresageIQ <noreply@presageiq.com>',
      to: ['walley.research@gmail.com'],
      subject: `New ${serviceLabel} Request — ${name} (#${id})`,
      html: `<div style="font-family:monospace;background:#080b10;color:#eef1f4;padding:24px;border-radius:8px;max-width:600px;"><h2 style="color:#c8963e;margin:0 0 16px;">New Client Request #${id}</h2><table style="border-collapse:collapse;width:100%;font-size:13px;"><tr><td style="color:#8a9aaa;padding:6px 0;width:140px;">Name</td><td>${name}</td></tr><tr><td style="color:#8a9aaa;padding:6px 0;">Email</td><td>${email}</td></tr><tr><td style="color:#8a9aaa;padding:6px 0;">Service</td><td style="color:#c8963e;">${serviceLabel}</td></tr><tr><td style="color:#8a9aaa;padding:6px 0;">Neighborhood</td><td>${nbhd}</td></tr><tr><td style="color:#8a9aaa;padding:6px 0;">Phone</td><td>${ph}</td></tr><tr><td style="color:#8a9aaa;padding:6px 0;">Concept</td><td>${concept}</td></tr><tr><td style="color:#8a9aaa;padding:6px 0;">Notes</td><td>${nt}</td></tr></table></div>`,
    }),
  });

  const isAudit = service === 'audit';
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Towns & Walley Intelligence <noreply@presageiq.com>',
      to: [email],
      subject: `We received your ${isAudit ? 'Presage Audit' : 'Presage Consult'} request`,
      html: `<div style="font-family:monospace;background:#080b10;color:#eef1f4;padding:32px;border-radius:8px;max-width:560px;margin:0 auto;"><h1 style="font-size:22px;color:#c8963e;margin:0 0 8px;">Towns &amp; Walley Intelligence</h1><p style="color:#52c5b0;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 24px;">Request Confirmed</p><p style="color:#eef1f4;line-height:1.7;margin:0 0 16px;">Hi ${name} — we've received your <strong style="color:#c8963e;">${isAudit ? 'Presage Audit' : 'Presage Consult'}</strong> request and will be in touch within 48 hours to confirm your session and next steps.</p><div style="background:#0d1117;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:16px;margin:20px 0;"><p style="font-size:11px;color:#8a9aaa;margin:0 0 8px;letter-spacing:1px;text-transform:uppercase;">What you submitted</p><p style="color:#eef1f4;margin:0 0 6px;font-size:13px;"><strong style="color:#8a9aaa;">Service:</strong> ${serviceLabel}</p><p style="color:#eef1f4;margin:0 0 6px;font-size:13px;"><strong style="color:#8a9aaa;">Neighborhood:</strong> ${nbhd}</p><p style="color:#eef1f4;margin:0;font-size:13px;"><strong style="color:#8a9aaa;">Concept:</strong> ${concept.substring(0,120)}${concept.length>120?'…':''}</p></div><p style="color:#3d5060;font-size:11px;margin:24px 0 0;">Towns &amp; Walley Intelligence · Kansas City</p></div>`,
    }),
  });
}

// ── GET /api/clients ──────────────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    res.json((await pool.query(`SELECT * FROM clients ORDER BY created_at DESC`)).rows);
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── GET /api/clients/:id ──────────────────────────────────────────────────────
app.get('/api/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await pool.query(`SELECT * FROM clients WHERE id = $1`, [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── PATCH /api/clients/:id ────────────────────────────────────────────────────
app.patch('/api/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  // Allowed fields that can be updated
  const allowed = [
    'status', 'name', 'email', 'service', 'concept', 'neighborhood', 'phone', 'notes',
    'bizname', 'biztype', 'business_name', 'business_type', 'years_in_business',
    'avg_check', 'annual_revenue', 'size', 'challenge', 'pre_audit_notes',
  ];

  // Validate status if provided
  if (req.body.status && !['pending', 'active', 'complete'].includes(req.body.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      setClauses.push(`${field} = $${paramIndex}`);
      values.push(req.body[field]);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE clients SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── GET /api/sources ─ Full data source registry ─────────────────────────────
app.get('/api/sources', (req, res) => {
  res.json(DATA_SOURCES);
});

// ── GET /api/intel/score/:clientId ─ Opportunity score (compute or return cached) ─
app.get('/api/intel/score/:clientId', async (req, res) => {
  const clientId = parseInt(req.params.clientId, 10);
  if (!clientId) return res.status(400).json({ error: 'Invalid clientId' });
  try {
    const intelRes = await pool.query(`SELECT * FROM business_intel WHERE client_id=$1`, [clientId]);
    if (!intelRes.rows.length) return res.json({ status: 'not_started' });
    const row = intelRes.rows[0];
    if (row.status !== 'complete') return res.json({ status: row.status });

    // Return cached score if already computed
    if (row.opportunity_score !== null && row.score_breakdown !== null) {
      const breakdown = typeof row.score_breakdown === 'string'
        ? JSON.parse(row.score_breakdown)
        : row.score_breakdown;
      return res.json({ status: 'complete', opportunity_score: parseFloat(row.opportunity_score), score_breakdown: breakdown });
    }

    // Parse JSONB fields before passing to scorer
    ['place_data', 'competitors', 'website_data', 'community_mentions'].forEach(f => {
      if (typeof row[f] === 'string') try { row[f] = JSON.parse(row[f]); } catch(e) {}
    });

    const clientRes = await pool.query(`SELECT bizname, name, neighborhood FROM clients WHERE id=$1`, [clientId]);
    const businessName = clientRes.rows[0]?.bizname || clientRes.rows[0]?.name || 'Unknown';
    const neighborhood = clientRes.rows[0]?.neighborhood || null;

    const result = await computeAndStore(pool, clientId, row, businessName, neighborhood);
    return res.json({ status: 'complete', ...result });
  } catch (err) {
    console.error('[score] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/methodology', (req, res) => res.sendFile(path.join(__dirname, 'public', 'methodology.html')));

app.get('/civiciq', (req, res) => res.sendFile(path.join(__dirname, 'public', 'civiciq.html')));

// ── CivicIQ neighborhood intelligence report ──────────────────────────────────
app.post('/api/civiciq/report', async (req, res) => {
  const { neighborhood, zip } = req.body;
  if (!neighborhood) return res.status(400).json({ error: 'neighborhood is required' });

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  try {
    // ── 1. Parallel data collection ───────────────────────────────────────────
    const [censusData, hmdaData, communityRows, businessCountRow] = await Promise.all([
      zip ? fetchCensusData(zip).catch(() => null) : Promise.resolve(null),
      fetchHmdaData().catch(() => null),
      pool.query(`
        SELECT source, title, body, url, post_date, score, sentiment
        FROM community_intel
        WHERE $1 = ANY(neighborhoods)
          AND collected_at >= NOW() - INTERVAL '90 days'
        ORDER BY score DESC NULLS LAST, collected_at DESC
        LIMIT 20
      `, [neighborhood]).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT COUNT(*) AS cnt
        FROM business_profiles
        WHERE LOWER(neighborhood) = LOWER($1)
      `, [neighborhood]).catch(() => ({ rows: [{ cnt: 0 }] })),
    ]);

    const ejscreenData = null; // EJScreen requires lat/lng; neighborhood-only requests skip it

    const holcData = getHolcData(neighborhood);

    const communityMentions = communityRows.rows || [];
    const businessCount = parseInt(businessCountRow.rows[0]?.cnt || 0);

    // ── 2. Build AI context ───────────────────────────────────────────────────
    const censusContext = censusData ? [
      censusData.medianIncome   ? `Median household income: $${Number(censusData.medianIncome).toLocaleString()}` : null,
      censusData.povertyRate    != null ? `Poverty rate: ${censusData.povertyRate}%` : null,
      censusData.bachelorsPlus  != null ? `College-educated: ${censusData.bachelorsPlus}%` : null,
      censusData.totalPop       ? `Total population (ZIP): ${Number(censusData.totalPop).toLocaleString()}` : null,
      censusData.whitePct       != null ? `White: ${censusData.whitePct}%` : null,
      censusData.blackPct       != null ? `Black/African American: ${censusData.blackPct}%` : null,
      censusData.hispanicPct    != null ? `Hispanic/Latino: ${censusData.hispanicPct}%` : null,
    ].filter(Boolean).join(' | ') : 'Census data not available (no ZIP provided).';

    const hmdaContext = hmdaData
      ? `KC Metro (MSA 28140) overall mortgage denial rate: ${hmdaData.overallDenialRate}% (${(hmdaData.totalDenied||0).toLocaleString()} denied of ${((hmdaData.totalOriginated||0)+(hmdaData.totalDenied||0)).toLocaleString()} applications, 2022)`
      : 'HMDA lending data: not available.';

    const holcContext = holcData
      ? `HOLC grade: ${holcData.grade} (${holcData.year}). ${holcData.description || ''}`
      : 'No HOLC historical redlining record for this neighborhood.';

    const communityContext = communityMentions.length
      ? communityMentions.map(m =>
          `[${m.source}] ${m.title || ''} (${m.sentiment || 'neutral'}): ${(m.body || '').substring(0, 200)}`
        ).join('\n')
      : 'No recent community mentions in database (last 90 days).';

    const prompt = `You are producing a CivicIQ Neighborhood Intelligence Report for "${neighborhood}" (Kansas City metro area). Write a rigorous, data-grounded report using the evidence provided. Do not fabricate data. If a section lacks data, say so plainly.

DATA PROVIDED:

CENSUS ACS PROFILE (ZIP ${zip || 'not provided'}):
${censusContext}

MORTGAGE LENDING (HMDA 2022, KC Metro):
${hmdaContext}

HOLC HISTORICAL REDLINING:
${holcContext}

BUSINESSES IN DATABASE FOR THIS NEIGHBORHOOD: ${businessCount}

RECENT COMMUNITY MENTIONS (last 90 days, up to 20):
${communityContext}

---

Output ONLY a valid JSON object with exactly these 7 keys. Each value is a string of 3-5 sentences:

{
  "executive_summary": "...",
  "economic_conditions": "...",
  "historical_capital_access": "...",
  "community_demographics": "...",
  "environmental_justice": "...",
  "market_gap_assessment": "...",
  "policy_implications": "..."
}

SECTION GUIDANCE:
- executive_summary: Top-level synthesis — what defines this neighborhood economically and socially right now
- economic_conditions: Income levels, poverty, business density, employment signals from available data
- historical_capital_access: HOLC redlining history and its documented downstream effects on wealth, homeownership, and lending; cite the HMDA denial rate data
- community_demographics: Population composition from Census — race/ethnicity, education, age if known
- environmental_justice: If EJScreen data is available use it; otherwise note the absence and discuss what EJ indicators typically reveal in similar KC neighborhoods
- market_gap_assessment: Based on business count, income levels, and community mentions — what goods or services appear underserved
- policy_implications: Concrete recommendations for investors, city agencies, or community organizations operating in this neighborhood`;

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1200,
        messages: [
          { role: 'system', content: 'You are a rigorous neighborhood intelligence analyst. Output only valid JSON. Never add text before or after the JSON object.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const aiData = await aiRes.json();
    const raw = aiData.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'AI did not return valid JSON' });
    const sections = JSON.parse(jsonMatch[0]);

    res.json({
      neighborhood,
      zip: zip || null,
      generated_at: new Date().toISOString(),
      data: {
        census:    censusData,
        hmda:      hmdaData,
        holc:      holcData ? { grade: holcData.grade, year: holcData.year, description: holcData.description } : null,
        business_count: businessCount,
        community_mentions: communityMentions.length,
      },
      sections,
    });
  } catch (err) {
    console.error('[civiciq]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Fallback ──────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presage-consult.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PresageIQ running on port ${PORT}`);
  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL not set — database features disabled.');
    return;
  }
  initDbWithRetry().then(() => {
    if (!process.env.DATABASE_URL) return;
    const collectors = makeCollectors(pool);

    // Daily at 3:00 AM UTC — Reddit + GDELT
    cron.schedule('0 3 * * *', async () => {
      console.log('[cron] Daily collection — Reddit + GDELT');
      await collectors.collectReddit().catch(e => console.error('[cron] Reddit:', e.message));
      await collectors.collectGdelt().catch(e => console.error('[cron] GDELT:', e.message));
    });

    // Weekly Sunday at 4:00 AM UTC — KC Open Data + Foursquare
    cron.schedule('0 4 * * 0', async () => {
      console.log('[cron] Weekly collection — KC Open Data + Foursquare');
      await collectors.collectKcOpenData().catch(e => console.error('[cron] KC Open Data:', e.message));
      await collectors.collectFoursquare().catch(e => console.error('[cron] Foursquare:', e.message));
    });

    // 1st of each month at 5:00 AM UTC — Census ACS
    cron.schedule('0 5 1 * *', async () => {
      console.log('[cron] Monthly collection — Census ACS');
      await collectors.collectCensus().catch(e => console.error('[cron] Census:', e.message));
    });

    console.log('[cron] Scheduled: Reddit+GDELT daily 3AM, KC+FSQ weekly Sun 4AM, Census monthly 1st 5AM');
  });
});
