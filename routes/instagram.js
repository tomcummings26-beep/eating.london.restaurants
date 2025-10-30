import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const MAX_POSTS = 6;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const JSON_ENDPOINTS = [
  (username) => `https://www.instagram.com/${username}/?__a=1&__d=dis`,
  (username) => `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`
];

const jsonHeaders = (username) => ({
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: `https://www.instagram.com/${username}/`,
  'X-Requested-With': 'XMLHttpRequest'
});

const htmlHeaders = (username) => ({
  'User-Agent': USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: `https://www.instagram.com/${username}/`
});

const isMediaEdgeArray = (value) =>
  Array.isArray(value) && value.some((edge) => edge?.node?.shortcode);

const findEdgesDeep = (payload) => {
  const stack = [payload];
  const visited = new Set();

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      if (isMediaEdgeArray(current)) {
        return current;
      }
      for (const item of current) {
        if (item && typeof item === 'object') {
          stack.push(item);
        }
      }
      continue;
    }

    const timeline = current.edge_owner_to_timeline_media;
    if (timeline?.edges && isMediaEdgeArray(timeline.edges)) {
      return timeline.edges;
    }

    if (current.edges && isMediaEdgeArray(current.edges)) {
      return current.edges;
    }

    for (const key of Object.keys(current)) {
      const value = current[key];
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return [];
};

const normaliseEdges = (payload) => {
  const directEdges =
    payload?.graphql?.user?.edge_owner_to_timeline_media?.edges ||
    payload?.data?.user?.edge_owner_to_timeline_media?.edges;

  if (isMediaEdgeArray(directEdges)) {
    return directEdges;
  }

  return findEdgesDeep(payload);
};

const mapPosts = (edges) =>
  edges.slice(0, MAX_POSTS).map((edge) => ({
    image: edge?.node?.thumbnail_src || edge?.node?.display_url || '',
    link: edge?.node?.shortcode
      ? `https://www.instagram.com/p/${edge.node.shortcode}/`
      : '',
    caption: edge?.node?.edge_media_to_caption?.edges?.[0]?.node?.text || '',
    likes: edge?.node?.edge_liked_by?.count || 0,
    comments: edge?.node?.edge_media_to_comment?.count || 0
  }));

const extractEdgesFromNextData = (payload) => {
  if (!payload) return [];

  const candidateSets = [
    payload?.props?.pageProps?.graphql?.user?.edge_owner_to_timeline_media?.edges,
    payload?.props?.pageProps?.profilePosts?.edges,
    payload?.props?.pageProps?.timeline?.edges
  ];

  for (const edges of candidateSets) {
    if (Array.isArray(edges) && edges.length) {
      return edges;
    }
  }

  const deepEdges = findEdgesDeep(payload);
  if (deepEdges.length) {
    return deepEdges;
  }

  return [];
};

async function tryJsonEndpoints(username) {
  for (const builder of JSON_ENDPOINTS) {
    const url = builder(username);
    try {
      const response = await fetch(url, { headers: jsonHeaders(username) });
      if (response.status === 404) {
        return { status: 404 };
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = await response.json();
      const edges = normaliseEdges(json);
      if (edges?.length) {
        return { edges, from: url };
      }
    } catch (err) {
      // fall through to next endpoint
      continue;
    }
  }
  return null;
}

async function fetchHtml(username) {
  const attempts = [
    {
      url: `https://www.instagram.com/${username}/`,
      options: { headers: htmlHeaders(username) }
    },
    {
      url: `https://r.jina.ai/https://www.instagram.com/${username}/`,
      options: { headers: { 'User-Agent': USER_AGENT } }
    },
    {
      url: `https://r.jina.ai/http://www.instagram.com/${username}/`,
      options: { headers: { 'User-Agent': USER_AGENT } }
    }
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, attempt.options);
      if (!response.ok) {
        errors.push(`HTTP ${response.status} (${attempt.url})`);
        continue;
      }
      const text = await response.text();
      if (text) {
        return { html: text, source: attempt.url };
      }
    } catch (err) {
      // try next attempt
      errors.push(`${err?.message || err} (${attempt.url})`);
      continue;
    }
  }

  const detail = errors.length ? `: ${errors.join('; ')}` : '';
  return { error: `All HTML fetch attempts failed${detail}` };
}

async function fetchFromHtml(username) {
  const htmlResult = await fetchHtml(username);
  if (htmlResult?.error) {
    return { error: htmlResult.error };
  }

  const { html, source } = htmlResult;

  const additionalDataMatches = Array.from(
    html.matchAll(/window\.__additionalDataLoaded\('profilePage_\d+',({.*})\);/g)
  );

  for (const match of additionalDataMatches) {
    try {
      const payload = JSON.parse(match[1]);
      const edges = normaliseEdges(payload);
      if (edges?.length) {
        return { edges, from: `${source}#additionalData` };
      }
    } catch (err) {
      // ignore malformed JSON
    }
  }

  const mediaMatch = html.match(
    /"edge_owner_to_timeline_media":\{"count":\d+,"page_info":\{.*?\},"edges":(\[.*?\])\}/s
  );
  if (mediaMatch) {
    try {
      const edges = JSON.parse(mediaMatch[1]);
      if (edges?.length) {
        return { edges, from: `${source}#regex` };
      }
    } catch (err) {
      // ignore parse error and continue
    }
  }

  const nextDataMatch = html.match(
    /<script type="application\/json" id="__NEXT_DATA__">(.*?)<\/script>/s
  );
  if (nextDataMatch) {
    try {
      const payload = JSON.parse(nextDataMatch[1]);
      const edges = extractEdgesFromNextData(payload);
      if (edges?.length) {
        return { edges, from: `${source}#__NEXT_DATA__` };
      }
    } catch (err) {
      // ignore malformed NEXT_DATA payloads and continue
    }
  }

  return { error: 'Unable to extract media from HTML response' };
}

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
    const jsonResult = await tryJsonEndpoints(username);
    if (jsonResult?.status === 404) {
      return res.status(404).json({ error: 'Instagram profile not found' });
    }
    let edges = jsonResult?.edges;
    let source = jsonResult?.from || 'json';

    if (!edges?.length) {
      const htmlResult = await fetchFromHtml(username);
      if (htmlResult?.error) {
        throw new Error(htmlResult.error);
      }
      edges = htmlResult.edges;
      source = htmlResult.from;
    }

    if (!edges?.length) {
      throw new Error('No media edges found in Instagram response');
    }

    const posts = mapPosts(edges);
    cache.set(username, { timestamp: Date.now(), data: posts });

    res.json({ username, fromCache: false, source, posts });
  } catch (error) {
    console.error(`\u274c Instagram fetch failed for ${username}:`, error);
    res.status(502).json({ error: 'Failed to fetch Instagram feed' });
  }
});

export default router;
