// fetch() over a plain HTTP/1.1 pool. Under Next.js on Node 26 the global
// fetch reuses dead HTTP/2 sessions to some hosts (ERR_HTTP2_INVALID_SESSION),
// so outbound calls we make ourselves go through this instead.

import { Agent, fetch as undiciFetch } from "undici";

const dispatcher = new Agent({ allowH2: false });

export function httpFetch(url: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  return undiciFetch(url, { ...init, dispatcher });
}
