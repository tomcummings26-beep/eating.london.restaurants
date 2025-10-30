// controllers/rankingController.js
import fs from "fs";
import path from "path";
import { fetchAvailability } from "../utils/sevenrooms.js";
import restaurants from "../restaurants.json" assert { type: "json" };

const CACHE_PATH = path.resolve("./rankings-cache.json");

/**
 * Calculate Bookability scores and cache results
 */
export async function refreshRankings() {
  console.log("🚀 Refreshing Bookability Rankings…");

  const results = [];
  const end = new Date();
  end.setDate(end.getDate() + 14);

  for (const r of restaurants) {
    if (!r.apiSource || r.apiSource !== "SevenRooms" || !r.slug) continue;

    const slots = await fetchAvailability(r.slug, 2, 14);
    const totalPossible = 14 * 2 * 6; // 14 days × (lunch+dinner) × 6 slots
    const available = slots.length;
    const availabilityPct = available / totalPossible;
    const bookabilityScore = Math.round((1 - availabilityPct) * 100);

    results.push({
      ...r,
      bookability_score: bookabilityScore,
      available_slots: available,
      next_available: slots[0]?.date || null,
      updated_at: new Date().toISOString(),
    });

    // small delay to avoid throttling
    await new Promise((r) => setTimeout(r, 500));
  }

  results.sort((a, b) => b.bookability_score - a.bookability_score);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(results, null, 2));
  console.log("✅ Rankings refreshed and saved.");
  return results;
}

/**
 * Load cached rankings
 */
export function getRankings() {
  try {
    const text = fs.readFileSync(CACHE_PATH, "utf8");
    return JSON.parse(text);
  } catch {
    return [];
  }
}
