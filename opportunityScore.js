// opportunityScore.js — Weighted Opportunity Scoring Engine
// Each of 6 dimensions is scored 0-100 by AI with a cited justification.
// The composite is computed deterministically from fixed weights — never by AI.

const DIMENSIONS = [
  { key: 'customer_sentiment',       label: 'Customer Sentiment',      weight: 0.25 },
  { key: 'competitive_position',     label: 'Competitive Position',    weight: 0.20 },
  { key: 'demand_alignment',         label: 'Demand Alignment',        weight: 0.20 },
  { key: 'operational_consistency',  label: 'Operational Consistency', weight: 0.15 },
  { key: 'digital_presence',         label: 'Digital Presence',        weight: 0.10 },
  { key: 'community_signal',         label: 'Community Signal',        weight: 0.10 },
];

// ── Ask AI to score each dimension 0-100 with a cited justification ──────────
async function scoreDimensions(intel, businessName) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error('OPENAI_API_KEY not configured');

  const parse = (field) => {
    if (!intel[field]) return null;
    if (typeof intel[field] === 'string') {
      try { return JSON.parse(intel[field]); } catch(e) { return null; }
    }
    return intel[field];
  };

  const placeData         = parse('place_data') || {};
  const competitors       = parse('competitors') || [];
  const communityMentions = parse('community_mentions') || [];
  const websiteData       = parse('website_data') || {};

  const rating      = placeData.rating || null;
  const reviewCount = placeData.userRatingCount || 0;
  const reviews     = (placeData.reviews || [])
    .map(r => `[${r.rating}★] ${r.text?.text || ''}`)
    .join('\n\n')
    .substring(0, 2000);

  const competitorSummary = competitors
    .slice(0, 15)
    .map(c => `- ${c.displayName?.text || 'Unknown'}: ${c.rating || '?'}★ (${c.userRatingCount || 0} reviews)`)
    .join('\n');

  const communityText = communityMentions.length
    ? communityMentions
        .map(m => `[${m.source}] ${m.title || ''}: ${(m.body || '').substring(0, 150)}`)
        .join('\n')
    : 'No community mentions found in database.';

  const websiteUri   = placeData.websiteUri || null;
  const hasMenuPage  = !!(websiteData.menuUrl || websiteData.menuText);
  const photoSubjects = typeof intel.ai_photo_subjects === 'string'
    ? intel.ai_photo_subjects
    : JSON.stringify(intel.ai_photo_subjects || []);
  const menuItems = typeof intel.ai_menu_items === 'string'
    ? intel.ai_menu_items
    : JSON.stringify(intel.ai_menu_items || []);

  const prompt = `You are scoring "${businessName}" across 6 business opportunity dimensions for an internal consulting report. Each dimension must receive an integer score 0-100 with a one-sentence justification that cites the specific data that drove the number. Do not inflate — scores must reflect the actual evidence provided.

Scoring guidelines (apply consistently across all dimensions):
- 80-100: Exceptional — clear, specific evidence of strong performance or competitive advantage
- 60-79: Solid — above average with some identifiable gaps
- 40-59: Mixed — real concerns exist alongside genuine positives
- 20-39: Weak — persistent, documented problems with limited upside
-  0-19: Critical — severe deficiencies that constitute existential risk

DIMENSION DEFINITIONS:
- customer_sentiment: Overall sentiment from Google reviews and ratings; customer satisfaction patterns
- competitive_position: Standing vs. nearby competitors by rating, price tier, and differentiation
- demand_alignment: Evidence that menu items, photos, and offerings match what customers want and photograph
- operational_consistency: Patterns in reviews regarding reliability, wait times, service quality, management
- digital_presence: Website quality, menu accessibility online, social media visibility, photo count on Google Maps
- community_signal: Coverage in local press, Reddit, community databases, and KC media sources

DATA PROVIDED:
Google Rating: ${rating ? `${rating}★ (${reviewCount} reviews)` : 'Not found on Google Maps'}
Website: ${websiteUri || 'No website listed'}
Menu page online: ${hasMenuPage ? 'Yes' : 'No'}
Google Maps photos: ${(placeData.photos || []).length || 0} photos

REVIEW EXCERPTS:
${reviews || 'No reviews available.'}

AI PROFILE SUMMARY:
${(intel.ai_profile || '').substring(0, 1500) || 'Not available.'}

COMPETITOR LANDSCAPE (within 5 miles):
${competitorSummary || 'No competitor data available.'}

COMPETITOR ANALYSIS:
${(intel.ai_competitors || '').substring(0, 800) || 'Not available.'}

PHOTO DEMAND SIGNALS:
${photoSubjects.substring(0, 600) || 'Not available.'}

MENU ITEMS EXTRACTED:
${menuItems.substring(0, 600) || 'Not available.'}

COMMUNITY MENTIONS:
${communityText.substring(0, 600)}

Output ONLY a valid JSON object. No text before or after:
{
  "customer_sentiment":      { "score": <integer 0-100>, "justification": "<one sentence citing specific data>" },
  "competitive_position":    { "score": <integer 0-100>, "justification": "<one sentence citing specific data>" },
  "demand_alignment":        { "score": <integer 0-100>, "justification": "<one sentence citing specific data>" },
  "operational_consistency": { "score": <integer 0-100>, "justification": "<one sentence citing specific data>" },
  "digital_presence":        { "score": <integer 0-100>, "justification": "<one sentence citing specific data>" },
  "community_signal":        { "score": <integer 0-100>, "justification": "<one sentence citing specific data>" },
  "interpretation": "<2-3 sentence plain English summary naming the single strongest asset and the most urgent risk>"
}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content: 'You are a business intelligence scoring assistant. Output only valid JSON. Never add commentary outside the JSON object.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI did not return valid JSON for dimension scoring');
  return JSON.parse(jsonMatch[0]);
}

// ── Compute composite score deterministically from weights (no AI) ────────────
function computeComposite(dimensionScores) {
  let composite = 0;
  for (const dim of DIMENSIONS) {
    const score = Number(dimensionScores[dim.key]?.score ?? 0);
    composite += score * dim.weight;
  }
  return Math.round(composite * 10) / 10; // one decimal place
}

// ── Score, compute composite, persist to DB, and return result ────────────────
async function computeAndStore(pool, clientId, intel, businessName) {
  console.log(`[score] Computing opportunity score for client ${clientId}: "${businessName}"`);
  const dimensionScores = await scoreDimensions(intel, businessName);
  const composite = computeComposite(dimensionScores);

  const breakdown = {
    dimensions: DIMENSIONS.map(d => ({
      key:           d.key,
      label:         d.label,
      weight:        d.weight,
      score:         Number(dimensionScores[d.key]?.score ?? 0),
      justification: dimensionScores[d.key]?.justification || '',
    })),
    interpretation: dimensionScores.interpretation || '',
  };

  await pool.query(`
    UPDATE business_intel
    SET opportunity_score = $1, score_breakdown = $2
    WHERE client_id = $3
  `, [composite, JSON.stringify(breakdown), clientId]);

  console.log(`[score] Complete for client ${clientId}: composite ${composite}`);
  return { opportunity_score: composite, score_breakdown: breakdown };
}

module.exports = { computeAndStore, computeComposite, DIMENSIONS };
