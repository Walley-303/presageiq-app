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

module.exports = { makeCollectors, KC_NEIGHBORHOODS };
