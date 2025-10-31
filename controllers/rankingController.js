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
const SEVENROOMS_BASE_URL = "https://www.sevenrooms.com/api-yoa/availability/widget/range";
const PARTY_SIZE = 2;
const DAYS_TO_CHECK = 14;
const DINNER_HOURS = [18, 19, 20, 21]; // 🕕 Dinner focus only

// 🕹️ Bottleneck limiter (slow + safe)
const limiter = new Bottleneck({
  minTime: 2000,   // 1 request every 2 seconds
  maxConcurrent: 1,
});

// 🧠 Retry wrapper for transient HTTP/2 or 5xx errors
async function safeGet(url, retries = 3, delay = 2000) {
  try {
    return await axios.get(url);
  } catch (err) {
    const status = err.response?.status;
    const transient = [429, 500, 502, 503, 504];
    if (retries > 0 && (transient.includes(status) || err.code === "ERR_HTTP2_PROTOCOL_ERROR")) {
      console.warn(`⚠️ ${status || err.code} — retrying ${url} (${retries} left)...`);
      await new Promise((r) => setTimeout(r, delay));
      return safeGet(url, retries - 1, delay * 1.5);
    }
    throw err;
  }
}

// In-memory cache
let cachedRankings = null;
let lastUpdated = null;

/* ----------------------------------------------------
   🧮 Helper: Build SevenRooms API URL for a restaurant
----------------------------------------------------- */
function buildApiUrl(slug) {
  const today = new Date();
  const startDate = today.toISOString().split("T")[0];
  const numDays = DAYS_TO_CHECK;

  return `${SEVENROOMS_BASE_URL}?venue=${slug}&time_slot=19:00&party_size=${PARTY_SIZE}&halo_size_interval=100&start_date=${startDate}&num_days=${numDays}&channel=SEVENROOMS_WIDGET&selected_lang_code=en&exclude_pdr=true`;
}

/* ----------------------------------------------------
   🕓 Helper: Count available dinner time slots only
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
   📊 Compute Bookability Score for one restaurant
----------------------------------------------------- */
async function computeBookability(restaurant) {
  if (!restaurant.slug) return null;

  try {
    const url = buildApiUrl(restaurant.slug);
    const response = await limiter.schedule(() => safeGet(url));
    const slots = countBookableSlots(response.data);

    const totalPossibleSlots = DAYS_TO_CHECK * DINNER_HOURS.length;
    const availabilityRatio = slots / totalPossibleSlots;

    // Bookability = % of slots that are NOT available
    const bookabilityScore = Math.max(0, Math.round((1 - availabilityRatio) * 100));

    return {
      name: restaurant.name,
      slug: restaurant.slug,
      bookability_score: bookabilityScore,
      available_slots: slots,
      rating: restaurant.rating || null,
      userRatings: restaurant.userRatings || null,
    };
  } catch (err) {
    console.error(`❌ ${restaurant.slug} failed:`, err.message || err);
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
  let index = 0;

  for (const r of restaurants) {
    index++;
    if (!r.slug) continue;
    console.log(`🔢 [${index}/${restaurants.length}] Checking ${r.slug}...`);
    const data = await computeBookability(r);
    if (data) results.push(data);
  }

  const ranked = results.sort((a, b) => b.bookability_score - a.bookability_score);

  cachedRankings = ranked;
  lastUpdated = new Date().toISOString();

  console.log(`✅ Rankings computed for ${ranked.length} restaurants.`);
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



