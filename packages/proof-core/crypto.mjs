import { canonicalBytes } from "./canonical.mjs";
import { base64UrlToBytes, bytesToBase64Url } from "./encoding.mjs";

export const SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256";
const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" };

export async function generateSigningKey(extractable = false) {
  return crypto.subtle.generateKey(ECDSA_PARAMS, extractable, ["sign", "verify"]);
}

export async function exportPublicJwk(publicKey) {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return normalizePublicJwk(jwk);
}

export function normalizePublicJwk(jwk) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TypeError("Expected a P-256 public JWK");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true, key_ops: ["verify"] };
}

export async function importPublicJwk(jwk) {
  return crypto.subtle.importKey("jwk", normalizePublicJwk(jwk), ECDSA_PARAMS, true, ["verify"]);
}

export async function importPrivateJwk(jwk, extractable = false) {
  return crypto.subtle.importKey("jwk", jwk, ECDSA_PARAMS, extractable, ["sign"]);
}

export async function signObject(privateKey, value) {
  const signature = await crypto.subtle.sign(SIGN_PARAMS, privateKey, canonicalBytes(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyObject(publicJwk, value, signature) {
  try {
    const key = await importPublicJwk(publicJwk);
    return await crypto.subtle.verify(SIGN_PARAMS, key, base64UrlToBytes(signature), canonicalBytes(value));
  } catch {
    return false;
  }
}

export async function sha256Base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function objectDigest(value) {
  return sha256Base64Url(canonicalBytes(value));
}

export async function publicKeyId(jwk) {
  const normalized = normalizePublicJwk(jwk);
  return `p256:${await objectDigest({ crv: normalized.crv, kty: normalized.kty, x: normalized.x, y: normalized.y })}`;
}
