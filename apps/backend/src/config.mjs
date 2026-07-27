import path from "node:path";

export function loadConfig(environment = process.env) {
  return {
    host: environment.TYPEPROOF_HOST || "127.0.0.1",
    port: parseInteger(environment.TYPEPROOF_PORT, 8787, 1, 65_535),
    dataDirectory: path.resolve(environment.TYPEPROOF_DATA_DIR || ".data"),
    challengeTtlMs: parseInteger(environment.TYPEPROOF_CHALLENGE_TTL_MS, 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    maxBodyBytes: parseInteger(environment.TYPEPROOF_MAX_BODY_BYTES, 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    publicBaseUrl: normalizePublicBaseUrl(environment.TYPEPROOF_PUBLIC_BASE_URL)
  };
}

function normalizePublicBaseUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("TYPEPROOF_PUBLIC_BASE_URL must use HTTPS, except on localhost");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("TYPEPROOF_PUBLIC_BASE_URL must be an origin without a path, query, credentials, or fragment");
  }
  return url.origin;
}

function parseInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid integer configuration value: ${value}`);
  }
  return parsed;
}
