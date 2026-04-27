// seedData.js — One-time and periodic data loading for PresageIQ reference tables

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractCoords(geom) {
  const pts = [];
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates)
      for (const pt of ring) pts.push(pt);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates)
      for (const ring of poly)
        for (const pt of ring) pts.push(pt);
  }
  return pts; // [lng, lat] pairs
}

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      fields.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCSV(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = vals[j] ?? '';
    rows.push(obj);
  }
  return rows;
}

function num(v) {
  return (v === '' || v == null) ? null : parseFloat(v);
}

// ── seedNeighborhoods ─────────────────────────────────────────────────────────

async function seedNeighborhoods(pool) {
  // Step 1: Discover actual field names before bulk fetch
  try {
    const discoverRes = await fetch('https://data.kcmo.org/resource/q45j-ejyk.json?$limit=1');
    console.log(`[seed] neighborhood schema discovery status=${discoverRes.status}`);
    if (discoverRes.ok) {
      const discoverData = await discoverRes.json();
      if (discoverData.length > 0) {
        console.log(`[seed] neighborhood dataset field names: ${Object.keys(discoverData[0]).join(', ')}`);
        console.log(`[seed] first record sample: ${JSON.stringify(discoverData[0]).substring(0, 300)}`);
      } else {
        console.warn('[seed] schema discovery returned 0 records');
      }
    }
  } catch (e) {
    console.warn(`[seed] schema discovery failed: ${e.message}`);
  }

  const primaryUrl = 'https://data.kcmo.org/resource/q45j-ejyk.json?$limit=300';
  console.log(`[seed] fetching neighborhoods from ${primaryUrl}`);
  let features = [];

  const primaryRes = await fetch(primaryUrl);
  console.log(`[seed] neighborhoods primary status=${primaryRes.status}`);
  const primaryBody = await primaryRes.text();
  console.log(`[seed] neighborhoods primary body[0:200]: ${primaryBody.substring(0, 200)}`);

  if (primaryRes.ok) {
    try { features = JSON.parse(primaryBody); } catch (e) { console.warn(`[seed] neighborhoods JSON parse failed: ${e.message}`); }
  }

  if (!Array.isArray(features) || features.length === 0) {
    const geoUrl = 'https://data.kcmo.org/api/geospatial/q45j-ejyk?method=export&type=GeoJSON';
    console.log(`[seed] primary returned 0 records, trying GeoJSON: ${geoUrl}`);
    try {
      const geoRes = await fetch(geoUrl);
      console.log(`[seed] neighborhoods GeoJSON status=${geoRes.status}`);
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        features = geoData.features || [];
        console.log(`[seed] GeoJSON endpoint returned ${features.length} features`);
      }
    } catch (e) {
      console.warn(`[seed] GeoJSON fetch failed: ${e.message}`);
    }
  } else {
    console.log(`[seed] primary endpoint returned ${features.length} records`);
  }

  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('Both neighborhood endpoints returned 0 records');
  }

  let count = 0;
  for (const feature of features) {
    // Handle both flat SODA JSON and GeoJSON Feature formats
    const props = feature.properties || feature;

    // Try all known field name variations; fall back to first plausible string field
    const name = props.name
      || props.neighborhood_name
      || props.nbhd_name
      || props.nhood
      || props.nbhd
      || props.nhood_name
      || props.neighborhoodname
      || props.nbhd_na
      || props.label
      || props.nbhd_label
      || Object.entries(props).find(([k, v]) =>
          !k.startsWith(':') && typeof v === 'string' && v.length > 2 && v.length < 80 && /^[A-Za-z]/.test(v)
        )?.[1];

    if (!name) {
      console.warn(`[seed] no name field found — record keys: ${Object.keys(props).join(', ')}`);
      continue;
    }

    // Skip polygon parsing until field names are confirmed — centroid/bbox stay null
    const geom = feature.geometry || feature.the_geom || props.the_geom || null;
    let polygon = null;
    let centroidLat = null, centroidLng = null;
    let bboxNorth = null, bboxSouth = null, bboxEast = null, bboxWest = null;

    if (geom && geom.coordinates) {
      polygon = geom;
      const pts = extractCoords(geom);
      if (pts.length) {
        const lngs = pts.map(p => p[0]);
        const lats  = pts.map(p => p[1]);
        centroidLng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
        centroidLat = lats.reduce((a, b) => a + b, 0) / lats.length;
        bboxNorth   = Math.max(...lats);
        bboxSouth   = Math.min(...lats);
        bboxEast    = Math.max(...lngs);
        bboxWest    = Math.min(...lngs);
      }
    }

    const slug = toSlug(name);

    await pool.query(`
      INSERT INTO kc_neighborhoods
        (name, slug, polygon, centroid_lat, centroid_lng,
         bbox_north, bbox_south, bbox_east, bbox_west)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (name) DO UPDATE SET
        slug         = EXCLUDED.slug,
        polygon      = EXCLUDED.polygon,
        centroid_lat = EXCLUDED.centroid_lat,
        centroid_lng = EXCLUDED.centroid_lng,
        bbox_north   = EXCLUDED.bbox_north,
        bbox_south   = EXCLUDED.bbox_south,
        bbox_east    = EXCLUDED.bbox_east,
        bbox_west    = EXCLUDED.bbox_west
    `, [
      name, slug,
      polygon ? JSON.stringify(polygon) : null,
      centroidLat, centroidLng,
      bboxNorth, bboxSouth, bboxEast, bboxWest,
    ]);
    count++;
  }

  console.log(`[seed] Loaded ${count} KC neighborhoods`);
}

// ── seed311Requests ───────────────────────────────────────────────────────────

async function seed311Requests(pool, neighborhoodName) {
  // Discover actual field names before attempting neighborhood filter queries
  try {
    const metaRes = await fetch('https://data.kcmo.org/api/views/d4px-6rwg.json', { signal: AbortSignal.timeout(8000) });
    console.log(`[311-seed] metadata status=${metaRes.status}`);
    if (metaRes.ok) {
      const meta = await metaRes.json();
      const cols = (meta.columns || []).map(c => c.fieldName || c.name);
      console.log(`[311-seed] dataset columns: ${cols.join(', ')}`);
    }
  } catch (e) {
    console.warn(`[311-seed] metadata fetch failed: ${e.message}`);
  }
  try {
    const sampleRes = await fetch('https://data.kcmo.org/resource/d4px-6rwg.json?$limit=5', { signal: AbortSignal.timeout(8000) });
    console.log(`[311-seed] sample status=${sampleRes.status}`);
    if (sampleRes.ok) {
      const sample = await sampleRes.json();
      if (sample.length > 0) console.log(`[311-seed] first record keys: ${Object.keys(sample[0]).join(', ')}`);
    }
  } catch (e) {
    console.warn(`[311-seed] sample fetch failed: ${e.message}`);
  }

  const safeName  = neighborhoodName.replace(/'/g, "''");
  const firstWord = neighborhoodName.split(/\s+/)[0].replace(/'/g, "''");

  // 7at3-sxhp: creation_date sort, category/type fields
  // d4px-6rwg: open_date_time sort, issue_type/issue_sub_type fields
  const DATASETS = [
    { base: 'https://data.kcmo.org/resource/7at3-sxhp.json', order: 'creation_date' },
    { base: 'https://data.kcmo.org/resource/d4px-6rwg.json', order: 'open_date_time' },
  ];
  const whereClauses = [
    `neighborhood='${safeName}'`,
    `neighborhood='${firstWord}'`,
    `neighborhood like '%${firstWord}%'`,
  ];

  let rows = [];
  outer:
  for (const dataset of DATASETS) {
    const tail = `&$limit=500&$order=${dataset.order}%20DESC`;
    for (const where of whereClauses) {
      const url = `${dataset.base}?$where=${encodeURIComponent(where)}${tail}`;
      console.log(`[311-seed] trying ${dataset.base.split('/').pop()} SOQL: ${where}`);
      try {
        const res = await fetch(url);
        console.log(`[311-seed] status=${res.status} neighborhood=${neighborhoodName}`);
        if (!res.ok) {
          const errBody = await res.text();
          console.warn(`[311-seed] error body: ${errBody.substring(0, 300)}`);
          continue;
        }
        const data = await res.json();
        console.log(`[311-seed] ${data.length} records returned for SOQL: ${where}`);
        if (data.length > 0) { rows = data; break outer; }
      } catch (e) {
        console.warn(`[311-seed] attempt failed: ${e.message}`);
      }
    }
  }

  let count = 0;
  for (const r of rows) {
    // Confirmed 7at3-sxhp field names; d4px-6rwg fields kept as fallbacks
    const requestId = r.case_id || r.workorder_ || null;
    if (!requestId) continue;

    await pool.query(`
      INSERT INTO kc_311_requests
        (request_id, category, type, description, neighborhood,
         status, created_date, closed_date, lat, lng)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (request_id) DO NOTHING
    `, [
      requestId,
      r.category      || r.request_type  || r.issue_type    || null,
      r.type          || r.issue_sub_type || null,
      r.detail        || r.reported_issue || r.description   || null,
      r.neighborhood  || neighborhoodName,
      r.status        || r.current_status || null,
      r.creation_date || r.open_date_time || null,
      r.resolved_date || r.closed_date   || null,
      r.ycoordinate ? parseFloat(r.ycoordinate) : null,
      r.xcoordinate ? parseFloat(r.xcoordinate) : null,
    ]);
    count++;
  }

  console.log(`[seed] Loaded ${count} 311 requests for ${neighborhoodName}`);
}

// ── seedOpportunityAtlas ──────────────────────────────────────────────────────

async function seedOpportunityAtlas(pool) {
  const url = 'https://raw.githubusercontent.com/OpportunityInsights/atlas/master/atlas_data_download/tract_outcomes_simple.csv';

  let text;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'PresageIQ/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    console.log('[seed] Opportunity Atlas CSV not available at expected URL — manual load required');
    return;
  }

  const rows = parseCSV(text);
  const TARGET = new Set(['20', '29']); // KS=20, MO=29

  let count = 0;
  for (const row of rows) {
    const stateFips  = String(row.state  || '').padStart(2, '0');
    if (!TARGET.has(stateFips)) continue;

    const countyFips = String(row.county || '').padStart(3, '0');
    const tractFips  = String(row.tract  || '').padStart(6, '0');
    const tractId    = `${stateFips}${countyFips}${tractFips}`;
    if (tractId.length !== 11) continue;

    await pool.query(`
      INSERT INTO opportunity_atlas
        (tract_id, state_fips, county_fips, tract_fips,
         kfr_pooled_pooled_mean, kfr_black_pooled_mean,
         kfr_white_pooled_mean,  kfr_hisp_pooled_mean,
         jail_pooled_pooled_mean, jail_black_pooled_mean,
         emp_pooled_pooled_mean, teenbrth_pooled_pooled_mean)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (tract_id) DO NOTHING
    `, [
      tractId, stateFips, countyFips, tractFips,
      num(row.kfr_pooled_pooled_mean),
      num(row.kfr_black_pooled_mean),
      num(row.kfr_white_pooled_mean),
      num(row.kfr_hisp_pooled_mean),
      num(row.jail_pooled_pooled_mean),
      num(row.jail_black_pooled_mean),
      num(row.emp_pooled_pooled_mean),
      num(row.teenbrth_pooled_pooled_mean),
    ]);
    count++;
  }

  console.log(`[seed] Loaded ${count} Opportunity Atlas tracts for MO/KS`);
}

// ── runAllSeeds ───────────────────────────────────────────────────────────────

async function runAllSeeds(pool) {
  try {
    await seedNeighborhoods(pool);
  } catch (err) {
    console.error('[seed] seedNeighborhoods failed:', err.message);
  }
  try {
    await seedOpportunityAtlas(pool);
  } catch (err) {
    console.error('[seed] seedOpportunityAtlas failed:', err.message);
  }
}

module.exports = { seedNeighborhoods, seed311Requests, seedOpportunityAtlas, runAllSeeds };
