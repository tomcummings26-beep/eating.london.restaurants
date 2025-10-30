// routes/rankings.js
import express from "express";
import { getRankings, refreshRankings } from "../controllers/rankingController.js";

const router = express.Router();

/**
 * @route   GET /rankings
 * @desc    Returns cached Bookability rankings
 */
router.get("/", getRankings);

/**
 * @route   GET /rankings/refresh
 * @desc    Triggers a full refresh of Bookability scores (live SevenRooms call)
 */
router.get("/refresh", refreshRankings);

export default router;
