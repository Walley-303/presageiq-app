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

    // ── 4. Community mentions + web search + social intel (parallel) ──────────
    let communityMentions = [];
    let webSearchResults = [];
    let instagramData = null;
    let tiktokData = null;
    let youtubeData = null;
    try {
      [communityMentions, webSearchResults, instagramData, tiktokData, youtubeData] = await Promise.all([
        getCommunityMentions(pool, businessName).catch(() => []),
        searchAndScrapeWeb(businessName, neighborhood).catch(() => []),
        scrapeInstagram(businessName).catch(() => ({ handle: null, bio: null, recentPosts: [], overallSentiment: 'unknown', hashtags: [], engagementRate: null, postingConsistency: 'unknown', followerQuality: 'unknown' })),
        scrapeTikTok(businessName, neighborhood).catch(() => ({ videos: [], overallSentiment: 'unknown', signalStrength: 'none' })),
        searchYouTube(businessName, neighborhood).catch(() => ({ videos: [], overallSentiment: 'unknown' })),
      ]);
      if (webSearchResults.length) console.log(`[intel] Web search: found ${webSearchResults.length} result(s)`);
      if (instagramData?.handle) console.log(`[intel] Instagram: ${instagramData.handle}`);
      if (tiktokData?.videos?.length) console.log(`[intel] TikTok: ${tiktokData.videos.length} result(s)`);
      if (youtubeData?.videos?.length) console.log(`[intel] YouTube: ${youtubeData.videos.length} video(s)`);
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
        social_intel=$8,
        status='synthesizing'
      WHERE client_id=$9
    `, [
      place.id,
      JSON.stringify(place),
      JSON.stringify(competitors),
      JSON.stringify(websiteData),
      JSON.stringify(communityMentions),
      photoSubjects ? JSON.stringify(photoSubjects) : null,
      menuItems ? JSON.stringify(menuItems) : null,
      JSON.stringify({ instagram: instagramData, tiktok: tiktokData, youtube: youtubeData }),
      clientId,
    ]);

    // ── 7. AI synthesis ─────────────────────────────────────────────────────
    await synthesizeIntel(pool, clientId, place, competitors, websiteData, communityMentions, businessName, photoSubjects, menuItems, webSearchResults, instagramData, tiktokData, youtubeData);

  } catch (e) {
    console.error(`[intel] Gather failed for client ${clientId}:`, e.message);
    await pool.query(`UPDATE business_intel SET status='error', error_message=$1 WHERE client_id=$2`,
      [e.message, clientId]);
  }
}

// ── AI Synthesis ──────────────────────────────────────────────────────────────
async function synthesizeIntel(pool, clientId, place, competitors, websiteData, communityMentions, businessName, photoSubjects, menuItems, webSearchResults = [], instagramData = null, tiktokData = null, youtubeData = null) {
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

  const webSearchText = webSearchResults.length > 0
    ? webSearchResults.map(r =>
        r.snippets
          ? `[${r.source}]\n` + r.snippets.join('\n')
          : `[${r.source} · ${r.relevance || 'medium'}] ${r.snippet || ''}`
      ).join('\n\n')
    : 'No mentions found in web search or KC press sources.';

  const instagramContext = instagramData?.handle
    ? `INSTAGRAM:\nHandle: ${instagramData.handle}\nBio: ${instagramData.bio || 'N/A'}\nEngagement Rate: ${instagramData.engagementRate || 'N/A'} | Follower Quality: ${instagramData.followerQuality || 'unknown'} | Posting: ${instagramData.postingConsistency || 'unknown'}\nTop Hashtags: ${instagramData.hashtags?.length ? instagramData.hashtags.join(', ') : 'none detected'}\nRecent Posts (${instagramData.recentPosts.length}):\n` +
      instagramData.recentPosts.slice(0, 8).map(p =>
        `- "${(p.caption || '').substring(0, 120)}" [${p.sentiment || 'neutral'}]${p.engagement ? ` (${p.engagement.likes} likes, ${p.engagement.comments} comments)` : ''}`
      ).join('\n') +
      `\nOverall Instagram Sentiment: ${instagramData.overallSentiment || 'unknown'}`
    : 'Instagram: no public profile found or not accessible.';

  const tiktokContext = tiktokData?.videos?.length
    ? `TIKTOK (${tiktokData.videos.length} public result(s), signal: ${tiktokData.signalStrength}):\n` +
      tiktokData.videos.slice(0, 6).map(v =>
        `- ${v.creator || 'unknown'}: "${v.title}" — ${v.description.substring(0, 150)} [${v.sentiment}]`
      ).join('\n') +
      `\nOverall TikTok Sentiment: ${tiktokData.overallSentiment}`
    : 'TikTok: no public content found for this business.';

  const youtubeContext = youtubeData?.videos?.length
    ? `YOUTUBE (${youtubeData.videos.length} video(s)):\n` +
      youtubeData.videos.slice(0, 5).map(v =>
        `- "${v.title}" by ${v.channel}${v.views != null ? ` (${v.views.toLocaleString()} views)` : ''} [${v.sentiment}]\n  ${v.description.substring(0, 150)}`
      ).join('\n') +
      `\nOverall YouTube Sentiment: ${youtubeData.overallSentiment}`
    : 'YouTube: no videos found for this business.';

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
    `You are PresageIQ building a business intelligence dossier for an existing KC restaurant/business. This is internal analysis for our consulting team, not a public document.\n\nANALYSIS REQUIREMENTS — apply without exception to every section:\n- Lead with the most significant finding — never open a section with background context or setup\n- Every claim must cite a specific data point: the exact star rating, a named competitor, a specific menu item, a quoted review phrase, or a documented press mention\n- Be specific to this business in this neighborhood — never produce statements that could apply to any restaurant\n- Identify at least one non-obvious insight the business owner would not already know\n- Flag contradictions between data sources: where overall ratings conflict with complaint volume, where community mentions conflict with press coverage, where photographed items don't appear on the menu\n- End every section with one specific, actionable recommendation tied directly to the cited data\n- Write in direct, professional language — eliminate hedging: never use "it appears", "it seems", "may indicate", "could suggest", "it's possible"\n- Minimum 150 words per section, maximum 300 words`,
    `${businessContext}

GOOGLE REVIEWS (${reviews.length} available):
${reviewText || 'No reviews returned by API.'}

${menuContext}

${menuItemsContext}

${photoContext}

COMMUNITY MENTIONS (Reddit/News from collected database):
${communityText}

WEB SEARCH & KC PRESS COVERAGE:
${webSearchText}

${instagramContext}

${tiktokContext}

${youtubeContext}

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
    `You are PresageIQ conducting a competitive landscape analysis for KC food & beverage consulting. This analysis informs direct recommendations to the client.\n\nANALYSIS REQUIREMENTS — apply without exception:\n- Name every competitor specifically — no references to "a nearby competitor" or "other businesses"\n- Lead each section with the most significant finding, not setup or context\n- Every competitive claim must cite a specific data point: an exact rating, a review count, a price tier difference, a named business\n- Identify at least one non-obvious competitive insight the client could not get from walking the neighborhood\n- Flag contradictions: high-rated competitors with exploitable complaint patterns; gaps that review data suggests but no business fills\n- End every section with one specific, actionable recommendation the client can execute this month\n- Write in direct, professional language — eliminate: "it appears", "it seems", "may indicate", "could suggest"\n- Minimum 150 words per section, maximum 300 words`,
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

// ── Google Custom Search Agent for press/source discovery ────────────────────
// Requires GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX env vars (set in Railway).
// Falls back to the fixed KC site scraper if not configured.
async function searchAndScrapeWeb(businessName, neighborhood) {
  const searchKey = process.env.GOOGLE_SEARCH_API_KEY;
  const searchCx  = process.env.GOOGLE_SEARCH_CX;

  if (!searchKey || !searchCx) {
    console.log('[intel] Google Custom Search not configured — falling back to fixed KC scrapers');
    return scrapeKCReviewSources(businessName);
  }

  const queries = [
    `${businessName} ${neighborhood || ''} Kansas City`.trim(),
    `${businessName} Kansas City review`,
  ];

  const skipDomains = [
    'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'tiktok.com',
    'linkedin.com', 'youtube.com', 'yelp.com', 'tripadvisor.com',
  ];
  const skipExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];

  const seenUrls = new Set();
  const allResults = [];

  for (const q of queries) {
    try {
      const params = new URLSearchParams({
        key: searchKey, cx: searchCx,
        q, num: '5',
      });
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { console.warn(`[intel] Google Search API ${res.status}`); continue; }
      const data = await res.json();
      const items = data.items || [];

      for (const item of items) {
        const url = item.link;
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);

        // Skip auth-walled social media, PDFs, and already-known fixed sources
        const domain = new URL(url).hostname.replace(/^www\./, '');
        if (skipDomains.some(d => domain.includes(d))) continue;
        if (skipExtensions.some(ext => url.toLowerCase().endsWith(ext))) continue;

        // Fetch and extract relevant text
        try {
          const pageRes = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PresageIQ-Intel/1.0)' },
            signal: AbortSignal.timeout(8000),
          });
          if (!pageRes.ok) continue;
          const contentType = pageRes.headers.get('content-type') || '';
          if (!contentType.includes('text/html')) continue;

          const html = await pageRes.text();
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
            .replace(/\s+/g, ' ').trim();

          const nameLower = businessName.toLowerCase();
          const textLower = text.toLowerCase();
          const idx = textLower.indexOf(nameLower);
          if (idx === -1) continue;

          // Extract snippet around the mention
          const start = Math.max(0, idx - 100);
          const end = Math.min(text.length, idx + 200);
          const snippet = '...' + text.substring(start, end).trim() + '...';

          // Simple relevance: count mentions
          let mentions = 0;
          let searchFrom = 0;
          while (searchFrom < textLower.length) {
            const pos = textLower.indexOf(nameLower, searchFrom);
            if (pos === -1) break;
            mentions++;
            searchFrom = pos + nameLower.length;
          }

          allResults.push({
            source: item.displayLink || domain,
            url,
            snippet,
            relevance: mentions > 3 ? 'high' : mentions > 1 ? 'medium' : 'low',
          });
        } catch (e) { /* page fetch failed — skip */ }
      }
    } catch (e) { console.warn(`[intel] Search query failed: ${e.message}`); }
  }

  // Also run the fixed KC scrapers and merge (dedup by URL)
  const fixedResults = await scrapeKCReviewSources(businessName).catch(() => []);
  for (const fr of fixedResults) {
    if (!seenUrls.has(fr.url)) {
      allResults.push({
        source: fr.source,
        url: fr.url,
        snippet: fr.snippets?.[0] || '',
        relevance: 'medium',
      });
    }
  }

  console.log(`[intel] Web search found ${allResults.length} result(s) for "${businessName}"`);
  return allResults;
}

// ── TikTok public content discovery via Google Custom Search ─────────────────
// Uses site:tiktok.com filter — no TikTok auth required, no fake accounts.
async function scrapeTikTok(businessName, neighborhood) {
  const result = { videos: [], overallSentiment: 'unknown', signalStrength: 'none' };
  const searchKey = process.env.GOOGLE_SEARCH_API_KEY;
  const searchCx  = process.env.GOOGLE_SEARCH_CX;
  if (!searchKey || !searchCx) return result;

  try {
    const params = new URLSearchParams({
      key: searchKey, cx: searchCx,
      q: `"${businessName}" ${neighborhood || 'Kansas City'} site:tiktok.com`,
      num: '10',
    });
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return result;
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) return result;

    result.signalStrength = items.length >= 5 ? 'strong' : items.length >= 2 ? 'moderate' : 'weak';
    result.videos = items.map(item => ({
      title: item.title || '',
      description: (item.snippet || '').substring(0, 300),
      creator: (() => {
        const m = (item.link || '').match(/tiktok\.com\/@([^/?#]+)/);
        return m ? '@' + m[1] : null;
      })(),
      url: item.link || '',
      views: null, // not available via CSE
      sentiment: 'neutral',
    }));

    // Sentiment analysis on video descriptions
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && result.videos.length > 0) {
      try {
        const snippets = result.videos.map((v, i) => `${i+1}. ${v.title} — ${v.description}`).join('\n');
        const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini', max_tokens: 300,
            messages: [{
              role: 'user',
              content: `Analyze the sentiment of each TikTok result below for a business called "${businessName}". Output ONLY JSON: {"videos": [{"index": 1, "sentiment": "positive"}, ...], "overall": "positive"}. Sentiments: positive, neutral, negative.\n\nResults:\n${snippets}`,
            }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        const aiData = await aiRes.json();
        const raw = aiData.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          result.overallSentiment = parsed.overall || 'neutral';
          (parsed.videos || []).forEach(v => {
            if (result.videos[v.index - 1]) result.videos[v.index - 1].sentiment = v.sentiment;
          });
        }
      } catch (e) { /* sentiment optional */ }
    }
  } catch (e) {
    console.warn(`[intel] TikTok search failed: ${e.message}`);
  }

  console.log(`[intel] TikTok: ${result.videos.length} result(s), signal: ${result.signalStrength}, sentiment: ${result.overallSentiment}`);
  return result;
}

// ── YouTube Data API v3 search ────────────────────────────────────────────────
// Requires YouTube Data API v3 enabled in GCP for the same API key.
async function searchYouTube(businessName, neighborhood) {
  const result = { videos: [], overallSentiment: 'unknown' };
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  if (!apiKey) return result;

  try {
    // Step 1: Search for videos
    const searchParams = new URLSearchParams({
      key: apiKey,
      q: `"${businessName}" ${neighborhood || 'Kansas City'}`,
      part: 'snippet',
      type: 'video',
      maxResults: '8',
      relevanceLanguage: 'en',
      regionCode: 'US',
    });
    const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!searchRes.ok) {
      const errBody = await searchRes.json().catch(() => ({}));
      console.warn(`[intel] YouTube search ${searchRes.status}: ${errBody.error?.message || searchRes.statusText}`);
      return result;
    }
    const searchData = await searchRes.json();
    const items = searchData.items || [];
    if (!items.length) return result;

    // Step 2: Fetch view counts for each video
    const videoIds = items.map(i => i.id?.videoId).filter(Boolean);
    let statsMap = {};
    if (videoIds.length) {
      const statsParams = new URLSearchParams({
        key: apiKey,
        id: videoIds.join(','),
        part: 'statistics',
      });
      const statsRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?${statsParams}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        (statsData.items || []).forEach(v => {
          statsMap[v.id] = parseInt(v.statistics?.viewCount || '0', 10);
        });
      }
    }

    result.videos = items
      .filter(i => i.id?.videoId)
      .map(i => ({
        title: i.snippet?.title || '',
        description: (i.snippet?.description || '').substring(0, 300),
        channel: i.snippet?.channelTitle || '',
        date: i.snippet?.publishedAt ? i.snippet.publishedAt.substring(0, 10) : null,
        views: statsMap[i.id.videoId] || null,
        url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
        sentiment: 'neutral',
      }));

    // Sentiment analysis on titles + descriptions
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && result.videos.length > 0) {
      try {
        const snippets = result.videos.map((v, i) => `${i+1}. ${v.title} — ${v.description}`).join('\n');
        const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini', max_tokens: 300,
            messages: [{
              role: 'user',
              content: `Analyze the sentiment of each YouTube video below about a business called "${businessName}". Output ONLY JSON: {"videos": [{"index": 1, "sentiment": "positive"}, ...], "overall": "positive"}. Sentiments: positive, neutral, negative.\n\nVideos:\n${snippets}`,
            }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        const aiData = await aiRes.json();
        const raw = aiData.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          result.overallSentiment = parsed.overall || 'neutral';
          (parsed.videos || []).forEach(v => {
            if (result.videos[v.index - 1]) result.videos[v.index - 1].sentiment = v.sentiment;
          });
        }
      } catch (e) { /* sentiment optional */ }
    }
  } catch (e) {
    console.warn(`[intel] YouTube search failed: ${e.message}`);
  }

  console.log(`[intel] YouTube: ${result.videos.length} video(s), sentiment: ${result.overallSentiment}`);
  return result;
}

// ── Instagram public page scraping ──────────────────────────────────────────
// Searches for the business Instagram via Google, fetches public page, extracts
// bio, recent post captions, engagement metrics, and posting patterns.
// No auth required for public profiles.
async function scrapeInstagram(businessName) {
  const result = {
    handle: null, bio: null, recentPosts: [], overallSentiment: 'unknown',
    hashtags: [], engagementRate: null, postingConsistency: 'unknown', followerQuality: 'unknown',
  };

  // Step 1: Find Instagram handle via Google search
  const searchKey = process.env.GOOGLE_SEARCH_API_KEY;
  const searchCx  = process.env.GOOGLE_SEARCH_CX;
  let profileUrl = null;

  if (searchKey && searchCx) {
    try {
      const params = new URLSearchParams({
        key: searchKey, cx: searchCx,
        q: `${businessName} Kansas City instagram site:instagram.com`, num: '3',
      });
      const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        const igItem = (data.items || []).find(i =>
          i.link && i.link.includes('instagram.com/') && !i.link.includes('/p/') && !i.link.includes('/reel/')
        );
        if (igItem) profileUrl = igItem.link;
      }
    } catch (e) { console.warn(`[intel] Instagram search failed: ${e.message}`); }
  }

  if (!profileUrl) {
    console.log(`[intel] Could not find Instagram for "${businessName}" — skipping`);
    return result;
  }

  // Extract handle from URL
  const handleMatch = profileUrl.match(/instagram\.com\/([^/?#]+)/);
  result.handle = handleMatch ? '@' + handleMatch[1] : null;

  // Step 2: Fetch public Instagram page
  try {
    const res = await fetch(profileUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { console.warn(`[intel] Instagram page fetch ${res.status}`); return result; }
    const html = await res.text();

    // Try to extract bio from meta description
    const metaDesc = html.match(/<meta\s+(?:name|property)="(?:description|og:description)"\s+content="([^"]+)"/i);
    if (metaDesc) {
      result.bio = metaDesc[1]
        .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '')
        .trim();
    }

    // Try to extract shared data JSON (public profiles sometimes embed this)
    const sharedData = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (sharedData) {
      try {
        const parsed = JSON.parse(sharedData[1]);
        const user = parsed?.entry_data?.ProfilePage?.[0]?.graphql?.user;
        if (user) {
          result.bio = user.biography || result.bio;
          result.handle = '@' + user.username;
          const followerCount = user.edge_followed_by?.count || 0;
          const edges = user.edge_owner_to_timeline_media?.edges || [];
          result.recentPosts = edges.slice(0, 24).map(e => ({
            caption: e.node?.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            timestamp: e.node?.taken_at_timestamp || null,
            engagement: {
              likes: e.node?.edge_liked_by?.count || 0,
              comments: e.node?.edge_media_to_comment?.count || 0,
            },
            sentiment: 'neutral',
          }));

          // Top 5 hashtags by frequency
          const tagCounts = {};
          result.recentPosts.forEach(p => {
            const tags = (p.caption.match(/#(\w+)/g) || []).map(t => t.toLowerCase());
            tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
          });
          result.hashtags = Object.entries(tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([tag]) => tag);

          // Engagement rate
          if (followerCount > 0 && result.recentPosts.length > 0) {
            const avgLikes = result.recentPosts.reduce((s, p) => s + p.engagement.likes, 0) / result.recentPosts.length;
            const avgComments = result.recentPosts.reduce((s, p) => s + p.engagement.comments, 0) / result.recentPosts.length;
            const rate = ((avgLikes + avgComments) / followerCount) * 100;
            result.engagementRate = rate.toFixed(2) + '%';
            result.followerQuality = (followerCount > 5000 && rate < 0.5) ? 'suspicious' : rate >= 3 ? 'authentic' : rate >= 1 ? 'average' : 'low';
          }

          // Posting consistency from timestamps
          const timestamps = result.recentPosts
            .map(p => p.timestamp)
            .filter(Boolean)
            .sort((a, b) => b - a);
          if (timestamps.length >= 2) {
            const now = Math.floor(Date.now() / 1000);
            const daysSinceLast = (now - timestamps[0]) / 86400;
            const gaps = [];
            for (let i = 0; i < timestamps.length - 1; i++) {
              gaps.push((timestamps[i] - timestamps[i+1]) / 86400);
            }
            const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
            if (daysSinceLast > 90) result.postingConsistency = 'inactive';
            else if (avgGap <= 7) result.postingConsistency = 'consistent';
            else if (avgGap <= 14) result.postingConsistency = 'moderate';
            else result.postingConsistency = 'sporadic';
          }
        }
      } catch (e) { /* JSON parse failed — use meta fallback */ }
    }

    // Try additional JSON embed format (newer Instagram pages)
    if (result.recentPosts.length === 0) {
      const additionalData = html.match(/"biography":"([^"]*?)"/);
      if (additionalData) {
        result.bio = result.bio || additionalData[1].replace(/\\n/g, ' ').replace(/\\u[\dA-Fa-f]{4}/g, '');
      }
    }
  } catch (e) {
    console.warn(`[intel] Instagram scrape failed: ${e.message}`);
  }

  // Step 3: Run sentiment analysis on captions if we have them
  if (result.recentPosts.length > 0) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        const captions = result.recentPosts.map((p, i) => `${i+1}. ${p.caption.substring(0, 200)}`).join('\n');
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini', max_tokens: 300,
            messages: [{
              role: 'user',
              content: `Analyze the sentiment of each Instagram post caption below for a business called "${businessName}". Output ONLY a JSON object like: {"posts": [{"index": 1, "sentiment": "positive"}, ...], "overall": "positive"}. Sentiments: positive, neutral, negative.\n\nCaptions:\n${captions}`,
            }],
          }),
        });
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          result.overallSentiment = parsed.overall || 'neutral';
          (parsed.posts || []).forEach(p => {
            if (result.recentPosts[p.index - 1]) result.recentPosts[p.index - 1].sentiment = p.sentiment;
          });
        }
      } catch (e) { /* sentiment analysis failed — keep neutral defaults */ }
    }
  }

  console.log(`[intel] Instagram: ${result.handle || 'not found'}, ${result.recentPosts.length} posts, sentiment: ${result.overallSentiment}, engagement: ${result.engagementRate || 'n/a'}, consistency: ${result.postingConsistency}`);
  return result;
}

module.exports = { gatherBusinessIntel, extractMenuFromImage, scrapeKCReviewSources, searchAndScrapeWeb, scrapeInstagram, scrapeTikTok, searchYouTube };
