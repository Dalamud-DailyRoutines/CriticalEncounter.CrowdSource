import type { Env } from "./models";
import { jsonError, readBody } from "./validation";

const SESSION_COOKIE = "ce_session";
const SESSION_TTL_SECONDS = 43_200;
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

export async function handleSession(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET")
    return readSessionStatus(request, env);
  if (request.method !== "POST")
    return jsonError("method_not_allowed", 405);
  return createSession(request, env);
}

async function readSessionStatus(request: Request, env: Env): Promise<Response> {
  const verified = await hasValidSession(request, env, Math.floor(Date.now() / 1000));
  return Response.json({ verified, siteKey: env.TURNSTILE_SITE_KEY }, {
    headers: { "cache-control": "no-store" }
  });
}

async function createSession(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET_KEY) {
    console.error(JSON.stringify({ event: "turnstile.secret_missing" }));
    return jsonError("verification_unconfigured", 503);
  }

  const text = await readBody(request);
  if (text === undefined) return jsonError("payload_too_large", 413);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonError("invalid_json", 400);
  }

  const token = (payload as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.length === 0 || token.length > 2048)
    return jsonError("invalid_token", 400);

  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const remoteIP = request.headers.get("cf-connecting-ip");
  if (remoteIP) form.set("remoteip", remoteIP);

  let result: SiteverifyResponse;
  try {
    const response = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    result = await response.json<SiteverifyResponse>();
  } catch (error) {
    console.error(JSON.stringify({ event: "turnstile.siteverify_failed", error: String(error) }));
    return jsonError("verification_unavailable", 503);
  }

  if (!result.success) {
    console.warn(JSON.stringify({ event: "turnstile.rejected", codes: result["error-codes"] ?? [] }));
    return jsonError("verification_failed", 403);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const value = await signSession(env, expiresAt);
  return Response.json({ verified: true, expiresAt }, {
    headers: {
      "cache-control": "no-store",
      "set-cookie": `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
    }
  });
}

async function hasValidSession(request: Request, env: Env, now: number): Promise<boolean> {
  const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!value) return false;

  const separator = value.indexOf(".");
  if (separator <= 0) return false;
  const expiresAt = Number(value.slice(0, separator));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;

  const signature = fromBase64Url(value.slice(separator + 1));
  if (!signature) return false;

  const key = await importSessionKey(env);
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(String(expiresAt)));
}

async function signSession(env: Env, expiresAt: number): Promise<string> {
  const key = await importSessionKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(expiresAt)));
  return `${expiresAt}.${toBase64Url(new Uint8Array(signature))}`;
}

async function importSessionKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim();
  }
  return undefined;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes)
    binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}
