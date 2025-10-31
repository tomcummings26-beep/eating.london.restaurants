// controllers/rankingController.js
import axios from "axios";
import Bottleneck from "bottleneck";

// 🔗 Fetch restaurants dynamically from your live API
async function fetchRestaurants() {
  const url = "https://eatinglondonrestaurants-production.up.railway.app/restaurants";
  const response = await axios.get(url);
  const data = Array.isArray(response.data) ? response.data : response.data.restaurants;
  return data || [];
}

// 🔧 SevenRooms constants
const SEVENROOMS_BASE_URL =
  "https://www.sevenrooms.com/api-yoa/availability/widget/range";
const PARTY_SIZE = 2;
const DAYS_TO_CHECK = 14;
const DINNER_HOURS = [18, 19, 20, 21]; // focus on real dinner window

// 🕹️ Rate limiter (avoid hammering SevenRooms)
const limiter = new Bottleneck({
  minTime: 500,
  maxConcurrent: 2,
});

// In-memory cache
let cachedRankings = null;
let lastUpdated = null;

/* ----------------------------------------------------
   🧮 Helper: Build SevenRooms API URL for a restaurant
----------------------------------------------------- */
function buildApiUrl(slug) {
  const today = new Date();
  const startDate = today.toISOString().split("T")[0];
  const endDate = new Date(today.getTime() + DAYS_TO_CHECK * 86400000)
    .toISOString()
    .split("T")[0];
  const numDays = DAYS_TO_CHECK;

  return `${SEVENROOMS_BASE_URL}?venue=${slug}&time_slot=19:00&party_size=${PARTY_SIZE}&halo_size_interval=100&start_date=${startDate}&num_days=${numDays}&channel=SEVENROOMS_WIDGET&selected_lang_code=en&exclude_pdr=true`;
}

/* ----------------------------------------------------
   🕓 Helper: Count available dinner slots
----------------------------------------------------- */
function countBookableSlots(apiData) {
  if (!apiData?.data?.availability) return 0;

  let availableSlots = 0;

  for (const details of Object.values(apiData.data.availability)) {
    for (const detail of details) {
      if (detail.is_closed) continue;
      for (const t of detail.times) {
        if (t.type !== "book") continue;
        const slotDate = new Date(t.real_datetime_of_slot.replace(" ", "T"));
        const hour = slotDate.getHours();
        if (DINNER_HOURS.includes(hour)) {
          availableSlots++;
        }
      }
    }
  }

  return availableSlots;
}

/* ----------------------------------------------------
   ⚖️ Balanced Bookability Formula (0–100 scale)
----------------------------------------------------- */
function computeBookabilityScore(rating, userRatings, availableSlots) {
  // Scarcity (fewer slots = higher difficulty)
  const scarcity = Math.max(0, 100 - availableSlots); // up to 100 pts

  // Popularity: log scale boost (caps at 15)
  const popularityBoost = Math.min(Math.log10((userRatings || 1) + 1) * 5, 15);

  // Rating: credibility signal (max 10 pts)
  const ratingBoost = rating ? (rating / 5) * 10 : 0;

  // Weighted blend (mostly scarcity)
  const raw = scarcity * 0.8 + popularityBoost + ratingBoost;

  // Clamp between 0–100
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/* ----------------------------------------------------
   📊 Compute Bookability Score for one restaurant
----------------------------------------------------- */
async function computeBookability(restaurant) {
  if (!restaurant.slug) return null;

  try {
    const url = buildApiUrl(restaurant.slug);
    const response = await limiter.schedule(() => axios.get(url));
    const slots = countBookableSlots(response.data);

    const bookabilityScore = computeBookabilityScore(
      restaurant.rating,
      restaurant.userRatings,
      slots
    );

    return {
      name: restaurant.name,
      slug: restaurant.slug,
      bookability_score: bookabilityScore,
      available_slots: slots,
      rating: restaurant.rating || null,
      userRatings: restaurant.userRatings || null,
    };
  } catch (err) {
    console.error(`❌ Failed to fetch for ${restaurant.slug}:`, err.message);
    return null;
  }
}

/* ----------------------------------------------------
   🧠 Compute rankings for all restaurants
----------------------------------------------------- */
async function computeRankings() {
  console.log("📡 Fetching restaurant list from live API...");
  const restaurants = await fetchRestaurants();

  if (!restaurants.length) {
    console.warn("⚠️ No restaurants returned from API feed!");
    return { updated: new Date().toISOString(), count: 0, rankings: [] };
  }

  const results = [];

  for (const r of restaurants) {
    if (!r.slug) continue;
    const data = await computeBookability(r);
    if (data) results.push(data);
  }

  const ranked = results.sort(
    (a, b) => b.bookability_score - a.bookability_score
  );

  cachedRankings = ranked;
  lastUpdated = new Date().toISOString();

  return { updated: lastUpdated, count: ranked.length, rankings: ranked };
}

/* ----------------------------------------------------
   📡 Express Handlers
----------------------------------------------------- */
export async function getRankings(_req, res) {
  try {
    if (!cachedRankings) {
      await computeRankings();
    }
    res.json({
      lastUpdated,
      count: cachedRankings.length,
      rankings: cachedRankings,
    });
  } catch (err) {
    console.error("❌ getRankings error:", err);
    res.status(500).json({ error: "Failed to fetch rankings" });
  }
}

export async function refreshRankings(_req, res) {
  try {
    const result = await computeRankings();
    res.json({
      message: "Rankings refreshed successfully",
      ...result,
    });
  } catch (err) {
    console.error("❌ refreshRankings error:", err);
    res.status(500).json({ error: "Failed to refresh rankings" });
  }
}



