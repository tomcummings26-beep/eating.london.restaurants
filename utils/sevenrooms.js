// utils/sevenrooms.js
import fetch from "node-fetch";

/**
 * Fetch availability slots from SevenRooms
 */
export async function fetchAvailability(venueSlug, partySize = 2, days = 14) {
  const start = new Date();
  const startStr = start.toISOString().split("T")[0];

  const url = `https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=${venueSlug}&time_slot=19:00&party_size=${partySize}&halo_size_interval=100&start_date=${startStr}&num_days=${days}&channel=SEVENROOMS_WIDGET&selected_lang_code=en&exclude_pdr=true`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed for ${venueSlug}`);
    const data = await res.json();

    const slots = [];
    for (const details of Object.values(data.data.availability || {})) {
      for (const detail of details) {
        if (detail.is_closed) continue;
        for (const t of detail.times) {
          if (t.type === "book") {
            const iso = t.real_datetime_of_slot.replace(" ", "T");
            const dt = new Date(iso);
            const hr = dt.getHours();
            // Keep only lunch (12-15h) and dinner (18-21h)
            if ((hr >= 12 && hr <= 15) || (hr >= 18 && hr <= 21)) {
              slots.push({
                date: dt.toISOString().split("T")[0],
                time: dt.toTimeString().slice(0, 5),
              });
            }
          }
        }
      }
    }
    return slots;
  } catch (err) {
    console.error(`❌ SevenRooms fetch error for ${venueSlug}:`, err.message);
    return [];
  }
}
