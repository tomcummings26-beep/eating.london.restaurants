import axios from 'axios';

export const INSTAGRAM_SKIP_SENTINEL = '[instagram-skip]';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const INSTAGRAM_LINK_REGEX =
  /(?:https?:)?\/\/(?:www\.)?instagram\.com\/(?!p\/|explore\/|stories\/|reels\/|tv\/|accounts\/)([A-Za-z0-9_.-]{2,30})(?=[\/?#"'\s]|$)/gi;
const INSTAGRAM_HANDLE_REGEX = /(?:^|[\s(>])@([A-Za-z0-9_.]{2,30})(?=[\s)<]|$)/g;

const sanitizeWebsiteUrl = (url) => {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed.replace(/^\/*/, '')}`;
};

const sanitizeInstagramUsername = (username) => {
  if (!username) return '';
  return username.replace(/[^A-Za-z0-9_.]/g, '').replace(/^\./, '').replace(/\.+$/, '');
};

const toInstagramUrl = (username) => `https://www.instagram.com/${username}/`;

const extractFromHtml = (html) => {
  if (!html || typeof html !== 'string') return null;

  const seen = new Set();
  let match;
  while ((match = INSTAGRAM_LINK_REGEX.exec(html)) !== null) {
    const username = sanitizeInstagramUsername(match[1]);
    if (!username || seen.has(username)) continue;
    seen.add(username);
    return { url: toInstagramUrl(username), username, source: 'link' };
  }

  while ((match = INSTAGRAM_HANDLE_REGEX.exec(html)) !== null) {
    const username = sanitizeInstagramUsername(match[1]);
    if (!username || seen.has(username)) continue;
    // guard against common email patterns
    const sliceStart = Math.max(0, match.index - 20);
    const context = html.slice(sliceStart, match.index + username.length + 1).toLowerCase();
    if (context.includes('@gmail') || context.includes('@hotmail') || context.includes('@yahoo')) {
      continue;
    }
    seen.add(username);
    return { url: toInstagramUrl(username), username, source: 'handle' };
  }

  return null;
};

export const hasInstagramSkipNote = (notes) => {
  if (!notes) return false;
  return String(notes).includes(INSTAGRAM_SKIP_SENTINEL);
};

export const removeInstagramSkipNote = (notes) => {
  if (!notes) return '';
  const lines = String(notes)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith(INSTAGRAM_SKIP_SENTINEL));
  return lines.join('\n');
};

export const addInstagramSkipNote = (notes, reason) => {
  const existing = String(notes || '').trim();
  if (existing.includes(INSTAGRAM_SKIP_SENTINEL)) {
    return existing;
  }
  const suffix = reason ? ` ${reason}` : '';
  const entry = `${INSTAGRAM_SKIP_SENTINEL}${suffix}`.trim();
  return existing ? `${existing}\n${entry}` : entry;
};

export async function findInstagramProfile(websiteUrl, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, limiter = null } = options;
  const normalizedWebsite = sanitizeWebsiteUrl(websiteUrl);
  if (!normalizedWebsite) {
    return { error: 'invalid_website', message: 'No website URL provided.' };
  }

  const scheduler = limiter
    ? (fn) => limiter.schedule(fn)
    : (fn) => fn();

  try {
    const response = await scheduler(() =>
      axios.get(normalizedWebsite, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        },
        timeout: timeoutMs,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
      })
    );

    const html = typeof response.data === 'string' ? response.data : '';
    const extracted = extractFromHtml(html);
    if (extracted) {
      return extracted;
    }

    return { error: 'not_found', message: 'No Instagram profile link found on website.' };
  } catch (error) {
    if (error.response) {
      return {
        error: 'request_failed',
        status: error.response.status,
        message: `Request failed with status code ${error.response.status}`,
      };
    }

    if (error.code === 'ENOTFOUND') {
      return { error: 'request_failed', message: 'Domain lookup failed.' };
    }

    return { error: 'request_failed', message: error.message || 'Failed to fetch website.' };
  }
}

