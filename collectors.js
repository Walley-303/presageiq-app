// collectors.js — PresageIQ Data Intelligence Collection Layer
// All external data sources compile here. Receives the shared pg Pool from server.js.

const crypto = require('crypto');

// ── KC Neighborhood Definitions ───────────────────────────────────────────────
const KC_NEIGHBORHOODS = [
  { name: 'Waldo',               zip: '64131', lat: 38.9468, lng: -94.5922, aliases: ['waldo'] },
  { name: 'Brookside',           zip: '64113', lat: 38.9537, lng: -94.6011, aliases: ['brookside'] },
  { name: 'Westport',            zip: '64111', lat: 39.0401, lng: -94.5948, aliases: ['westport'] },
  { name: 'Country Club Plaza',  zip: '64112', lat: 39.0291, lng: -94.5942, aliases: ['plaza', 'country club plaza', 'kc plaza', 'the plaza'] },
  { name: 'Crossroads',          zip: '64108', lat: 39.0854, lng: -94.5803, aliases: ['crossroads', 'crossroads arts district', 'crossroads arts'] },
  { name: 'River Market',        zip: '64106', lat: 39.1104, lng: -94.5780, aliases: ['river market'] },
  { name: 'Midtown',             zip: '64110', lat: 39.0484, lng: -94.5753, aliases: ['midtown'] },
  { name: '18th and Vine',       zip: '64108', lat: 39.0885, lng: -94.5563, aliases: ['18th and vine', '18th & vine', 'jazz district', '18th vine'] },
  { name: 'Hyde Park',           zip: '64109', lat: 39.0624, lng: -94.5634, aliases: ['hyde park'] },
  { name: 'Westside',            zip: '64108', lat: 39.0980, lng: -94.5954, aliases: ['westside', 'west side'] },
  { name: 'Martin City',         zip: '64137', lat: 38.8816, lng: -94.5672, aliases: ['martin city'] },
  { name: 'Downtown KC',         zip: '64105', lat: 39.0997, lng: -94.5786, aliases: ['downtown', 'downtown kc', 'downtown kansas city', 'power and light'] },
  { name: 'North KC',            zip: '64116', lat: 39.1280, lng: -94.5682, aliases: ['north kc', 'north kansas city', 'nkc'] },
  { name: 'Zona Rosa',           zip: '64153', lat: 39.2146, lng: -94.7157, aliases: ['zona rosa'] },
  { name: "Lee's Summit",        zip: '64063', lat: 38.9108, lng: -94.3816, aliases: ["lee's summit", 'lees summit', 'ls'] },
  { name: 'Overland Park',       zip: '66210', lat: 38.9822, lng: -94.6708, aliases: ['overland park', 'op'] },
  { name: 'Leawood',             zip: '66211', lat: 38.9334, lng: -94.6201, aliases: ['leawood'] },
  { name: 'Lenexa',              zip: '66215', lat: 38.9539, lng: -94.7340, aliases: ['lenexa'] },
];

const KC_BUSINESS_TYPES = [
  { name: 'restaurant', aliases: ['restaurant', 'dining', 'eatery', 'dine', 'food'] },
  { name: 'bar',        aliases: ['bar', 'bars', 'taproom', 'pub', 'tavern', 'nightclub', 'lounge'] },
  { name: 'brewery',    aliases: ['brewery', 'brewpub', 'craft beer', 'brewing'] },
  { name: 'cafe',       aliases: ['café', 'cafe', 'coffee', 'espresso', 'bakery', 'pastry'] },
  { name: 'food_truck', aliases: ['food truck', 'food trailer', 'pop-up', 'popup', 'pop up'] },
  { name: 'retail',     aliases: ['retail', 'store', 'shop', 'boutique', 'market'] },
  { name: 'pizza',      aliases: ['pizza', 'pizzeria'] },
  { name: 'bbq',        aliases: ['bbq', 'barbecue', 'barbeque', 'smoked'] },
  { name: 'brunch',     aliases: ['brunch'] },
  { name: 'sushi',      aliases: ['sushi', 'ramen', 'japanese'] },
  { name: 'mexican',    aliases: ['taco', 'tacos', 'mexican', 'tex-mex', 'burrito', 'tamale'] },
];

const REDDIT_SUBREDDITS = ['kansascity', 'KCFoodScene', 'kansascityfood', 'kansascitylocal'];

const GDELT_QUERIES = [
  'Kansas City restaurant',
  'Kansas City food',
  'Kansas City bar brewery',
  'Kansas City small business retail',
];

function detectNeighborhoods(text) {
  const lower = text.toLowerCase();
  return KC_NEIGHBORHOODS
    .filter(n => n.aliases.some(a => lower.includes(a)))
    .map(n => n.name);
}

function detectBusinessTypes(text) {
  const lower = text.toLowerCase();
  return KC_BUSINESS_TYPES
    .filter(bt => bt.aliases.some(a => lower.includes(a)))
    .map(bt => bt.name)
    .filter((v, i, a) => a.indexOf(v) === i); // dedupe
}

function detectSentiment(text) {
  const lower = text.toLowerCase();
  const posWords = ['great', 'amazing', 'love', 'best', 'excellent', 'recommend', 'delicious', 'fantastic', 'awesome', 'perfect', 'wonderful', 'outstanding', 'gem', 'favorite', 'worth'];
  const negWords = ['terrible', 'awful', 'closed', 'disappointing', 'avoid', 'worst', 'overpriced', 'bad experience', 'never again', 'rude', 'disgusting', 'horrible', 'gross', 'failed', 'shutdown'];
  let score = 0;
  posWords.forEach(w => { if (lower.includes(w)) score++; });
  negWords.forEach(w => { if (lower.includes(w)) score--; });
  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
}

// ── fetchCensusData — ACS 5-year estimates by ZIP (no API key required) ────────
async function fetchCensusData(zip) {
  if (!zip) return null;
  try {
    const vars = 'B19013_001E,B01003_001E,B25003_002E,B17001_002E,B15003_022E,B02001_002E,B02001_003E,B03001_003E';
    // Determine state code: MO = 29, KS = 20
    const firstTwo = parseInt(zip.substring(0, 2));
    const stateCode = (firstTwo >= 66 && firstTwo <= 67) ? '20' : '29';
    const url = `https://api.census.gov/data/2023/acs/acs5?get=NAME,${vars}&for=zip+code+tabulation+area:${zip}&in=state:${stateCode}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.warn(`[census] ZIP ${zip} returned ${res.status}`); return null; }
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2) return null;
    const headers = data[0];
    const values = data[1];
    const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    const totalPop = parseInt(row['B01003_001E']) || 1;
    const belowPoverty = parseInt(row['B17001_002E']) || 0;
    return {
      zip,
      medianIncome: parseInt(row['B19013_001E']) || null,
      totalPop,
      ownerOccupied: parseInt(row['B25003_002E']) || 0,
      belowPoverty,
      povertyRate: Math.round(belowPoverty / totalPop * 1000) / 10,
      whitePct: Math.round(parseInt(row['B02001_002E'] || 0) / totalPop * 1000) / 10,
      blackPct: Math.round(parseInt(row['B02001_003E'] || 0) / totalPop * 1000) / 10,
      hispanicPct: Math.round(parseInt(row['B03001_003E'] || 0) / totalPop * 1000) / 10,
      bachelorsPlus: Math.round(parseInt(row['B15003_022E'] || 0) / totalPop * 1000) / 10,
      dataYear: 2023,
    };
  } catch (e) {
    console.warn(`[census] failed: ${e.message}`);
    return null;
  }
}

// ── fetchHmdaData — CFPB HMDA mortgage lending patterns for KC metro ──────────
async function fetchHmdaData() {
  try {
    const url = 'https://ffiec.cfpb.gov/api/public/hmda/data/nationwide/aggregations?years=2022&msamd=28140&variable=action_taken';
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) { console.warn(`[hmda] returned ${res.status}`); return null; }
    const data = await res.json();
    const aggs = data?.aggregations || data?.data || [];
    let originated = 0, denied = 0, total = 0;
    for (const item of aggs) {
      const actionTaken = parseInt(item.action_taken || item.action_taken_type || 0);
      const count = parseInt(item.count || 0);
      total += count;
      if (actionTaken === 1) originated += count;
      if (actionTaken === 3) denied += count;
    }
    const applicableTotal = originated + denied;
    return {
      msaCode: '28140',
      year: 2022,
      totalApplications: total,
      totalOriginated: originated,
      totalDenied: denied,
      overallDenialRate: applicableTotal > 0 ? Math.round(denied / applicableTotal * 1000) / 10 : null,
      note: 'HMDA data reflects KC metro mortgage lending patterns',
    };
  } catch (e) {
    console.warn(`[hmda] failed: ${e.message}`);
    return null;
  }
}

// ── fetchEJScreen — EPA environmental justice indicators for a location ────────
async function fetchEJScreen(lat, lng) {
  if (lat == null || lng == null) return null;
  try {
    const params = new URLSearchParams({
      namestr: `${lat},${lng}`,
      unit: 'miles',
      distance: '0.5',
      areatype: 'circle',
      areaid: '',
      f: 'json',
    });
    const url = `https://ejscreen.epa.gov/mapper/ejscreenRESTbroker.aspx?${params}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) { console.warn(`[ejscreen] returned ${res.status}`); return null; }
    const data = await res.json();
    const o = data?.outputs || data?.data || data;
    if (!o || typeof o !== 'object') return null;
    return {
      minorityPct: o.MINORPCT != null ? Math.round(o.MINORPCT * 1000) / 10 : null,
      lowIncomePct: o.LOWINCPCT != null ? Math.round(o.LOWINCPCT * 1000) / 10 : null,
      linguisticIsolationPct: o.LINGISOPCT != null ? Math.round(o.LINGISOPCT * 1000) / 10 : null,
      ejIndexNationalPct: o.EJINDEXN != null ? Math.round(o.EJINDEXN * 10) / 10 : null,
      cancerRiskPct: o.CANCER != null ? Math.round(o.CANCER * 10) / 10 : null,
      dieselPM: o.DSLPM != null ? Math.round(o.DSLPM * 100) / 100 : null,
      trafficProximity: o.PTRAF != null ? Math.round(o.PTRAF * 10) / 10 : null,
      leadPaintPct: o.PLDPNT != null ? Math.round(o.PLDPNT * 1000) / 10 : null,
      dataSource: 'EPA EJScreen',
    };
  } catch (e) {
    console.warn(`[ejscreen] failed: ${e.message}`);
    return null;
  }
}

// ── fetchKCNeighborhoodPop — KCMO Open Data neighborhood population ────────────
async function fetchKCNeighborhoodPop(neighborhood) {
  if (!neighborhood) return null;
  try {
    const nbhd = neighborhood.replace(/'/g, "''");
    const url = `https://data.kcmo.org/resource/7nq4-imiw.json?$where=${encodeURIComponent(`neighborhood_name like '%${nbhd}%'`)}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { console.warn(`[kcpop] returned ${res.status}`); return null; }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const row = data[0];
    return {
      neighborhood: row.neighborhood_name || neighborhood,
      population: parseInt(row.population || row.pop || 0) || null,
      households: parseInt(row.households || row.hh || 0) || null,
      medianAge: parseFloat(row.median_age || 0) || null,
      dataSource: 'KCMO Open Data',
    };
  } catch (e) {
    console.warn(`[kcpop] failed: ${e.message}`);
    return null;
  }
}

// ── fetchNeighborhoodBusinesses — Google Places nearby via neighborhood boundary ─
async function fetchNeighborhoodBusinesses(pool, neighborhoodName) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // Look up centroid and bbox from kc_neighborhoods table
  let lat, lng, radius;
  try {
    const r = await pool.query(
      `SELECT centroid_lat, centroid_lng, bbox_north, bbox_south, bbox_east, bbox_west
       FROM kc_neighborhoods WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [neighborhoodName]
    );
    if (r.rows.length) {
      const n = r.rows[0];
      lat = n.centroid_lat;
      lng = n.centroid_lng;
      const heightM = (n.bbox_north - n.bbox_south) * 111000;
      const widthM  = (n.bbox_east - n.bbox_west) * 111000 * Math.cos(lat * Math.PI / 180);
      radius = Math.max(300, Math.min(Math.round(Math.max(heightM, widthM) / 2), 2500));
    }
  } catch (e) {
    console.warn(`[businesses] DB lookup failed: ${e.message}`);
  }

  // Fall back to in-memory KC_NEIGHBORHOODS list at 1-mile radius
  if (!lat || !lng) {
    const fb = KC_NEIGHBORHOODS.find(n => n.name.toLowerCase() === neighborhoodName.toLowerCase());
    if (fb) { lat = fb.lat; lng = fb.lng; }
    radius = 1609;
  }

  const empty = { businesses: [], totalCount: 0, source: 'google_places', neighborhood: neighborhoodName };
  if (!lat || !lng) return empty;
  if (!apiKey) { console.warn('[businesses] GOOGLE_PLACES_API_KEY not set — skipping'); return empty; }

  const TYPE_GROUPS = [
    ['restaurant', 'bar', 'cafe', 'bakery', 'fast_food_restaurant', 'meal_takeaway'],
    ['store', 'clothing_store', 'grocery_store', 'convenience_store', 'pharmacy', 'supermarket'],
    ['beauty_salon', 'gym', 'laundry', 'bank', 'gas_station', 'hair_care'],
  ];
  const fieldMask = 'places.id,places.displayName,places.formattedAddress,places.types,places.rating,places.userRatingCount,places.priceLevel,places.location';
  const baseBody  = { maxResultCount: 20, locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } } };

  const results = await Promise.all(TYPE_GROUPS.map(types =>
    fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify({ ...baseBody, includedTypes: types }),
      signal: AbortSignal.timeout(10000),
    })
    .then(r => r.ok ? r.json() : { places: [] })
    .catch(() => ({ places: [] }))
  ));

  const seen = new Set();
  const businesses = [];
  for (const result of results) {
    for (const place of (result.places || [])) {
      if (!place.id || seen.has(place.id)) continue;
      seen.add(place.id);
      businesses.push({
        name:        place.displayName?.text || '',
        address:     place.formattedAddress || '',
        category:    place.types?.[0] || '',
        rating:      place.rating ?? null,
        reviewCount: place.userRatingCount ?? null,
        priceLevel:  place.priceLevel || null,
        lat:         place.location?.latitude ?? null,
        lng:         place.location?.longitude ?? null,
      });
      if (businesses.length >= 60) break;
    }
    if (businesses.length >= 60) break;
  }

  return { businesses, totalCount: businesses.length, source: 'google_places', neighborhood: neighborhoodName };
}

// ── fetch311Data — Check DB then seed on demand, return aggregated stats ──────
async function fetch311Data(pool, neighborhoodName) {
  let existingCount = 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*) FROM kc_311_requests
       WHERE LOWER(neighborhood) = LOWER($1) AND fetched_at >= NOW() - INTERVAL '90 days'`,
      [neighborhoodName]
    );
    existingCount = parseInt(r.rows[0].count || 0);
  } catch (e) {
    console.warn(`[311] DB count failed: ${e.message}`);
  }

  if (existingCount < 10) {
    try {
      const { seed311Requests } = require('./seedData');
      await seed311Requests(pool, neighborhoodName);
    } catch (e) {
      console.warn(`[311] seed failed: ${e.message}`);
    }
  }

  let rows = [];
  try {
    const r = await pool.query(`
      SELECT category, COUNT(*) AS cnt
      FROM kc_311_requests
      WHERE LOWER(neighborhood) = LOWER($1)
        AND fetched_at >= NOW() - INTERVAL '90 days'
      GROUP BY category
      ORDER BY cnt DESC
    `, [neighborhoodName]);
    rows = r.rows;
  } catch (e) {
    console.warn(`[311] aggregation failed: ${e.message}`);
  }

  const totalRequests  = rows.reduce((s, r) => s + parseInt(r.cnt), 0);
  const topCategories  = rows.slice(0, 10).map(r => ({ category: r.category || 'Unknown', count: parseInt(r.cnt) }));
  const find = (keywords) => rows.find(r => keywords.some(k => (r.category || '').toLowerCase().includes(k)));

  return {
    totalRequests,
    topCategories,
    abandonedProperty: parseInt(find(['abandon'])?.cnt || 0),
    streetIssues:      parseInt(find(['pothole', 'street', 'road', 'sidewalk'])?.cnt || 0),
    codeViolations:    parseInt(find(['code', 'violation'])?.cnt || 0),
    dataFreshness:     '90 days',
    neighborhood:      neighborhoodName,
  };
}

// ── fetchNeighborhoodSentiment — Reddit neighborhood sentiment signal ──────────
async function fetchNeighborhoodSentiment(neighborhoodName) {
  const queries = [
    `${neighborhoodName} Kansas City`,
    `${neighborhoodName} KC neighborhood`,
    `${neighborhoodName} development`,
    `${neighborhoodName} community`,
  ];
  const subreddits = ['kansascity', 'KCFoodScene', 'kansascitylocal'];

  const posts = [];
  const seen  = new Set();

  outer:
  for (const query of queries) {
    for (const sub of subreddits) {
      try {
        const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance&t=year&limit=10`;
        const r = await fetch(url, {
          headers: { 'User-Agent': 'PresageIQ-Internal/1.0', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) continue;
        const data = await r.json();
        for (const { data: p } of (data?.data?.children || [])) {
          if (!p.id || seen.has(p.id)) continue;
          seen.add(p.id);
          const text = `${p.title || ''} ${p.selftext || ''}`;
          posts.push({
            title:     (p.title || '').substring(0, 150),
            body:      (p.selftext || '').substring(0, 300),
            sentiment: detectSentiment(text),
            subreddit: sub,
            date:      p.created_utc ? new Date(p.created_utc * 1000).toISOString().substring(0, 10) : null,
            score:     p.score || 0,
            url:       p.permalink ? `https://reddit.com${p.permalink}` : null,
          });
          if (posts.length >= 30) break outer;
        }
        await new Promise(res => setTimeout(res, 500));
      } catch (e) { /* skip */ }
    }
  }

  const counts = { positive: 0, negative: 0, neutral: 0 };
  posts.forEach(p => { counts[p.sentiment] = (counts[p.sentiment] || 0) + 1; });
  const overallSentiment = counts.positive > counts.negative ? 'positive'
    : counts.negative > counts.positive ? 'negative' : 'neutral';

  return { posts, overallSentiment, signalCount: posts.length, neighborhood: neighborhoodName };
}

function makeCollectors(pool) {

  async function logStart(source, triggeredBy = 'scheduler') {
    const res = await pool.query(
      `INSERT INTO collection_log (source, triggered_by) VALUES ($1, $2) RETURNING id`,
      [source, triggeredBy]
    );
    return res.rows[0].id;
  }

  async function logDone(logId, fetched, upserted) {
    await pool.query(
      `UPDATE collection_log SET status='success', completed_at=NOW(), records_fetched=$1, records_upserted=$2 WHERE id=$3`,
      [fetched, upserted, logId]
    );
  }

  async function logError(logId, err) {
    await pool.query(
      `UPDATE collection_log SET status='error', completed_at=NOW(), error_message=$1 WHERE id=$2`,
      [err.message, logId]
    );
  }

  // ── Reddit ────────────────────────────────────────────────────────────────
  async function collectReddit({ triggeredBy = 'scheduler' } = {}) {
    const logId = await logStart('reddit', triggeredBy);
    let fetched = 0, upserted = 0;
    try {
      for (const sub of REDDIT_SUBREDDITS) {
        try {
          const url = `https://www.reddit.com/r/${sub}/new.json?limit=100`;
          const r = await fetch(url, {
            headers: { 'User-Agent': 'PresageIQ-Internal/1.0', 'Accept': 'application/json' }
          });
          if (!r.ok) {
            console.warn(`[reddit] r/${sub} returned ${r.status} — skipping`);
            continue;
          }
          const data = await r.json();
          const posts = data?.data?.children || [];
          fetched += posts.length;

          for (const { data: p } of posts) {
            const text = `${p.title || ''} ${p.selftext || ''}`;
            const neighborhoods = detectNeighborhoods(text);
            const businessTypes = detectBusinessTypes(text);
            const sentiment = detectSentiment(text);
            const sourceId = `${sub}_${p.id}`;

            try {
              const ins = await pool.query(`
                INSERT INTO community_intel
                  (source, source_id, title, body, url, author, score,
                   neighborhoods, business_types, sentiment, post_date, raw_data)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TO_TIMESTAMP($11),$12)
                ON CONFLICT (source, source_id) DO UPDATE SET
                  score = EXCLUDED.score,
                  neighborhoods = EXCLUDED.neighborhoods,
                  business_types = EXCLUDED.business_types,
                  sentiment = EXCLUDED.sentiment
                RETURNING (xmax = 0) AS inserted
              `, [
                'reddit', sourceId,
                (p.title || '').substring(0, 500),
                (p.selftext || '').substring(0, 3000),
                `https://reddit.com${p.permalink}`,
                p.author || '',
                p.score || 0,
                neighborhoods,
                businessTypes,
                sentiment,
                p.created_utc || Math.floor(Date.now() / 1000),
                JSON.stringify({ id: p.id, subreddit: sub, num_comments: p.num_comments, url: p.url })
              ]);
              if (ins.rows[0]?.inserted) upserted++;
            } catch (e) { /* skip individual post DB errors */ }
          }
        } catch (e) {
          console.warn(`[reddit] r/${sub} collection error: ${e.message}`);
        }
        // Polite delay between subreddits
        await new Promise(res => setTimeout(res, 2000));
      }
      await logDone(logId, fetched, upserted);
      console.log(`[reddit] Done — fetched ${fetched}, upserted ${upserted}`);
      return { fetched, upserted };
    } catch (e) {
      await logError(logId, e);
      throw e;
    }
  }

  // ── GDELT ────────────────────────────────────────────────────────────────
  async function collectGdelt({ triggeredBy = 'scheduler' } = {}) {
    const logId = await logStart('gdelt', triggeredBy);
    let fetched = 0, upserted = 0;
    const seenUrls = new Set();

    try {
      for (const query of GDELT_QUERIES) {
        try {
          const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=250&format=json&timespan=1d`;
          const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
          if (!r.ok) { console.warn(`[gdelt] "${query}" returned ${r.status}`); continue; }
          const data = await r.json();
          const articles = data?.articles || [];
          fetched += articles.length;

          for (const article of articles) {
            if (!article.url || seenUrls.has(article.url)) continue;
            seenUrls.add(article.url);

            const text = `${article.title || ''} ${article.seendescription || ''}`;
            const neighborhoods = detectNeighborhoods(text);
            const businessTypes = detectBusinessTypes(text);
            const sourceId = crypto.createHash('md5').update(article.url).digest('hex');

            // Parse GDELT date format: 20260401T063000Z
            let postDate = new Date();
            if (article.seendate) {
              const m = article.seendate.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/);
              if (m) postDate = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
            }

            try {
              const ins = await pool.query(`
                INSERT INTO community_intel
                  (source, source_id, title, body, url, author, score,
                   neighborhoods, business_types, sentiment, post_date, raw_data)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                ON CONFLICT (source, source_id) DO NOTHING
                RETURNING (xmax = 0) AS inserted
              `, [
                'gdelt', sourceId,
                (article.title || '').substring(0, 500),
                (article.seendescription || '').substring(0, 2000),
                article.url,
                article.domain || '',
                0,
                neighborhoods,
                businessTypes,
                'neutral',
                postDate,
                JSON.stringify({ domain: article.domain, language: article.language, sourcecountry: article.sourcecountry })
              ]);
              if (ins.rows[0]?.inserted) upserted++;
            } catch (e) { /* skip */ }
          }
        } catch (e) {
          console.warn(`[gdelt] "${query}" error: ${e.message}`);
        }
        await new Promise(res => setTimeout(res, 500));
      }
      await logDone(logId, fetched, upserted);
      console.log(`[gdelt] Done — fetched ${fetched}, upserted ${upserted}`);
      return { fetched, upserted };
    } catch (e) {
      await logError(logId, e);
      throw e;
    }
  }

  // ── KC Open Data ─────────────────────────────────────────────────────────
  async function collectKcOpenData({ triggeredBy = 'scheduler' } = {}) {
    const logId = await logStart('kc_open_data', triggeredBy);
    let fetched = 0, upserted = 0;

    try {
      // Paginate through business license holders
      let offset = 0;
      const limit = 1000;
      while (true) {
        const url = `https://data.kcmo.org/resource/pnm4-68wg.json?$limit=${limit}&$offset=${offset}&$order=:id`;
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!r.ok) { console.warn(`[kc_open_data] SODA returned ${r.status}`); break; }
        const rows = await r.json();
        if (!rows.length) break;
        fetched += rows.length;

        for (const biz of rows) {
          // KC Open Data field names — verified against the dataset schema
          const name = biz.business_name || biz.businessname || biz.dba_name || '';
          if (!name) continue;
          const zip = (biz.zipcode || biz.zip || '').replace(/\D/g, '').substring(0, 5);
          const nbhd = KC_NEIGHBORHOODS.find(n => n.zip === zip);
          const sourceId = biz.id || biz.licensenumber || biz.account_number || `${name}-${zip}`;

          try {
            const ins = await pool.query(`
              INSERT INTO business_profiles
                (source, source_id, name, dba_name, address, neighborhood, zip,
                 business_type, license_type, license_status, raw_data, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
              ON CONFLICT (source, source_id) DO UPDATE SET
                license_status = EXCLUDED.license_status,
                updated_at = NOW()
              RETURNING (xmax = 0) AS inserted
            `, [
              'kc_open_data',
              String(sourceId),
              name.substring(0, 300),
              (biz.dba_name || '').substring(0, 300),
              (biz.address || '').substring(0, 300),
              nbhd?.name || '',
              zip,
              biz.business_type || '',
              biz.valid_license_for || biz.license_type || '',
              biz.license_status || biz.status || 'unknown',
              JSON.stringify(biz)
            ]);
            if (ins.rows[0]?.inserted) upserted++;
          } catch (e) { /* skip individual row */ }
        }

        if (rows.length < limit) break;
        offset += limit;
        await new Promise(res => setTimeout(res, 300));
      }

      await logDone(logId, fetched, upserted);
      console.log(`[kc_open_data] Done — fetched ${fetched}, upserted ${upserted}`);
      return { fetched, upserted };
    } catch (e) {
      await logError(logId, e);
      throw e;
    }
  }

  // ── Census ACS ───────────────────────────────────────────────────────────
  async function collectCensus({ triggeredBy = 'scheduler' } = {}) {
    const apiKey = process.env.CENSUS_API_KEY;
    if (!apiKey) {
      console.log('[census] CENSUS_API_KEY not set — skipping (free key at api.census.gov)');
      return { fetched: 0, upserted: 0, skipped: true };
    }
    const logId = await logStart('census', triggeredBy);
    let fetched = 0, upserted = 0;

    const vars = [
      'B01003_001E', // Total population
      'B19013_001E', // Median household income
      'B01002_001E', // Median age
      'B25003_002E', // Owner-occupied housing units
      'B25003_003E', // Renter-occupied housing units
      'B17001_002E', // Population below poverty level
      'B15003_022E', // Bachelor's degree
      'B02001_002E', // White alone
      'B02001_003E', // Black or African American alone
      'B03002_012E', // Hispanic or Latino
    ].join(',');

    // Deduplicate ZIPs — multiple neighborhoods share a ZIP
    const uniqueZips = [...new Set(KC_NEIGHBORHOODS.map(n => n.zip))];

    for (const zip of uniqueZips) {
      try {
        const url = `https://api.census.gov/data/2022/acs/acs5?get=NAME,${vars}&for=zip+code+tabulation+area:${zip}&key=${apiKey}`;
        const r = await fetch(url);
        if (!r.ok) { console.warn(`[census] ZIP ${zip} returned ${r.status}`); continue; }
        const data = await r.json();
        if (!Array.isArray(data) || data.length < 2) continue;
        fetched++;

        const headers = data[0];
        const values = data[1];
        const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));

        const pop = parseInt(row['B01003_001E']) || 1;
        const owners = parseInt(row['B25003_002E']) || 0;
        const renters = parseInt(row['B25003_003E']) || 0;
        const housing = owners + renters || 1;

        // Upsert each neighborhood sharing this ZIP
        for (const nbhd of KC_NEIGHBORHOODS.filter(n => n.zip === zip)) {
          await pool.query(`
            INSERT INTO neighborhood_profiles
              (name, zip, population, median_income, median_age,
               owner_occupied, renter_occupied, pct_poverty, pct_college,
               pct_white, pct_black, pct_hispanic, raw_data, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
            ON CONFLICT (name) DO UPDATE SET
              population=$3, median_income=$4, median_age=$5,
              owner_occupied=$6, renter_occupied=$7, pct_poverty=$8, pct_college=$9,
              pct_white=$10, pct_black=$11, pct_hispanic=$12,
              raw_data=$13, updated_at=NOW()
          `, [
            nbhd.name, zip,
            pop,
            parseInt(row['B19013_001E']) || null,
            parseFloat(row['B01002_001E']) || null,
            Math.round(owners / housing * 100),
            Math.round(renters / housing * 100),
            Math.round(parseInt(row['B17001_002E'] || 0) / pop * 100),
            Math.round(parseInt(row['B15003_022E'] || 0) / pop * 100),
            Math.round(parseInt(row['B02001_002E'] || 0) / pop * 100),
            Math.round(parseInt(row['B02001_003E'] || 0) / pop * 100),
            Math.round(parseInt(row['B03002_012E'] || 0) / pop * 100),
            JSON.stringify(row)
          ]);
          upserted++;
        }
        await new Promise(res => setTimeout(res, 300));
      } catch (e) {
        console.warn(`[census] ZIP ${zip} error: ${e.message}`);
      }
    }

    await logDone(logId, fetched, upserted);
    console.log(`[census] Done — ${upserted} neighborhoods updated`);
    return { fetched, upserted };
  }

  // ── Foursquare ───────────────────────────────────────────────────────────
  async function collectFoursquare({ triggeredBy = 'scheduler' } = {}) {
    const apiKey = process.env.FOURSQUARE_API_KEY;
    if (!apiKey) {
      console.log('[foursquare] FOURSQUARE_API_KEY not set — skipping (free key at developer.foursquare.com)');
      return { fetched: 0, upserted: 0, skipped: true };
    }
    const logId = await logStart('foursquare', triggeredBy);
    let fetched = 0, upserted = 0;

    // Foursquare category IDs: 13000=Food, 13065=Restaurant, 13003=Bar, 17000=Retail, 13035=Coffee
    const categories = '13000,17000'; // Food (all) + Retail

    for (const nbhd of KC_NEIGHBORHOODS) {
      try {
        const url = `https://api.foursquare.com/v3/places/search?ll=${nbhd.lat},${nbhd.lng}&radius=1000&categories=${categories}&limit=50&fields=fsq_id,name,location,rating,stats,categories`;
        const r = await fetch(url, { headers: { 'Authorization': apiKey, 'Accept': 'application/json' } });
        if (!r.ok) { console.warn(`[foursquare] ${nbhd.name} returned ${r.status}`); continue; }
        const data = await r.json();
        const places = data?.results || [];
        fetched += places.length;

        for (const place of places) {
          if (!place.fsq_id) continue;
          const catName = place.categories?.[0]?.name || '';
          const businessType = detectBusinessTypes(catName)[0] || 'other';

          try {
            const ins = await pool.query(`
              INSERT INTO business_profiles
                (source, source_id, name, address, neighborhood, zip,
                 lat, lng, business_type, foursquare_id, foursquare_rating, raw_data, updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
              ON CONFLICT (source, source_id) DO UPDATE SET
                foursquare_rating = EXCLUDED.foursquare_rating,
                updated_at = NOW()
              RETURNING (xmax = 0) AS inserted
            `, [
              'foursquare', place.fsq_id,
              place.name || '',
              place.location?.formatted_address || '',
              nbhd.name,
              place.location?.postcode || nbhd.zip,
              place.geocodes?.main?.latitude || nbhd.lat,
              place.geocodes?.main?.longitude || nbhd.lng,
              businessType,
              place.fsq_id,
              place.rating || null,
              JSON.stringify({ categories: place.categories, stats: place.stats })
            ]);
            if (ins.rows[0]?.inserted) upserted++;
          } catch (e) { /* skip */ }
        }
      } catch (e) {
        console.warn(`[foursquare] ${nbhd.name} error: ${e.message}`);
      }
      await new Promise(res => setTimeout(res, 200));
    }

    await logDone(logId, fetched, upserted);
    console.log(`[foursquare] Done — fetched ${fetched}, upserted ${upserted}`);
    return { fetched, upserted };
  }

  return { collectReddit, collectGdelt, collectKcOpenData, collectCensus, collectFoursquare };
}

module.exports = { makeCollectors, KC_NEIGHBORHOODS, fetchCensusData, fetchHmdaData, fetchEJScreen, fetchKCNeighborhoodPop, fetchNeighborhoodBusinesses, fetch311Data, fetchNeighborhoodSentiment };
