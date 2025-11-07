import axios from "axios";
import Bottleneck from "bottleneck";
import cron from "node-cron";

/* -------------------------------------------
   Fetch restaurant list from your live API
-------------------------------------------- */
async function fetchRestaurants() {
  const url = "https://eatinglondonrestaurants-production.up.railway.app/restaurants";
  const response = await axios.get(url);
  const data = Array.isArray(response.data) ? response.data : response.data.restaurants;
  return data || [];
}

/* -------------------------------------------
   SevenRooms settings (DINNER ONLY)
-------------------------------------------- */
const SEVENROOMS_BASE_URL = "https://www.sevenrooms.com/api-yoa/availability/widget/range";
const PARTY_SIZE = 2;
const DAYS_TO_CHECK = 14;
const DINNER_HOURS = [18, 19, 20, 21];

/* -------------------------------------------
   Rate limiting & retry for transient errors
-------------------------------------------- */
const limiter = new Bottleneck({
  minTime: 2000,   // 1 request every 2s
  maxConcurrent: 1
});

async function safeGet(url, retries = 3, delay = 2000) {
  try {
    return await axios.get(url);
  } catch (err) {
    const status = err.response?.status;
    const transient = [429, 500, 502, 503, 504];
    if (retries > 0 && (transient.includes(status) || err.code === "ERR_HTTP2_PROTOCOL_ERROR")) {
      console.warn(`⚠️ ${status || err.code} — retrying ${url} (${retries} left)...`);
      await new Promise((r) => setTimeout(r, delay));
      return safeGet(url, retries - 1, Math.floor(delay * 1.5));
    }
    throw err;
  }
}

/* -------------------------------------------
   Cache & state
-------------------------------------------- */
let cachedRankings = null;
let lastUpdated = null;
let isComputing = false;

/* -------------------------------------------
   Helpers
-------------------------------------------- */
function buildApiUrl(slug) {
  const today = new Date();
  const startDate = today.toISOString().split("T")[0];
  return `${SEVENROOMS_BASE_URL}?venue=${slug}&time_slot=19:00&party_size=${PARTY_SIZE}&halo_size_interval=100&start_date=${startDate}&num_days=${DAYS_TO_CHECK}&channel=SEVENROOMS_WIDGET&selected_lang_code=en&exclude_pdr=true`;
}

function countDinnerSlots(apiData) {
  if (!apiData?.data?.availability) return null; // null → “no data”, not “no availability”
  let count = 0;
  for (const details of Object.values(apiData.data.availability)) {
    for (const detail of details) {
      if (detail.is_closed) continue;
      for (const t of detail.times) {
        if (t.type !== "book") continue;
        const d = new Date((t.real_datetime_of_slot || "").replace(" ", "T"));
        if (Number.isNaN(d.getTime())) continue;
        const hour = d.getHours();
        if (DINNER_HOURS.includes(hour)) count++;
      }
    }
  }
  return count; // 0 is valid “hard to book”; null means “failed/no data”
}

/* -------------------------------------------
   Extract nearest weekend (Fri/Sat) slots 18–21h
-------------------------------------------- */
function extractUpcomingWeekendSlots(apiData) {
  if (!apiData?.data?.availability) return null;

  const now = new Date();
  const day = now.getDay(); // 0=Sun, 5=Fri, 6=Sat
  const nextFriday = new Date(now);
  const nextSaturday = new Date(now);

  if (day < 5) {
    nextFriday.setDate(now.getDate() + (5 - day));
    nextSaturday.setDate(now.getDate() + (6 - day));
  } else if (day === 5) {
    nextFriday.setDate(now.getDate());
    nextSaturday.setDate(now.getDate() + 1);
  } else if (day === 6) {
    nextFriday.setDate(now.getDate());
    nextSaturday.setDate(now.getDate());
  } else {
    nextFriday.setDate(now.getDate() + 5);
    nextSaturday.setDate(now.getDate() + 6);
  }

  const targetDays = [nextFriday.toISOString().split("T")[0], nextSaturday.toISOString().split("T")[0]];
  const targetHours = [18, 19, 20, 21];
  const found = {};

  for (const [date, details] of Object.entries(apiData.data.availability)) {
    if (!targetDays.includes(date)) continue;
    const availableTimes = [];
    for (const detail of details) {
      if (detail.is_closed) continue;
      for (const t of detail.times) {
        if (t.type !== "book") continue;
        const d = new Date((t.real_datetime_of_slot || "").replace(" ", "T"));
        if (targetHours.includes(d.getHours())) {
          availableTimes.push(d.toISOString().slice(11, 16)); // "18:30"
        }
      }
    }
    if (availableTimes.length) found[date] = availableTimes;
  }

  return Object.keys(found).length ? found : null;
}

/* -------------------------------------------
   Fetch + parse slots for each restaurant
-------------------------------------------- */
async function fetchDinnerSlotsForRestaurant(restaurant) {
  if (!restaurant?.slug) return { ok: false, slots: null, weekendSlots: null, restaurant };
  try {
    const url = buildApiUrl(restaurant.slug);
    const response = await limiter.schedule(() => safeGet(url));
    const slots = countDinnerSlots(response.data);
    const weekendSlots = extractUpcomingWeekendSlots(response.data);
    return { ok: slots !== null, slots, weekendSlots, restaurant };
  } catch (e) {
    console.error(`❌ ${restaurant.slug} failed:`, e.message || e);
    return { ok: false, slots: null, weekendSlots: null, restaurant };
  }
}

/* -------------------------------------------
   Normalization helpers
-------------------------------------------- */
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Convert raw slot counts to 0–100 “bookability_score”
 * Hardest (fewest slots) → 100; Easiest (most slots) → 0
 * Uses p95 cap to avoid a single outlier collapsing the range.
 */
function normalizeToScore(results) {
  const valid = results.filter(r => r.ok && typeof r.slots === "number");
  if (!valid.length) return results.map(r => ({ ...r, bookability_score: null }));

  const rawSlots = valid.map(v => v.slots);
  const minSlots = Math.min(...rawSlots);
  const p95Slots = percentile(rawSlots, 95);
  const denom = Math.max(1, p95Slots - minSlots);

  return results.map(r => {
    if (!r.ok || typeof r.slots !== "number") {
      return { ...r, bookability_score: null };
    }
    const capped = Math.min(r.slots, p95Slots);
    const ratio = (capped - minSlots) / denom;
    const score = Math.round((1 - ratio) * 100);
    return { ...r, bookability_score: score };
  });
}

/* -------------------------------------------
   Main compute
-------------------------------------------- */
export async function computeRankings() {
  if (isComputing) return;
  isComputing = true;

  console.log("📡 Fetching restaurant list from live API...");
  const restaurants = await fetchRestaurants();

  if (!restaurants.length) {
    console.warn("⚠️ No restaurants returned from API feed!");
    isComputing = false;
    cachedRankings = [];
    lastUpdated = new Date().toISOString();
    return { updated: lastUpdated, count: 0, rankings: [] };
  }

  const results = [];
  let idx = 0;
  for (const r of restaurants) {
    idx++;
    if (!r.slug) continue;
    console.log(`🔢 [${idx}/${restaurants.length}] ${r.slug}`);
    const res = await fetchDinnerSlotsForRestaurant(r);
    results.push(res);
  }

  // Normalize across cohort
  const withScores = normalizeToScore(results);

  // Build output rows
  const rows = withScores
    .filter(r => r.bookability_score !== null)
    .map(({ restaurant, slots, bookability_score, weekendSlots }) => ({
      name: restaurant.name,
      slug: restaurant.slug,
      bookability_score,
      available_slots: slots,
      weekend_slots: weekendSlots,
      rating: restaurant.rating ?? null,
      userRatings: restaurant.userRatings ?? null
    }))
    .sort((a, b) => b.bookability_score - a.bookability_score);

  cachedRankings = rows;
  lastUpdated = new Date().toISOString();
  isComputing = false;

  console.log(`✅ Rankings computed for ${rows.length} restaurants.`);
  return { updated: lastUpdated, count: rows.length, rankings: rows };
}

/* -------------------------------------------
   Express handlers (non-blocking)
-------------------------------------------- */
export async function getRankings(_req, res) {
  try {
    if (!cachedRankings) {
      if (!isComputing) {
        console.log("🧮 No cached rankings — starting initial computation…");
        computeRankings().catch(console.error);
      }
      return res.status(202).json({ message: "Rankings are being generated. Please check back shortly." });
    }

    if (isComputing) {
      return res.status(202).json({
        message: "Rankings currently refreshing, please retry soon.",
        lastUpdated
      });
    }

    res.json({ lastUpdated, count: cachedRankings.length, rankings: cachedRankings });
  } catch (err) {
    console.error("❌ getRankings error:", err);
    res.status(500).json({ error: "Failed to fetch rankings" });
  }
}

export async function refreshRankings(_req, res) {
  try {
    if (isComputing) {
      return res.status(429).json({ message: "Refresh already in progress. Please wait." });
    }
    console.log("🔁 Manual refresh requested…");
    computeRankings().catch(console.error);
    res.status(202).json({ message: "Refresh started." });
  } catch (err) {
    console.error("❌ refreshRankings error:", err);
    res.status(500).json({ error: "Failed to refresh rankings" });
  }
}

/* -------------------------------------------
   Nightly cron (runs daily at 02:00 UTC)
-------------------------------------------- */
cron.schedule("0 2 * * *", async () => {
  if (isComputing) {
    console.log("⏳ Cron skipped — computation already in progress.");
    return;
  }
  console.log("🌙 Nightly cron triggered — refreshing rankings...");
  try {
    await computeRankings();
    console.log("✅ Nightly rankings refresh complete.");
  } catch (err) {
    console.error("❌ Nightly cron failed:", err);
  }
});





