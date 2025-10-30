// routes/rankings.js
import express from "express";
import { refreshRankings, getRankings } from "../controllers/rankingController.js";

const router = express.Router();

// Public list
router.get("/", (req, res) => {
  const data = getRankings();
  res.json(data);
});

// Manual refresh (for Railway scheduler)
router.get("/refresh", async (req, res) => {
  try {
    const data = await refreshRankings();
    res.json({ updated: new Date().toISOString(), count: data.length });
  } catch (err) {
    console.error("❌ Refresh failed:", err.message);
    res.status(500).json({ error: "Failed to refresh rankings" });
  }
});

export default router;
