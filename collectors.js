// collectors.js — PresageIQ Data Intelligence Collection Layer
// All external data sources compile here. Receives the shared pg Pool from server.js.

const crypto = require('crypto');

const kcmoHeaders = { 'X-App-Token': process.env.KCMO_APP_TOKEN || '' };

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
// No state filter — in=state:XX causes "unknown/unsupported geography hierarchy" with ZCTA queries.
async function fetchCensusData(zip) {
  if (!zip) return null;
  try {
    const url = `https://api.census.gov/data/2023/acs/acs5?get=B19013_001E,B01003_001E,B25003_002E,B17001_002E,B02001_002E,B02001_003E,B03001_003E,B15003_001E&for=zip+code+tabulation+area:${zip}`;
    console.log(`[census] GET ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    console.log(`[census] status=${res.status} zip=${zip}`);
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[census] error body: ${body.substring(0, 300)}`);
      return null;
    }
    const body = await res.text();
    console.log(`[census] body[0:500]: ${body.substring(0, 500)}`);
    const data = JSON.parse(body);
    if (!Array.isArray(data) || data.length < 2) return null;

    const headers = data[0];
    const values  = data[1];
    const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    const totalPop     = parseInt(row['B01003_001E']) || 1;
    const belowPoverty = parseInt(row['B17001_002E']) || 0;
    return {
      zip,
      medianIncome:  parseInt(row['B19013_001E']) || null,
      totalPop,
      ownerOccupied: parseInt(row['B25003_002E']) || 0,
      belowPoverty,
      povertyRate:   Math.round(belowPoverty / totalPop * 1000) / 10,
      whitePct:      Math.round(parseInt(row['B02001_002E'] || 0) / totalPop * 1000) / 10,
      blackPct:      Math.round(parseInt(row['B02001_003E'] || 0) / totalPop * 1000) / 10,
      hispanicPct:   Math.round(parseInt(row['B03001_003E'] || 0) / totalPop * 1000) / 10,
      dataYear: 2023,
    };
  } catch (e) {
    console.warn(`[census] failed: ${e.message}`);
    return null;
  }
}

// ── fetchHmdaData — CFPB HMDA mortgage lending patterns for KC metro ──────────
async function fetchHmdaData() {
  console.log('[hmda] using static 2022 KC metro reference data');
  return {
    msaCode: '28140',
    year: 2022,
    totalApplications: 28450,
    totalOriginated: 19823,
    totalDenied: 4891,
    overallDenialRate: 17.2,
    blackDenialRate: 28.4,
    whiteDenialRate: 12.1,
    hispanicDenialRate: 19.8,
    note: 'KC Metro MSA 28140 — 2022 HMDA data. Black applicants denied at 2.3x the rate of white applicants.',
    source: 'CFPB HMDA 2022 — static reference data',
  };
}

// ── fetchEJScreen — EPA environmental justice indicators for a location ────────
async function fetchEJScreen(lat, lng, zip, stateFips) {
  if (lat == null || lng == null) return null;

  // tryEndpoint catches its own network errors and returns null so the Census
  // fallback in the if(!data) block always fires when EPA is unreachable.
  const tryEndpoint = async (endpoint) => {
    try {
      const url = `https://ejscreen.epa.gov/mapper/${endpoint}?namestr=${lat},${lng}&unit=miles&distance=0.5&areatype=circle&areaid=&f=json`;
      console.log(`[ejscreen] GET ${url}`);
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      console.log(`[ejscreen] status=${res.status} endpoint=${endpoint}`);
      if (!res.ok) return null;
      const body = await res.text();
      console.log(`[ejscreen] body[0:500]: ${body.substring(0, 500)}`);
      try { return JSON.parse(body); } catch (e) { console.warn(`[ejscreen] JSON parse failed: ${e.message}`); return null; }
    } catch (e) {
      console.warn(`[ejscreen] ${endpoint} network error: ${e.message}`);
      return null;
    }
  };

  const censusFallback = async () => {
    if (!zip) return null;
    console.log(`[ejscreen] EPA blocked, using Census proxy for zip ${zip}`);
    try {
      const url = `https://api.census.gov/data/2023/acs/acs5?get=B02001_003E,B17001_002E,B01003_001E&for=zip+code+tabulation+area:${zip}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let cRes;
      try {
        cRes = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      console.log(`[ejscreen] Census proxy status=${cRes.status} zip=${zip}`);
      if (!cRes.ok) { console.warn(`[ejscreen] Census proxy status=${cRes.status}`); return null; }
      const body = await cRes.text();
      const cData = JSON.parse(body);
      if (!Array.isArray(cData) || cData.length < 2) return null;
      const headers = cData[0];
      const values  = cData[1];
      const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
      const totalPop     = parseInt(row['B01003_001E']) || 1;
      const blackPop     = parseInt(row['B02001_003E']) || 0;
      const belowPoverty = parseInt(row['B17001_002E']) || 0;
      const minorityPct  = Math.round(blackPop / totalPop * 1000) / 10;
      const lowIncomePct = Math.round(belowPoverty / totalPop * 1000) / 10;
      console.log(`[ejscreen] Census proxy success: minorityPct=${minorityPct}% lowIncomePct=${lowIncomePct}%`);
      return {
        minorityPct,
        lowIncomePct,
        linguisticIsolationPct: null,
        ejIndexNationalPct:     null,
        cancerRiskPct:          null,
        dieselPM:               null,
        trafficProximity:       null,
        leadPaintPct:           null,
        dataSource:             'census_proxy',
      };
    } catch (e) {
      console.warn(`[ejscreen] Census proxy failed: ${e.message}`);
      return null;
    }
  };

  try {
    let data = await tryEndpoint('ejscreenRESTbroker.aspx');
    if (!data) {
      console.log('[ejscreen] Primary endpoint failed, trying fallback ejscreenRESTbroker2.aspx');
      data = await tryEndpoint('ejscreenRESTbroker2.aspx');
    }
    if (!data) return await censusFallback();

    const o = data?.outputs || data?.data || data;
    if (!o || typeof o !== 'object') { console.warn('[ejscreen] No usable output object in response'); return null; }
    console.log(`[ejscreen] fields present: ${Object.keys(o).slice(0, 20).join(', ')}`);

    const g = (k) => o[k] != null ? o[k] : (o[k.toLowerCase()] != null ? o[k.toLowerCase()] : null);
    const pct   = (k, alt)  => { const v = g(k) ?? (alt ? g(alt) : null); return v != null ? Math.round(v * 1000) / 10 : null; };
    const r10   = (k, alt)  => { const v = g(k) ?? (alt ? g(alt) : null); return v != null ? Math.round(v * 10) / 10 : null; };
    const r100  = (k, alt)  => { const v = g(k) ?? (alt ? g(alt) : null); return v != null ? Math.round(v * 100) / 100 : null; };

    return {
      minorityPct:            pct('MINORPCT'),
      lowIncomePct:           pct('LOWINCPCT'),
      linguisticIsolationPct: pct('LINGISOPCT'),
      ejIndexNationalPct:     r10('EJINDEXN',  'P_EJI'),
      cancerRiskPct:          r10('CANCER',    'P_CANCER'),
      dieselPM:               r100('DSLPM',    'P_DSLPM'),
      trafficProximity:       r10('PTRAF',     'P_PTRAF'),
      leadPaintPct:           pct('PLDPNT',    'P_LDPNT'),
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
      headers: { ...kcmoHeaders, 'Accept': 'application/json' },
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

// ── Hardcoded coordinate fallbacks for neighborhoods that may not be in kc_neighborhoods ──
const NBHD_COORD_FALLBACKS = {
  'Troost Corridor': { lat: 39.0447, lng: -94.5688, radius: 1500 },
  'East Side':       { lat: 39.0900, lng: -94.5300, radius: 2000 },
  'Westside':        { lat: 39.0986, lng: -94.5900, radius: 1200 },
  '18th and Vine':   { lat: 39.0850, lng: -94.5650, radius: 800  },
  'Crossroads':      { lat: 39.0800, lng: -94.5800, radius: 1000 },
};

// Resolve coordinates for a neighborhood: exact DB → fuzzy DB → in-memory → hardcoded fallback
async function resolveNeighborhoodCoords(pool, neighborhoodName) {
  // 1. Exact match
  try {
    const r = await pool.query(
      `SELECT centroid_lat, centroid_lng, bbox_north, bbox_south, bbox_east, bbox_west
       FROM kc_neighborhoods WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [neighborhoodName]
    );
    if (r.rows.length) {
      const n = r.rows[0];
      const heightM = (n.bbox_north - n.bbox_south) * 111000;
      const widthM  = (n.bbox_east - n.bbox_west) * 111000 * Math.cos(n.centroid_lat * Math.PI / 180);
      return {
        lat:    n.centroid_lat,
        lng:    n.centroid_lng,
        radius: Math.max(300, Math.min(Math.round(Math.max(heightM, widthM) / 2), 2500)),
      };
    }
  } catch (e) {
    console.warn(`[nbhd-coords] exact lookup failed: ${e.message}`);
  }

  // 2. Fuzzy match in DB
  try {
    const r = await pool.query(
      `SELECT centroid_lat, centroid_lng, bbox_north, bbox_south, bbox_east, bbox_west
       FROM kc_neighborhoods
       WHERE LOWER(name) LIKE LOWER('%' || $1 || '%')
          OR LOWER($1) LIKE LOWER('%' || name || '%')
       LIMIT 1`,
      [neighborhoodName]
    );
    if (r.rows.length) {
      const n = r.rows[0];
      const heightM = (n.bbox_north - n.bbox_south) * 111000;
      const widthM  = (n.bbox_east - n.bbox_west) * 111000 * Math.cos(n.centroid_lat * Math.PI / 180);
      return {
        lat:    n.centroid_lat,
        lng:    n.centroid_lng,
        radius: Math.max(300, Math.min(Math.round(Math.max(heightM, widthM) / 2), 2500)),
      };
    }
  } catch (e) {
    console.warn(`[nbhd-coords] fuzzy lookup failed: ${e.message}`);
  }

  // 3. In-memory KC_NEIGHBORHOODS list
  const mem = KC_NEIGHBORHOODS.find(n => n.name.toLowerCase() === neighborhoodName.toLowerCase());
  if (mem) return { lat: mem.lat, lng: mem.lng, radius: 1609 };

  // 4. Hardcoded fallback map
  const fb = NBHD_COORD_FALLBACKS[neighborhoodName];
  if (fb) return fb;

  return null;
}

// ── fetchNeighborhoodBusinesses — Google Places nearby via neighborhood boundary ─
async function fetchNeighborhoodBusinesses(pool, neighborhoodName) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  const coords = await resolveNeighborhoodCoords(pool, neighborhoodName);

  const empty = { businesses: [], totalCount: 0, source: 'google_places', neighborhood: neighborhoodName };
  if (!coords) return empty;
  if (!apiKey) { console.warn('[businesses] GOOGLE_PLACES_API_KEY not set — skipping'); return empty; }

  const { lat, lng, radius } = coords;

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

// ── fetch311Data — Query 7at3-sxhp with neighborhood filter; fall back to no-filter then d4px-6rwg ─
async function fetch311Data(pool, neighborhoodName) {
  // Discover the exact neighborhood name used in the 311 dataset by querying by ZIP,
  // since names like "Troost Corridor" may not match the dataset's spelling exactly.
  let effectiveName = neighborhoodName;
  const nbhdDef = KC_NEIGHBORHOODS.find(n => n.name === neighborhoodName);
  if (nbhdDef?.zip) {
    try {
      const discoverUrl = `https://data.kcmo.org/resource/7at3-sxhp.json?$where=${encodeURIComponent(`zipcode='${nbhdDef.zip}'`)}&$limit=5&$order=creation_date+DESC`;
      console.log(`[311] discovering neighborhood names in zip ${nbhdDef.zip}`);
      const dRes = await fetch(discoverUrl, { headers: kcmoHeaders, signal: AbortSignal.timeout(8000) });
      if (dRes.ok) {
        const dData = await dRes.json();
        const discovered = [...new Set(dData.map(r => r.neighborhood).filter(Boolean))];
        console.log(`[311] names in zip ${nbhdDef.zip}: ${discovered.join(', ')}`);
        const firstWord = neighborhoodName.split(/\s+/)[0].toLowerCase();
        const match = discovered.find(n => n.toLowerCase().includes(firstWord) || firstWord.includes(n.toLowerCase()));
        if (match && match !== neighborhoodName) {
          console.log(`[311] using discovered name "${match}" instead of "${neighborhoodName}"`);
          effectiveName = match;
        }
      }
    } catch (e) {
      console.warn(`[311] discovery failed: ${e.message}`);
    }
  }

  const nbhdFilter = encodeURIComponent(`neighborhood='${effectiveName.replace(/'/g, "''")}'`);
  const ENDPOINTS = [
    {
      url:      `https://data.kcmo.org/resource/7at3-sxhp.json?$where=${nbhdFilter}&$limit=100&$order=creation_date+DESC`,
      getCat:   (r) => r.category || r.request_type || r.type || 'Unknown',
      filtered: true,
    },
    {
      url:      'https://data.kcmo.org/resource/7at3-sxhp.json?$limit=100&$order=creation_date+DESC',
      getCat:   (r) => r.category || r.request_type || r.type || 'Unknown',
      filtered: false,
    },
    {
      url:      'https://data.kcmo.org/resource/d4px-6rwg.json?$limit=100&$order=open_date_time+DESC',
      getCat:   (r) => r.issue_type || r.issue_sub_type || 'Unknown',
      filtered: false,
    },
  ];

  let rows = [];
  let getCat    = ENDPOINTS[0].getCat;
  let isFiltered = false;

  for (const endpoint of ENDPOINTS) {
    try {
      console.log(`[311] trying ${endpoint.url}`);
      const res = await fetch(endpoint.url, { headers: kcmoHeaders, signal: AbortSignal.timeout(10000) });
      console.log(`[311] status=${res.status}`);
      if (!res.ok) {
        const errBody = await res.text();
        console.warn(`[311] error body: ${errBody.substring(0, 300)}`);
        continue;
      }
      rows = await res.json();
      if (rows.length > 0) {
        console.log(`[311] ${rows.length} records, first record keys: ${Object.keys(rows[0]).join(', ')}`);
        getCat     = endpoint.getCat;
        isFiltered = endpoint.filtered;
        break;
      }
      console.warn(`[311] ${endpoint.url} returned 0 records, trying next endpoint`);
    } catch (e) {
      console.warn(`[311] ${endpoint.url} failed: ${e.message}`);
    }
  }

  const counts = {};
  for (const r of rows) {
    const cat = getCat(r);
    counts[cat] = (counts[cat] || 0) + 1;
  }
  const topCategories = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, count]) => ({ category, count }));
  const totalRequests = rows.length;
  const find = (keywords) => topCategories.find(r => keywords.some(k => (r.category || '').toLowerCase().includes(k)));

  return {
    totalRequests,
    topCategories,
    abandonedProperty: find(['abandon'])?.count || 0,
    streetIssues:      find(['pothole', 'street', 'road', 'sidewalk'])?.count || 0,
    codeViolations:    find(['code', 'violation'])?.count || 0,
    dataFreshness:     isFiltered ? 'neighborhood-filtered' : '100 most recent (no neighborhood filter)',
    neighborhood:      neighborhoodName,
  };
}

// ── Neighborhood Sentiment — Multi-source community signal aggregator ──────────

const QUERY_OVERRIDES = {
  'Troost Corridor': ['Troost', 'Troost Avenue Kansas City', 'Troost corridor development', 'east of Troost'],
};

async function collectRedditPosts(queries, subreddits) {
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
            source:    'reddit',
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
  return posts;
}

async function fetchGoogleNewsRSS(query, tag) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'PresageIQ/1.0' } });
    if (!r.ok) { console.warn(`[rss:${tag}] status=${r.status}`); return []; }
    const xml = await r.text();
    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
    for (const m of itemMatches) {
      const block = m[1];
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const desc  = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || block.match(/<description>(.*?)<\/description>/) || [])[1] || '';
      const link  = (block.match(/<link>(.*?)<\/link>/) || [])[1] || null;
      if (!title) continue;
      items.push({ title: title.substring(0, 150), body: desc.replace(/<[^>]+>/g, '').substring(0, 300), url: link, source: tag, sentiment: null });
      if (items.length >= 10) break;
    }
    console.log(`[rss:${tag}] ${items.length} items for query: ${query}`);
    return items;
  } catch (e) {
    console.warn(`[rss:${tag}] failed: ${e.message}`);
    return [];
  }
}

async function batchSentiment(items) {
  const withBaseline = items.map(item => ({
    ...item,
    sentiment: detectSentiment(`${item.title} ${item.body}`),
  }));

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || withBaseline.length === 0) return withBaseline;

  try {
    const numbered = withBaseline.map((item, i) => `[${i}] ${item.title}: ${item.body}`).join('\n');
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Classify each item's sentiment toward the Kansas City neighborhood as positive, negative, or neutral. Reply with only a JSON array of strings, one per item, in order. Items:\n${numbered}`,
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return withBaseline;
    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '[]';
    const labels = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!Array.isArray(labels)) return withBaseline;
    return withBaseline.map((item, i) => ({
      ...item,
      sentiment: ['positive', 'negative', 'neutral'].includes(labels[i]) ? labels[i] : item.sentiment,
    }));
  } catch (e) {
    console.warn(`[batchSentiment] failed: ${e.message}`);
    return withBaseline;
  }
}

async function fetchNeighborhoodSentiment(neighborhoodName) {
  const firstWord = neighborhoodName.split(/\s+/)[0];
  const baseQueries = QUERY_OVERRIDES[neighborhoodName] || [
    `${neighborhoodName} Kansas City`,
    `${neighborhoodName} KC neighborhood`,
    `${neighborhoodName} development`,
    `${neighborhoodName} community`,
    ...(neighborhoodName.length > 10 ? [`${firstWord} Kansas City neighborhood`] : []),
  ];

  const subreddits = ['kansascity', 'KCFoodScene', 'kansascitylocal'];

  const [
    redditPosts,
    newsItems,
    localNewsItems,
  ] = await Promise.all([
    collectRedditPosts(baseQueries, subreddits).catch(() => []),
    fetchGoogleNewsRSS(`${neighborhoodName} Kansas City`, 'news').catch(() => []),
    fetchGoogleNewsRSS(`${neighborhoodName} Kansas City neighborhood`, 'local_news').catch(() => []),
  ]);

  const rssItems = [...newsItems, ...localNewsItems];
  const scoredRSS = await batchSentiment(rssItems);

  const allPosts = [...redditPosts, ...scoredRSS];

  const counts = { positive: 0, negative: 0, neutral: 0 };
  allPosts.forEach(p => { counts[p.sentiment] = (counts[p.sentiment] || 0) + 1; });
  const overallSentiment = counts.positive > counts.negative ? 'positive'
    : counts.negative > counts.positive ? 'negative' : 'neutral';

  return {
    posts: allPosts,
    totalCount: allPosts.length,
    overallSentiment,
    signalCount: allPosts.length,
    sourceBreakdown: {
      reddit:     redditPosts.length,
      news:       newsItems.length,
      local_news: localNewsItems.length,
    },
    neighborhood: neighborhoodName,
  };
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
