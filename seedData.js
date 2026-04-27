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
  const res = await fetch('https://data.kcmo.org/resource/q45j-ejyk.json?$limit=300');
  if (!res.ok) throw new Error(`KCMO neighborhoods API error: ${res.status}`);
  const features = await res.json();

  let count = 0;
  for (const feature of features) {
    const name = feature.name || feature.neighborhood_name || feature.nbhd_name || feature.nhood;
    if (!name) continue;

    const geom = feature.the_geom || null;
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
  const safeName  = neighborhoodName.replace(/'/g, "''");
  const firstWord = neighborhoodName.split(/\s+/)[0].replace(/'/g, "''");
  const whereClause = neighborhoodName.includes(' ')
    ? `neighborhood='${safeName}' OR neighborhood='${firstWord}' OR neighborhood like '%${firstWord}%'`
    : `neighborhood='${safeName}' OR neighborhood like '%${safeName}%'`;
  const url = `https://data.kcmo.org/resource/d4px-6rwg.json?$where=${encodeURIComponent(whereClause)}&$limit=500&$order=created_date%20DESC`;
  console.log(`[311-seed] SOQL: ${whereClause}`);
  const res = await fetch(url);
  console.log(`[311-seed] status=${res.status} neighborhood=${neighborhoodName}`);
  if (!res.ok) throw new Error(`KCMO 311 API error: ${res.status}`);
  const rows = await res.json();
  console.log(`[311-seed] ${rows.length} records returned for ${neighborhoodName}`);

  let count = 0;
  for (const r of rows) {
    const requestId = r.servicerequestnum || r.request_id || null;
    if (!requestId) continue;

    await pool.query(`
      INSERT INTO kc_311_requests
        (request_id, category, type, description, neighborhood,
         status, created_date, closed_date, lat, lng)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (request_id) DO NOTHING
    `, [
      requestId,
      r.requesttype  || r.category    || null,
      r.type         || r.problem     || null,
      r.description  || r.comments    || r.details || null,
      r.neighborhood || neighborhoodName,
      r.status       || null,
      r.createdate   || r.created_date || null,
      r.closeddate   || r.closed_date  || null,
      r.latitude  ? parseFloat(r.latitude)  : null,
      r.longitude ? parseFloat(r.longitude) : null,
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
