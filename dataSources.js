// dataSources.js — PresageIQ Data Source Registry
// Documents every external data source used by the platform.
// Each entry: id, name, url, description, update_frequency, how_used

const DATA_SOURCES = [
  {
    id: 'census_acs',
    name: 'U.S. Census Bureau — American Community Survey (ACS)',
    url: 'https://data.census.gov',
    description: 'Five-year ACS estimates providing demographic profiles for Kansas City neighborhoods: population, median income, median age, housing tenure, poverty rate, educational attainment, and racial composition by ZIP code.',
    update_frequency: 'Annual (5-year rolling estimates)',
    how_used: 'Populates the neighborhood_profiles table. Used to assess demand alignment, purchasing power, and demographic fit for a business concept in a target neighborhood.',
  },
  {
    id: 'hmda',
    name: 'Home Mortgage Disclosure Act Data (CFPB)',
    url: 'https://ffiec.cfpb.gov/data-browser/',
    description: 'Federal mortgage lending disclosure data aggregated by the Consumer Financial Protection Bureau. Covers loan originations, denials, and withdrawals by MSA, year, action taken, and borrower demographics. PresageIQ queries the KC metro MSA (28140) for originated vs. denied mortgage application counts to compute an overall denial rate.',
    update_frequency: 'Annual (prior year data released mid-year)',
    how_used: 'Injects lending pattern context into the opportunity scoring prompt for the community_signal dimension. A high mortgage denial rate in the KC metro signals structural capital access constraints that can affect commercial lending patterns in the same neighborhoods.',
  },
  {
    id: 'ejscreen',
    name: 'EPA EJScreen Environmental Justice Mapping Tool',
    url: 'https://ejscreen.epa.gov/mapper/',
    description: 'EPA environmental justice screening tool providing census-tract-level indicators for minority population percentage, low-income percentage, linguistic isolation, and environmental burden indices (cancer risk, diesel particulate matter, traffic proximity, lead paint, superfund proximity). The EJ Index national percentile combines environmental and demographic factors into a single composite score.',
    update_frequency: 'Annual',
    how_used: 'Fetched at the business\'s lat/lng coordinates using a 0.5-mile radius query. Minority percentage, low-income percentage, and the EJ Index national percentile are injected into the opportunity scoring prompt for the demand_alignment dimension, contextualizing price-point fit and consumer purchasing power relative to the surrounding community.',
  },
  {
    id: 'mapping_inequality',
    name: 'Mapping Inequality — HOLC Redlining Maps',
    url: 'https://dsl.richmond.edu/panorama/redlining',
    description: "Digitized Home Owners' Loan Corporation (HOLC) security maps from the 1930s and 1940s, documenting historical appraisal grades (A through D) assigned to urban neighborhoods. Grade D (\"Hazardous\") neighborhoods were systematically denied mortgage lending, producing structural disinvestment whose effects on wealth, housing, and commercial capital persist today.",
    update_frequency: 'Static historical dataset (1935–1940)',
    how_used: "Contextualizes neighborhood opportunity scores. When a client's neighborhood carries a historic \"C\" or \"D\" HOLC grade, this is surfaced in the score breakdown as a historical disinvestment note, providing context for current market conditions and demographic patterns observed in Census and Google data.",
  },
  {
    id: 'kc_open_data',
    name: 'Kansas City Open Data Portal',
    url: 'https://data.kcmo.org',
    description: 'Official municipal dataset from Kansas City, Missouri containing active business licenses, liquor licenses, building permits, health inspections, and code violations. Includes DBA names, addresses, license types, and operational status.',
    update_frequency: 'Weekly',
    how_used: 'Feeds the business_profiles table. Used to map the competitive landscape, identify licensed businesses by neighborhood, and verify operational status of existing competitors.',
  },
  {
    id: 'gdelt',
    name: 'GDELT Project',
    url: 'https://www.gdeltproject.org',
    description: 'Global news event monitoring database that indexes and analyzes online news content worldwide. PresageIQ queries GDELT for Kansas City restaurant, food, bar, and small business coverage across regional and national outlets.',
    update_frequency: 'Daily (15-minute update intervals)',
    how_used: 'Populates community_intel with tagged news articles. Used to detect coverage trends, sentiment shifts, and emerging themes in the KC food and business ecosystem.',
  },
  {
    id: 'google_places',
    name: 'Google Places API (Places API New)',
    url: 'https://developers.google.com/maps/documentation/places/web-service',
    description: 'Enterprise-tier access to Google Maps business data including ratings, review counts, price levels, business categories, photos, hours, service attributes (dine-in, delivery, reservations, live music), and up to five recent customer reviews per business.',
    update_frequency: 'Real-time (pulled on session load)',
    how_used: 'Primary source for business profile data, competitor landscape (searchNearby within 5 miles), customer review sentiment, photo demand signals, and menu/website scraping. Drives the Review Signals and Competitor Intel modules.',
  },
  {
    id: 'foursquare',
    name: 'Foursquare Places API',
    url: 'https://developer.foursquare.com/docs/places-api',
    description: 'Venue intelligence platform providing business categories, venue popularity signals, and location data for KC food and retail establishments.',
    update_frequency: 'Weekly',
    how_used: 'Supplements KC Open Data business profiles with venue category metadata and ratings. Stored in the business_profiles table.',
  },
  {
    id: 'reddit',
    name: 'Reddit — Kansas City Community Feeds',
    url: 'https://www.reddit.com',
    description: 'Community discussions from four Kansas City subreddits: r/kansascity, r/KCFoodScene, r/kansascityfood, and r/kansascitylocal. Captures organic consumer sentiment, new opening buzz, closures, service failures, and neighborhood chatter that does not appear in formal media.',
    update_frequency: 'Daily',
    how_used: 'Populates community_intel with tagged, sentiment-analyzed posts. Used to detect community signal — early mentions of openings, closures, service failures, and neighborhood energy — before press coverage appears.',
    subreddits: ['r/kansascity', 'r/KCFoodScene', 'r/kansascityfood', 'r/kansascitylocal'],
  },
  {
    id: 'instagram',
    name: 'Instagram — Public Business Profiles',
    url: 'https://www.instagram.com',
    description: 'Public Instagram profile data for the client business. Discovered via Google Custom Search, then scraped from the public page. When Instagram\'s embedded JSON is available, collects up to 24 recent post captions with engagement data (likes, comments). Derives engagement rate, posting consistency (consistent/moderate/sporadic/inactive), follower quality flag, and top 5 hashtags from caption content.',
    update_frequency: 'On demand (pulled at session time per client)',
    how_used: 'Powers the Social Intelligence module. Engagement rate and posting consistency inform the Community Signal scoring dimension. No authentication, no private data — public profiles only.',
  },
  {
    id: 'tiktok',
    name: 'TikTok — Public Content Discovery via Google Custom Search',
    url: 'https://www.tiktok.com',
    description: 'Public TikTok content discovered using Google Custom Search with a site:tiktok.com filter. Returns video titles and descriptions for content mentioning the client business by name. No TikTok API key or authentication required — uses only publicly indexed content. Sentiment analysis applied to video titles and descriptions via GPT-4o-mini.',
    update_frequency: 'On demand (searched at session time per client)',
    how_used: 'Powers the Social Intelligence module. Used to detect organic consumer video content about the business — UGC, reviews, and social buzz that does not appear in press or review platforms.',
  },
  {
    id: 'youtube',
    name: 'YouTube Data API v3',
    url: 'https://developers.google.com/youtube/v3',
    description: 'YouTube Data API v3 search for videos mentioning the client business by name. Returns up to 8 public video results with titles, descriptions, channel names, publish dates, and view counts. Requires YouTube Data API v3 enabled in Google Cloud Console. Uses the same Google API key as other Google services.',
    update_frequency: 'On demand (searched at session time per client)',
    how_used: 'Powers the Social Intelligence module. Used to surface food review videos, local news segments, and consumer-generated content about the business on YouTube.',
  },
  {
    id: 'curated_kc_press',
    name: '22 Curated Kansas City Press & Media Sources',
    url: null,
    description: 'A curated set of Kansas City regional publications, local TV stations, food media outlets, and community journalism sources searched via Google Custom Search and direct scraping for per-client business mentions, reviews, and press coverage.',
    update_frequency: 'On demand (searched at session time per client)',
    how_used: 'Powers the KC Press Coverage module and contributes to the Community Signal scoring dimension. Each source is queried for the client\'s business name to surface reviews, profiles, features, and coverage.',
    sources: [
      { name: 'KC Magazine',                        url: 'https://kansascitymag.com',                                                             type: 'Lifestyle and dining magazine' },
      { name: 'The Pitch KC',                       url: 'https://www.thepitchkc.com',                                                            type: 'Alt-weekly — food, arts, culture' },
      { name: 'KCUR Food',                          url: 'https://www.kcur.org',                                                                   type: 'NPR affiliate — food and local culture coverage' },
      { name: 'Kansas City Star',                   url: 'https://www.kansascity.com',                                                             type: 'Daily newspaper — business and dining section' },
      { name: 'Kansas City Business Journal',       url: 'https://www.bizjournals.com/kansascity',                                                 type: 'B2B news — restaurant and retail openings' },
      { name: 'Flatland KC',                        url: 'https://flatlandkc.org',                                                                 type: 'Community journalism — neighborhood and equity focus' },
      { name: 'Startland News',                     url: 'https://startlandnews.com',                                                              type: 'Startup and local small business coverage' },
      { name: '435 Magazine',                       url: 'https://www.435mag.com',                                                                 type: 'Suburban KC lifestyle and dining' },
      { name: 'Eater Kansas City',                  url: 'https://kansas-city.eater.com',                                                          type: 'National food media — Kansas City edition' },
      { name: 'Visit KC',                           url: 'https://www.visitkc.com',                                                                type: 'Tourism board — restaurant features and recommendations' },
      { name: 'KC Studio',                          url: 'https://www.kcstudio.org',                                                               type: 'Arts and culture publication' },
      { name: 'KSHB 41',                            url: 'https://www.kshb.com',                                                                   type: 'Local TV news — food and business segments' },
      { name: 'KMBC 9',                             url: 'https://www.kmbc.com',                                                                   type: 'Local TV news — KC lifestyle and dining coverage' },
      { name: 'Fox4 Kansas City',                   url: 'https://fox4kc.com',                                                                     type: 'Local TV news — restaurant reviews and features' },
      { name: 'KCTV5',                              url: 'https://www.kctv5.com',                                                                   type: 'Local TV news — KC consumer and restaurant coverage' },
      { name: 'Ink Kansas City',                    url: 'https://inkansascity.com',                                                               type: 'Neighborhood news and community stories' },
      { name: 'Feast Magazine',                     url: 'https://www.feastzine.com',                                                              type: 'Midwest food and drink magazine' },
      { name: 'KCPT / Flatland Video',              url: 'https://www.kcpt.org',                                                                   type: 'Public television — KC community programming' },
      { name: 'Yelp Kansas City',                   url: 'https://www.yelp.com/search?find_loc=Kansas+City%2C+MO',                                type: 'Consumer review platform — local business ratings' },
      { name: 'OpenTable Kansas City',              url: 'https://www.opentable.com/kansas-city-restaurant-listings',                             type: 'Reservation platform — diner reviews and ratings' },
      { name: 'TripAdvisor Kansas City',            url: 'https://www.tripadvisor.com/Restaurants-g44535-Kansas_City_Missouri.html',              type: 'Travel review platform — tourist-facing restaurant coverage' },
      { name: 'Thrillist Kansas City',              url: 'https://www.thrillist.com/kansas-city',                                                  type: 'National lifestyle media — KC food and nightlife coverage' },
    ],
  },
];

// ── Kansas City HOLC Neighborhood Grades ──────────────────────────────────────
// Source: Robert K. Nelson, LaDale Winling, Richard Marciano, Nathan Connolly,
// et al., "Mapping Inequality," American Panorama, ed. Robert K. Nelson and
// Edward L. Ayers, accessed 2024, dsl.richmond.edu/panorama/redlining.
// Grades: A = Best, B = Still Desirable, C = Definitely Declining, D = Hazardous
const HOLC_KC_NEIGHBORHOODS = {
  'Brookside': {
    grade: 'A', year: 1940,
    description: 'graded "Best" — considered a premier residential district with strong mortgage investment and high property values throughout the HOLC survey period.',
  },
  'Waldo': {
    grade: 'B', year: 1940,
    description: 'graded "Still Desirable" — established residential area with stable housing stock and adequate lending access during the HOLC survey period.',
  },
  'Country Club Plaza': {
    grade: 'A', year: 1940,
    description: 'graded "Best" — the planned Country Club Plaza district received the highest investment grade, enabling decades of sustained commercial development.',
  },
  'Martin City': {
    grade: 'B', year: 1940,
    description: 'graded "Still Desirable" — southern suburban area with stable development patterns and adequate mortgage lending access during the HOLC survey.',
  },
  'Overland Park': {
    grade: 'A', year: 1940,
    description: 'graded "Best" — outer suburban area received favorable HOLC ratings, enabling the postwar residential and commercial growth that continues today.',
  },
  'Westport': {
    grade: 'C', year: 1940,
    description: 'graded "Definitely Declining" — mixed-use commercial corridor with aging housing stock; subject to reduced mortgage lending and deferred infrastructure investment throughout the postwar period.',
  },
  'Midtown': {
    grade: 'C', year: 1940,
    description: 'graded "Definitely Declining" — mid-tier investment designation resulted in inconsistent capital access across the Midtown corridor, contributing to the area\'s decades-long disinvestment cycle before recent revitalization.',
  },
  'Hyde Park': {
    grade: 'C', year: 1940,
    description: 'graded "Definitely Declining" — received reduced lending access; the designation contributed to deferred maintenance and housing decline in subsequent decades.',
  },
  'North KC': {
    grade: 'C', year: 1940,
    description: 'graded "Definitely Declining" — industrial North Kansas City received reduced residential investment grades, shaping its commercial and housing development trajectory through the postwar period.',
  },
  'Downtown KC': {
    grade: 'C', year: 1940,
    description: 'graded "Definitely Declining" — the central business district received a mixed grade reflecting declining commercial confidence and aging infrastructure in the pre-WWII HOLC survey.',
  },
  'Plaza / Midtown': {
    grade: 'C', year: 1940,
    description: 'graded "Definitely Declining" in its residential sections — mixed investment access shaped the corridor\'s development, with commercial zones favored over residential investment.',
  },
  'Crossroads Arts District': {
    grade: 'D', year: 1940,
    description: 'graded "Hazardous" — the Crossroads and warehouse district was systematically redlined, cutting off mortgage lending and commercial credit for decades before its late-20th-century arts-driven redevelopment.',
  },
  '18th and Vine': {
    grade: 'D', year: 1940,
    description: 'graded "Hazardous" — the historic Jazz District was heavily redlined despite its cultural significance, resulting in severe disinvestment that displaced residents and suppressed commercial investment for generations.',
  },
  'Westside': {
    grade: 'D', year: 1940,
    description: 'graded "Hazardous" — the predominantly Latino Westside neighborhood was redlined, systematically blocking capital access for residents and business owners and creating structural economic disadvantages that persist today.',
  },
  'River Market': {
    grade: 'D', year: 1940,
    description: 'graded "Hazardous" — the historic River Market warehouse and produce district was redlined, limiting private investment for decades before its late-20th-century redevelopment.',
  },
  'East Side / Prospect': {
    grade: 'D', year: 1940,
    description: 'graded "Hazardous" — one of the most extensively redlined sections of Kansas City, with lasting impacts on wealth accumulation, housing quality, and commercial investment that persist today.',
  },
  'KCK / Wyandotte County': {
    grade: 'D', year: 1939,
    description: 'graded "Hazardous" — much of Kansas City, Kansas was redlined in the 1939 survey, producing lasting structural economic disadvantages that shaped Wyandotte County\'s development and investment patterns.',
  },
  'Argentine / Rosedale': {
    grade: 'D', year: 1939,
    description: 'graded "Hazardous" — the Argentine and Rosedale communities in KCK were redlined, blocking capital access for predominantly Latino and working-class residents and suppressing commercial development.',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Return HOLC data for a neighborhood name, using exact then partial match.
function getHolcData(neighborhood) {
  if (!neighborhood) return null;
  if (HOLC_KC_NEIGHBORHOODS[neighborhood]) return HOLC_KC_NEIGHBORHOODS[neighborhood];
  const lower = neighborhood.toLowerCase();
  for (const [key, val] of Object.entries(HOLC_KC_NEIGHBORHOODS)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return val;
  }
  return null;
}

// Build the plain-English historical note string for a given HOLC result.
function buildHolcNote(neighborhood, holcData) {
  return `Historical context applied: ${neighborhood} received HOLC grade ${holcData.grade} in ${holcData.year}, ${holcData.description} Source: Mapping Inequality (dsl.richmond.edu/panorama/redlining), Robert K. Nelson et al.`;
}

module.exports = { DATA_SOURCES, HOLC_KC_NEIGHBORHOODS, getHolcData, buildHolcNote };
