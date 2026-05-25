import { discoverChromiumProfiles, loadChromiumCookies } from "./chromium.js";
import { discoverFirefoxProfiles, loadFirefoxCookies } from "./firefox.js";
import type {
  BrowserCookie,
  BrowserProfile,
  BrowserSession,
  WebsearchBrowserFamily,
  WebsearchConfig,
} from "../types.js";

const COOKIE_CACHE_TTL_MS = 30_000;
const cookieCache = new Map<string, { cookies: BrowserCookie[]; expiresAt: number }>();

export async function discoverProfiles(
  browserFamilies: WebsearchBrowserFamily[],
  preferredProfiles: WebsearchConfig["profiles"],
): Promise<BrowserProfile[]> {
  const profiles: BrowserProfile[] = [];

  for (const family of browserFamilies) {
    if (family === "firefox") {
      profiles.push(...(await discoverFirefoxProfiles(preferredProfiles.firefox)));
      continue;
    }

    profiles.push(...(await discoverChromiumProfiles(preferredProfiles.chromium)));
  }

  return profiles;
}

export async function loadCookies(profile: BrowserProfile): Promise<BrowserCookie[]> {
  const cacheKey = `${profile.family}:${profile.profilePath}`;
  const cached = cookieCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.cookies;
  if (cached) cookieCache.delete(cacheKey);

  const cookies =
    profile.family === "firefox"
      ? await loadFirefoxCookies(profile)
      : await loadChromiumCookies(profile);

  if (cookies.length > 0) {
    cookieCache.set(cacheKey, {
      cookies,
      expiresAt: Date.now() + COOKIE_CACHE_TTL_MS,
    });
  }

  return cookies;
}

export async function createBrowserSession(
  profile: BrowserProfile,
  domains: string[],
): Promise<BrowserSession | null> {
  const cookies = (await loadCookies(profile)).filter((cookie) => {
    return domains.some((domain) => matchesBrowserDomain(domain, cookie.domain));
  });
  if (cookies.length === 0) return null;

  return {
    profile,
    cookies,
  };
}

function matchesBrowserDomain(requestedDomain: string, cookieDomain: string): boolean {
  const normalizedRequested = requestedDomain.toLowerCase().replace(/^\./, "");
  const normalizedCookie = cookieDomain.toLowerCase().replace(/^\./, "");

  return (
    normalizedCookie === normalizedRequested ||
    normalizedCookie.endsWith(`.${normalizedRequested}`) ||
    normalizedRequested.endsWith(`.${normalizedCookie}`)
  );
}
