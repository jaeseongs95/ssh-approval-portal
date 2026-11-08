import { get } from 'node:https';
import metadata from '../../../package.json' with { type: 'json' };

const RELEASE_API_URL = 'https://api.github.com/repos/jaeseongs95/ssh-approval-portal/releases/latest';
const RELEASES_PAGE_URL = 'https://github.com/jaeseongs95/ssh-approval-portal/releases';
const MAX_METADATA = 256 * 1024;
const DEADLINE_MS = 10000;
const CACHE_TTL_MS = 300000;
const REFRESH_COOLDOWN_MS = 10000;

export function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = /^v?(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/.exec(version.trim());
  if (!match) return null;
  return {
    normalized: `${match[1]}.${match[2]}.${match[3]}${match[4] ? '-' + match[4] : ''}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function compareSemver(a, b) {
  const left = parseSemver(a), right = parseSemver(b);
  if (!left || !right) return null;
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const l = left.prerelease[i], r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^[0-9]+$/.test(l), rn = /^[0-9]+$/.test(r);
    if (ln && rn) return Number(l) > Number(r) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

function fetchLatestRelease(request) {
  return new Promise((resolve, reject) => {
    let connection, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { connection?.destroy(); reject(error); } else resolve(value);
    };
    timer = setTimeout(() => finish(Error('Release check timed out')), DEADLINE_MS);
    timer.unref?.();
    try {
      connection = request(RELEASE_API_URL, {
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 16384,
        headers: {
          accept: 'application/vnd.github+json',
          'accept-encoding': 'identity',
          'user-agent': 'ssh-approval-portal/' + metadata.version,
        },
      }, response => {
        let bytes = 0, ended = false;
        const chunks = [];
        response.on('error', () => finish(Error('Release stream error')));
        response.on('aborted', () => finish(Error('Release stream aborted')));
        response.on('close', () => { if (!ended) finish(Error('Release stream closed')); });
        if (response.statusCode !== 200 || !/^application\/(?:vnd\.github\+)?json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '') || (response.headers['content-encoding'] ?? 'identity') !== 'identity') {
          response.destroy(); finish(Error('Release check HTTP ' + response.statusCode)); return;
        }
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_METADATA) { response.destroy(); finish(Error('Release payload too large')); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          ended = true;
          if (settled) return;
          try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
          catch { finish(Error('Invalid release JSON')); }
        });
      });
      connection.on('error', () => finish(Error('Release connection error')));
    } catch { finish(Error('Release request failed')); }
  });
}

function safeReleaseUrl(candidate) {
  if (typeof candidate !== 'string') return RELEASES_PAGE_URL;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.startsWith('/jaeseongs95/ssh-approval-portal/')) return parsed.href;
  } catch { /* fallback to canonical releases page */ }
  return RELEASES_PAGE_URL;
}

export function createPortalReleaseChecker({ currentVersion = metadata.version, request = get, now = Date.now } = {}) {
  const parsedCurrent = parseSemver(currentVersion);
  const current = parsedCurrent ? parsedCurrent.normalized : String(currentVersion);
  let cached = null, pending = null, lastFetchedAt = 0;

  const unavailableResult = checkedAt => Object.freeze({
    currentVersion: current,
    latestVersion: null,
    updateAvailable: false,
    status: 'unavailable',
    releaseUrl: RELEASES_PAGE_URL,
    publishedAt: null,
    checkedAt,
  });

  return {
    async check({ refresh = false } = {}) {
      const started = now();
      if (cached && (!refresh && started < cached.expiresAt || refresh && started - lastFetchedAt < REFRESH_COOLDOWN_MS)) {
        return cached.value;
      }
      if (pending) return pending;
      pending = fetchLatestRelease(request).then(payload => {
        const finished = now();
        lastFetchedAt = finished;
        const latestParsed = parseSemver(payload?.tag_name ?? payload?.name ?? '');
        if (!latestParsed || payload?.draft === true || payload?.prerelease === true) {
          const value = unavailableResult(finished);
          cached = { value, expiresAt: finished + Math.min(CACHE_TTL_MS, 60000) };
          return value;
        }
        const cmp = compareSemver(latestParsed.normalized, current);
        const status = cmp === null ? 'unavailable' : cmp > 0 ? 'update_available' : cmp < 0 ? 'ahead' : 'up_to_date';
        const publishedAt = typeof payload?.published_at === 'string' && !Number.isNaN(Date.parse(payload.published_at)) ? payload.published_at : null;
        const value = Object.freeze({
          currentVersion: current,
          latestVersion: latestParsed.normalized,
          updateAvailable: status === 'update_available',
          status,
          releaseUrl: safeReleaseUrl(payload?.html_url),
          publishedAt,
          checkedAt: finished,
        });
        cached = { value, expiresAt: finished + CACHE_TTL_MS };
        return value;
      }).catch(() => {
        const finished = now();
        lastFetchedAt = finished;
        const value = unavailableResult(finished);
        cached = { value, expiresAt: finished + Math.min(CACHE_TTL_MS, 60000) };
        return value;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
