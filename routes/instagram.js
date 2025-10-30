import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

router.get('/:username', async (req, res) => {
  const username = req.params.username?.trim().toLowerCase();

  if (!username) {
    return res.status(400).json({ error: 'Missing Instagram username' });
  }

  const cached = cache.get(username);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json({ username, fromCache: true, posts: cached.data });
  }

  try {
    const url = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`Instagram request failed (${response.status})`);
    }

    const json = await response.json();
    const edges = json?.graphql?.user?.edge_owner_to_timeline_media?.edges || [];

    const posts = edges.slice(0, 6).map((edge) => ({
      image: edge.node.thumbnail_src,
      link: `https://www.instagram.com/p/${edge.node.shortcode}/`,
      caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
      likes: edge.node.edge_liked_by?.count || 0,
      comments: edge.node.edge_media_to_comment?.count || 0
    }));

    cache.set(username, { timestamp: Date.now(), data: posts });

    res.json({ username, fromCache: false, posts });
  } catch (error) {
    console.error(`\u274c Instagram fetch failed for ${username}:`, error);
    res.status(500).json({ error: 'Failed to fetch Instagram feed' });
  }
});

export default router;
