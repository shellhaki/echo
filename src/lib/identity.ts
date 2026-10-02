// Stateless identity helpers (no database needed).
//
// - Web users get an anonymous signed cookie ("web:<uuid>").
// - Telegram's /link command issues a short-lived signed code. Redeeming it on
//   the web or in the CLI switches that client to the Telegram identity, so
//   all three channels share one memory.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const LINK_TTL_MS = 15 * 60 * 1000;

function mac(value: string, len = 32): string {
  return createHmac("sha256", env.userIdSalt).update(value).digest("hex").slice(0, len);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function newAnonUser(): string {
  return `web:${randomUUID()}`;
}

/** Cookie value: "<userKey>.<mac>" */
export function signUser(user: string): string {
  return `${user}.${mac(user)}`;
}

export function verifyUser(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const user = token.slice(0, i);
  return safeEqual(token.slice(i + 1), mac(user)) ? user : null;
}

/** Code like "WB-12345678-lr3k9x-1a2b3c4d5e6f" for Telegram user 12345678. */
export function makeLinkCode(telegramId: number): string {
  const body = `${telegramId}-${Date.now().toString(36)}`;
  return `WB-${body}-${mac(`link:${body}`, 12)}`;
}

export function redeemLinkCode(code: string): string | null {
  const m = code.trim().match(/^WB-(\d+)-([a-z0-9]+)-([a-f0-9]{12})$/i);
  if (!m) return null;
  const body = `${m[1]}-${m[2]}`;
  if (!safeEqual(m[3].toLowerCase(), mac(`link:${body}`, 12))) return null;
  if (Date.now() - parseInt(m[2], 36) > LINK_TTL_MS) return null;
  return `tg:${m[1]}`;
}
