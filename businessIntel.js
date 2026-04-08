// businessIntel.js — Automated Business Intelligence Gathering
// Triggered on audit submission. Gathers Google Places data, competitor
// analysis, website content, and community mentions. Synthesizes with AI.

const PLACES_BASE = 'https://places.googleapis.com/v1';
const PRICE_LABELS = {
  PRICE_LEVEL_FREE: 'Free',
  PRICE_LEVEL_INEXPENSIVE: '$ (Under $10)',
  PRICE_LEVEL_MODERATE: '$$ ($10–$20)',
  PRICE_LEVEL_EXPENSIVE: '$$$ ($20–$40)',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$ ($40+)',
};

// ── Google Places API helper ──────────────────────────────────────────────────
async function placesPost(endpoint, body, fieldMask) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not configured in Railway environment variables');
  const res = await fetch(`${PLACES_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Places API ${res.status}: ${err.error?.message || res.statusText}`);
  }
  return res.json();
}

// ── Find a business by name + neighborhood on Google Maps ─────────────────────
async function findBusiness(name, neighborhood) {
  const query = `${name} ${neighborhood || ''} Kansas City Missouri`.trim();
  const data = await placesPost(
    '/places:searchText',
    {
      textQuery: query,
      maxResultCount: 3,
      locationBias: {
        circle: {
          center: { latitude: 39.0997, longitude: -94.5786 },
          radius: 50000, // 50km max (API limit) — covers KC metro
        },
      },
    },
    // Enterprise fields (rating, reviews, priceLevel) — billed at Enterprise SKU
    'places.id,places.displayName,places.formattedAddress,places.location,' +
    'places.rating,places.userRatingCount,places.priceLevel,places.types,' +
    'places.primaryType,places.websiteUri,places.nationalPhoneNumber,' +
    'places.regularOpeningHours,places.reviews,places.photos,places.businessStatus,' +
    'places.editorialSummary,places.servesVegetarianFood,places.dineIn,' +
    'places.takeout,places.delivery,places.reservable,places.allowsDogs,' +
    'places.outdoorSeating,places.liveMusic'
  );
  return data?.places?.[0] || null;
}

// ── Find all food/drink competitors within radius ─────────────────────────────
async function findCompetitors(lat, lng, radiusMeters = 8000) {
  const data = await placesPost(
    '/places:searchNearby',
    {
      includedTypes: ['restaurant', 'bar', 'cafe', 'bakery', 'meal_takeaway',
                       'meal_delivery', 'night_club', 'food_court', 'brewery'],
      maxResultCount: 20,
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters },
      },
    },
    'places.id,places.displayName,places.formattedAddress,places.rating,' +
    'places.userRatingCount,places.priceLevel,places.primaryType,places.types,' +
    'places.websiteUri,places.reviews,places.editorialSummary'
  );
  return data?.places || [];
}

// ── Scrape website for menu / content ────────────────────────────────────────
async function scrapeWebsite(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PresageIQ-Intel/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 10000);

    // Try to find a menu link
    const menuMatch = html.match(/href="([^"]*(?:menu|food|order)[^"]*)"/i);
    const menuUrl = menuMatch ? new URL(menuMatch[1], url).href : null;

    let menuText = null;
    if (menuUrl && menuUrl !== url) {
      try {
        const mr = await fetch(menuUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PresageIQ-Intel/1.0)' },
          signal: AbortSignal.timeout(8000),
        });
        if (mr.ok) {
          const mhtml = await mr.text();
          menuText = mhtml
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 8000);
        }
      } catch (e) { /* menu page unreachable */ }
    }

    return { homeText: text, menuUrl, menuText };
  } catch (e) {
    return null;
  }
}

// ── Scrape KC local review sources for business mentions ──────────────────────
async function scrapeKCReviewSources(businessName) {
  const results = [];
  const query = encodeURIComponent(businessName);
  const stripHtml = html => html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ').trim();

  const sources = [
    { name: 'KC Magazine', url: `https://kansascitymag.com/?s=${query}` },
    { name: 'The Pitch KC', url: `https://www.thepitchkc.com/?s=${query}` },
    { name: 'KCUR Food', url: `https://www.kcur.org/search?query=${query}&secction=food` },
  ];

  for (const src of sources) {
    try {
      const res = await fetch(src.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PresageIQ-Intel/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const text = stripHtml(html);

      // Look for the business name in the page text (case-insensitive)
      const nameLower = businessName.toLowerCase();
      const textLower = text.toLowerCase();
      const idx = textLower.indexOf(nameLower);
      if (idx === -1) continue;

      // Pull up to 3 snippets (150 chars around each mention)
      const snippets = [];
      let searchFrom = 0;
      while (snippets.length < 3) {
        const pos = textLower.indexOf(nameLower, searchFrom);
        if (pos === -1) break;
        const start = Math.max(0, pos - 80);
        const end = Math.min(text.length, pos + 160);
        snippets.push('...' + text.substring(start, end).trim() + '...');
        searchFrom = pos + nameLower.length;
      }

      if (snippets.length > 0) {
        results.push({ source: src.name, url: src.url, snippets });
      }
    } catch (e) { /* non-fatal — skip source */ }
  }

  return results;
}

// ── Analyze Google Maps photos with GPT-4o-mini vision ───────────────────────
async function analyzePhotos(photos, openaiKey) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !openaiKey || !photos?.length) return null;

  // Fetch all available photos (Places API returns up to 10) — more photos = better demand signals
  const toFetch = photos.slice(0, 10);
  const imageMessages = [];
  for (const photo of toFetch) {
    try {
      const photoUrl = `${PLACES_BASE}/${photo.name}/media?maxHeightPx=600&maxWidthPx=800&key=${apiKey}&skipHttpRedirect=false`;
      const imgRes = await fetch(photoUrl, { signal: AbortSignal.timeout(10000) });
      if (!imgRes.ok) continue;
      const buffer = await imgRes.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const mime = imgRes.headers.get('content-type') || 'image/jpeg';
      imageMessages.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
    } catch(e) { /* skip failed photo */ }
  }
  if (!imageMessages.length) return null;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `These are Google Maps photos for a restaurant/bar/food business. Analyze every photo and identify ALL food and drink items you can see. Then output ONLY a JSON array like this (no extra text):
[
  {"item": "Smash Burger", "photos": 3, "notes": "appears as featured item, plated prominently"},
  {"item": "Old Fashioned cocktail", "photos": 2, "notes": "customer photo, bar setting"},
  {"item": "Brussels sprouts appetizer", "photos": 1, "notes": "table shot"}
]
If a photo shows the interior, exterior, or people only (no food/drinks), skip it. Focus on what's being photographed most — these are demand signals.`
          },
          ...imageMessages,
        ],
      }],
    }),
  });
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch(e) { return null; }
}

// ── Extract structured menu items from website + review text ──────────────────
async function extractMenuItems(menuText, homeText, reviewText, businessName, openaiKey) {
  if (!openaiKey) return null;
  const menuSource = menuText || homeText || '';
  if (!menuSource && !reviewText) return null;

  const prompt = `Extract every menu item you can identify from the content below for "${businessName}".
Output ONLY a JSON array (no extra text):
[
  {"name": "Wagyu Smash Burger", "price": "$18", "description": "double smash patty, american cheese, house sauce", "source": "menu"},
  {"name": "Nashville Hot Chicken Sandwich", "price": "$16", "description": "crispy chicken, spicy glaze, pickle slaw", "source": "menu"},
  {"name": "Truffle Fries", "price": null, "description": "mentioned in reviews as a favorite", "source": "review"}
]
Rules:
- "source" is "menu" if from the website/menu text, "review" if only mentioned in reviews
- Include price if visible, null if not
- Include description if available, null if not
- Do NOT invent items — only include what you can actually see in the text below
- If no items found, return []

WEBSITE/MENU TEXT:
${menuSource.substring(0, 4000)}

REVIEW MENTIONS:
${(reviewText || '').substring(0, 1500)}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1200,
      messages: [
        { role: 'system', content: 'You are a menu extraction assistant. Output only valid JSON arrays. Never add commentary outside the JSON.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch(e) { return []; }
}

// ── Search stored community intel for business mentions ───────────────────────
async function getCommunityMentions(pool, businessName) {
  const pattern = `%${businessName.replace(/'/g, "''").substring(0, 50)}%`;
  const res = await pool.query(`
    SELECT source, title, body, url, score, sentiment, post_date
    FROM community_intel
    WHERE title ILIKE $1 OR body ILIKE $1
    ORDER BY score DESC, collected_at DESC
    LIMIT 25
  `, [pattern]);
  return res.rows;
}

// ── Format helpers ────────────────────────────────────────────────────────────
function formatPrice(priceLevel) {
  return PRICE_LABELS[priceLevel] || 'Unknown';
}

function formatType(types = []) {
  const clean = types
    .filter(t => !['point_of_interest', 'establishment', 'food', 'locality', 'political'].includes(t))
    .map(t => t.replace(/_/g, ' '))
    .slice(0, 3);
  return clean.join(', ') || 'Restaurant';
}

function formatReviews(reviews = []) {
  return reviews.map(r => ({
    author: r.authorAttribution?.displayName || 'Anonymous',
    rating: r.rating,
    text: r.text?.text || '',
    time: r.relativePublishTimeDescription || '',
  }));
}

// ── Main orchestrator ─────────────────────────────────────────────────────────
async function gatherBusinessIntel(pool, clientId, businessName, neighborhood) {
  console.log(`[intel] Starting gather for client ${clientId}: "${businessName}" in ${neighborhood}`);

  // Upsert the intel record to 'gathering' status
  await pool.query(`
    INSERT INTO business_intel (client_id, business_name, status)
    VALUES ($1, $2, 'gathering')
    ON CONFLICT (client_id) DO UPDATE SET
      business_name=$2, status='gathering', error_message=NULL, gathered_at=NOW()
  `, [clientId, businessName]);

  try {
    // ── 1. Find on Google Maps ──────────────────────────────────────────────
    const place = await findBusiness(businessName, neighborhood);
    if (!place) {
      await pool.query(`UPDATE business_intel SET status='error', error_message=$1 WHERE client_id=$2`,
        [`Could not locate "${businessName}" on Google Maps. Confirm business name and neighborhood are correct.`, clientId]);
      return;
    }
    console.log(`[intel] Found: ${place.displayName?.text} (${place.id})`);

    const lat = place.location?.latitude;
    const lng = place.location?.longitude;

    // ── 2. Find competitors ─────────────────────────────────────────────────
    let competitors = [];
    try {
      competitors = await findCompetitors(lat, lng, 8047); // ~5 miles
    } catch (e) {
      console.warn(`[intel] Competitor search failed: ${e.message}`);
    }

    // ── 3. Scrape website ───────────────────────────────────────────────────
    let websiteData = null;
    if (place.websiteUri) {
      websiteData = await scrapeWebsite(place.websiteUri);
    }

    // ── 4. Community mentions + KC review sources (parallel) ───────────────
    let communityMentions = [];
    let kcReviews = [];
    try {
      [communityMentions, kcReviews] = await Promise.all([
        getCommunityMentions(pool, businessName).catch(() => []),
        scrapeKCReviewSources(businessName).catch(() => []),
      ]);
      if (kcReviews.length) console.log(`[intel] KC review sources: found mentions in ${kcReviews.length} source(s)`);
    } catch (e) { /* non-fatal */ }

    // ── 5. Photo analysis + menu extraction (parallel) ──────────────────────
    const openaiKey = process.env.OPENAI_API_KEY;
    const reviewText = (place.reviews || []).map(r => r.text?.text || '').join('\n\n');
    let photoSubjects = null;
    let menuItems = null;
    try {
      [photoSubjects, menuItems] = await Promise.all([
        analyzePhotos(place.photos || [], openaiKey),
        extractMenuItems(
          websiteData?.menuText || null,
          websiteData?.homeText || null,
          reviewText,
          businessName,
          openaiKey
        ),
      ]);
      console.log(`[intel] Photos analyzed: ${photoSubjects?.length || 0} items | Menu items extracted: ${menuItems?.length || 0}`);
    } catch(e) {
      console.warn(`[intel] Photo/menu extraction failed: ${e.message}`);
    }

    // ── 6. Store raw data ───────────────────────────────────────────────────
    await pool.query(`
      UPDATE business_intel SET
        place_id=$1, place_data=$2, competitors=$3,
        website_data=$4, community_mentions=$5,
        ai_photo_subjects=$6, ai_menu_items=$7,
        status='synthesizing'
      WHERE client_id=$8
    `, [
      place.id,
      JSON.stringify(place),
      JSON.stringify(competitors),
      JSON.stringify(websiteData),
      JSON.stringify(communityMentions),
      photoSubjects ? JSON.stringify(photoSubjects) : null,
      menuItems ? JSON.stringify(menuItems) : null,
      clientId,
    ]);

    // ── 7. AI synthesis ─────────────────────────────────────────────────────
    await synthesizeIntel(pool, clientId, place, competitors, websiteData, communityMentions, businessName, photoSubjects, menuItems, kcReviews);

  } catch (e) {
    console.error(`[intel] Gather failed for client ${clientId}:`, e.message);
    await pool.query(`UPDATE business_intel SET status='error', error_message=$1 WHERE client_id=$2`,
      [e.message, clientId]);
  }
}

// ── AI Synthesis ──────────────────────────────────────────────────────────────
async function synthesizeIntel(pool, clientId, place, competitors, websiteData, communityMentions, businessName, photoSubjects, menuItems, kcReviews = []) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    await pool.query(`UPDATE business_intel SET status='error', error_message=$1 WHERE client_id=$2`,
      ['OPENAI_API_KEY not configured — cannot synthesize intelligence', clientId]);
    return;
  }

  const callAI = async (systemPrompt, userPrompt, maxTokens = 1000) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  };

  const reviews = formatReviews(place.reviews || []);
  const reviewText = reviews.map(r => `[${r.rating}★ · ${r.time}] ${r.author}: "${r.text}"`).join('\n\n');
  const competitorSummary = competitors
    .filter(c => c.id !== place.id)
    .slice(0, 15)
    .map(c => `- ${c.displayName?.text || 'Unknown'} | ${c.rating || '?'}★ (${c.userRatingCount || 0} reviews) | ${formatPrice(c.priceLevel)} | ${formatType(c.types)}`)
    .join('\n');
  const communityText = communityMentions.length > 0
    ? communityMentions.map(m => `[${m.source} · ${m.sentiment}] ${m.title}: ${(m.body || '').substring(0, 200)}`).join('\n\n')
    : 'No community mentions found in database yet.';

  const kcReviewText = kcReviews.length > 0
    ? kcReviews.map(r =>
        `[${r.source}]\n` + r.snippets.join('\n')
      ).join('\n\n')
    : 'No mentions found in KC Magazine, The Pitch KC, or KCUR.';
  const menuContext = websiteData?.menuText
    ? `MENU PAGE:\n${websiteData.menuText.substring(0, 3000)}`
    : websiteData?.homeText
    ? `WEBSITE CONTENT:\n${websiteData.homeText.substring(0, 2000)}`
    : 'No website accessible.';

  const photoContext = photoSubjects?.length
    ? `PHOTO ANALYSIS (what customers are actually photographing):\n` +
      photoSubjects.map(p => `- "${p.item}" appears in ${p.photos} photo(s)${p.notes ? ` — ${p.notes}` : ''}`).join('\n')
    : 'Photo analysis: not available or no food items identified in photos.';

  const menuItemsContext = menuItems?.length
    ? `EXTRACTED MENU ITEMS (${menuItems.length} items from website/reviews):\n` +
      menuItems.map(m => `- ${m.name}${m.price ? ` (${m.price})` : ''}${m.description ? `: ${m.description}` : ''} [source: ${m.source}]`).join('\n')
    : 'Menu extraction: no structured items found.';

  const businessContext = `
BUSINESS: ${place.displayName?.text || businessName}
ADDRESS: ${place.formattedAddress || 'Unknown'}
RATING: ${place.rating || 'N/A'}★ (${place.userRatingCount || 0} reviews)
PRICE: ${formatPrice(place.priceLevel)}
CATEGORY: ${formatType(place.types)}
PHONE: ${place.nationalPhoneNumber || 'N/A'}
WEBSITE: ${place.websiteUri || 'None'}
STATUS: ${place.businessStatus || 'Unknown'}
OVERVIEW: ${place.editorialSummary?.text || 'None provided by Google'}
ATTRIBUTES: Dine-in: ${place.dineIn ? 'Yes' : 'No'} | Takeout: ${place.takeout ? 'Yes' : 'No'} | Delivery: ${place.delivery ? 'Yes' : 'No'} | Reservations: ${place.reservable ? 'Yes' : 'No'} | Outdoor seating: ${place.outdoorSeating ? 'Yes' : 'No'} | Live music: ${place.liveMusic ? 'Yes' : 'No'}
PHOTOS: ${(place.photos || []).length} photos on Google Maps
`.trim();

  // Synthesis 1: Business Profile + Review Analysis
  const profileSummary = await callAI(
    `You are PresageIQ building a business intelligence dossier for an existing KC restaurant/business. Be direct and specific. This is internal analysis for our consulting team, not a public document.`,
    `${businessContext}

GOOGLE REVIEWS (${reviews.length} available):
${reviewText || 'No reviews returned by API.'}

${menuContext}

${menuItemsContext}

${photoContext}

COMMUNITY MENTIONS (Reddit/News from collected database):
${communityText}

KC LOCAL PRESS COVERAGE (KC Magazine, The Pitch KC, KCUR):
${kcReviewText}

Generate a structured business intelligence report. Use ** for section headers.

**BUSINESS SNAPSHOT**
One paragraph covering: what kind of place this is, price point, vibe, and who their customer appears to be based on all available data.

**REVIEW SENTIMENT BREAKDOWN**
What are customers consistently praising? What are they consistently complaining about? What specific items, experiences, or service failures come up repeatedly? Be specific — pull actual patterns from the reviews.

**STRONGEST ASSETS**
The 2-3 things this business genuinely does well based on review evidence.

**CLEAREST VULNERABILITIES**
The 2-3 most consistent problems or complaints. Be honest and direct.

**MENU/OFFERING INTELLIGENCE**
Cross-reference what's on their menu (from website), what customers mention in reviews, and what appears most in customer photos. Flag any item that is frequently photographed but not prominently featured/marketed. Flag items praised in reviews that aren't clearly on the menu. Flag items on the menu that get no photo or review attention.

**PHOTO DEMAND SIGNALS**
Based on the photo analysis, what are customers most drawn to photographing? What does this tell us about what's resonating vs. what isn't being captured? Are there items that should be featured more prominently in their marketing?

**OPERATIONAL FLAGS**
Any patterns in reviews suggesting operational issues (consistency, wait times, staff, management)?`,
    1200
  );

  // Synthesis 2: Competitor Gap Analysis
  const competitorAnalysis = await callAI(
    `You are PresageIQ conducting a competitive landscape analysis for KC food & beverage consulting. Be specific and actionable. This analysis informs recommendations to the client.`,
    `TARGET BUSINESS:
${businessContext}
Rating: ${place.rating}★ | Price: ${formatPrice(place.priceLevel)}

COMPETITORS WITHIN 5 MILES (${competitors.length} found):
${competitorSummary}

TARGET'S TOP REVIEWS (context):
${reviewText.substring(0, 1500) || 'Limited review data.'}

Analyze the competitive landscape. Use ** for section headers.

**COMPETITIVE POSITION**
How does ${place.displayName?.text || businessName} stack up against the field? Where do they rank on rating? Are they priced right relative to competitors? Are they in a crowded segment or a thinner field?

**WHAT COMPETITORS ARE WINNING ON**
Looking at higher-rated competitors nearby — what patterns explain their success? What are they doing that ${place.displayName?.text || businessName} is not?

**GAPS IN THE MARKET**
What isn't any competitor doing well within 5 miles? What customer need is underserved? What price point or concept is missing?

**STEAL THIS**
One specific thing a top-rated competitor is winning on that ${place.displayName?.text || businessName} could adapt and make their own.

**VULNERABILITY TO EXPLOIT**
Based on competitor weaknesses in reviews, what is ${place.displayName?.text || businessName}'s best competitive angle — what can they own that competitors can't?

**POSITIONING RECOMMENDATION**
In one sentence: how should ${place.displayName?.text || businessName} position against this competitive set?`,
    1000
  );

  // Store synthesized results
  await pool.query(`
    UPDATE business_intel SET
      ai_profile=$1, ai_competitors=$2, status='complete', gathered_at=NOW()
    WHERE client_id=$3
  `, [profileSummary, competitorAnalysis, clientId]);

  console.log(`[intel] Complete for client ${clientId}`);
}

// ── Extract menu items from an uploaded image (vision AI) ─────────────────────
async function extractMenuFromImage(imageBase64, mimeType, label) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error('OPENAI_API_KEY not configured');

  const menuTypeContext = label && label !== 'Menu'
    ? `This is specifically the "${label}" menu (e.g. happy hour, brunch, holiday special).`
    : 'This is the main menu.';

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Extract every menu item you can read from this menu image. ${menuTypeContext}
Output ONLY a valid JSON array. No commentary before or after. Format:
[
  {"name": "Wagyu Smash Burger", "price": "$18", "description": "double smash patty, american cheese, house sauce", "category": "Burgers", "menu_type": "${label || 'Menu'}"},
  {"name": "Old Fashioned", "price": "$14", "description": null, "category": "Cocktails", "menu_type": "${label || 'Menu'}"}
]
Rules:
- Include every item you can read, even partially
- category = the section header it appears under (Starters, Entrees, Cocktails, etc.)
- price = exact price as shown, null if not readable
- description = item description if present, null if not
- If the image is unreadable or not a menu, return []`
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ]
      }]
    })
  });
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '[]';
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch(e) { return []; }
}

module.exports = { gatherBusinessIntel, extractMenuFromImage };
