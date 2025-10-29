import axios from 'axios';

const instagramProfileRegex = /https?:\/\/(?:www\.)?instagram\.com\/[^"'\s<>)]+/gi;
const instagramReservedSegments = new Set([
  'accounts',
  'explore',
  'about',
  'blog',
  'developer',
  'directory',
  'events',
  'legal',
  'privacy',
  'press',
  'reel',
  'reels',
  'stories',
  'web',
  'p',
  'tv',
  'topics',
  'email',
  'invite'
]);

const defaultHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

const ensureAbsoluteUrl = (value) => {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
};

const sanitizeInstagramCandidate = (raw) => {
  if (!raw) return '';
  return raw.replace(/&amp;/gi, '&').replace(/["'<>)]*$/, '');
};

const isValidInstagramUsername = (value) => {
  if (!value) return false;
  if (value.length > 30) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
};

export const normalizeInstagramProfileUrl = (rawUrl) => {
  if (!rawUrl) return '';
  try {
    const candidate = sanitizeInstagramCandidate(rawUrl);
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname.endsWith('instagram.com')) {
      return '';
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (!segments.length) {
      return '';
    }

    let username = decodeURIComponent(segments[0]).trim();
    username = username.replace(/^@+/, '');

    const normalized = username.toLowerCase();
    if (instagramReservedSegments.has(normalized)) {
      return '';
    }

    if (!isValidInstagramUsername(username)) {
      return '';
    }

    return `https://www.instagram.com/${normalized}/`;
  } catch (error) {
    return '';
  }
};

const scheduleRequest = async (scheduler, fn) => {
  if (typeof scheduler === 'function') {
    return scheduler(fn);
  }
  return fn();
};

const buildFailureReason = (error) => {
  if (!error) return 'unknown_error';
  if (error.response?.status) {
    return `http_${error.response.status}`;
  }
  if (error.code) {
    return String(error.code);
  }
  return error.message ? String(error.message) : 'unknown_error';
};

export async function findInstagramProfile(websiteUrl, options = {}) {
  const { scheduler, timeoutMs = 10000, logger = console } = options;
  const normalizedWebsite = ensureAbsoluteUrl(websiteUrl);
  if (!normalizedWebsite) {
    return { url: '', status: 'not_found' };
  }

  const request = () =>
    axios.get(normalizedWebsite, {
      responseType: 'text',
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: defaultHeaders
    });

  let response;
  try {
    response = await scheduleRequest(scheduler, request);
  } catch (error) {
    logger?.warn?.(
      `[instagram] Failed to fetch website ${normalizedWebsite}: ${error?.message || error}`
    );
    return { url: '', status: 'error', reason: buildFailureReason(error) };
  }

  const html = typeof response?.data === 'string' ? response.data : '';
  if (!html) {
    return { url: '', status: 'not_found' };
  }

  const matches = html.matchAll(instagramProfileRegex);
  for (const match of matches) {
    const candidate = normalizeInstagramProfileUrl(match[0]);
    if (candidate) {
      return { url: candidate, status: 'found' };
    }
  }

  return { url: '', status: 'not_found' };
}

export default findInstagramProfile;
