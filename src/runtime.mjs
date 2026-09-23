import vm from "node:vm";
import { webcrypto } from "node:crypto";

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    for (const [k, v] of headers.entries()) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

function makeResponse(raw, bodyText, finalUrl, bodyDropped = false, dropReason = "") {
  const headers = normalizeHeaders(raw.headers);
  const body = bodyText ?? "";
  return {
    ok: raw.ok,
    status: raw.status,
    headers,
    body,
    finalUrl,
    bodyDropped,
    bodyBytes: Buffer.byteLength(body, "utf8"),
    dropReason,
    text: async () => body,
    json: async () => JSON.parse(body)
  };
}

export function createRuntime({ timeoutMs = 30000, maxResponseBytes = 5 * 1024 * 1024 } = {}) {
  const timers = new Map();
  let timerId = 0;

  // Request statistics for the host: modules often swallow network errors and
  // return empty results, so the host reports failed requests separately.
  const stats = { requests: 0, failures: [] };
  function recordFailure(url, status, reason = "") {
    if (stats.failures.length >= 20) return;
    let host = "";
    try { host = new URL(String(url)).host; } catch {}
    stats.failures.push({ host, status, reason });
  }

  async function fetchv2(url, headers = {}, method = "GET", body = null, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options?.timeoutMs ?? timeoutMs));
    stats.requests += 1;

    try {
      const init = {
        method: method || "GET",
        headers: headers || {},
        body: body == null ? undefined : body,
        redirect: options?.followRedirects === false ? "manual" : "follow",
        signal: controller.signal
      };

      let response;
      try {
        response = await fetch(String(url), init);
      } catch (error) {
        recordFailure(url, 0, error?.name === "AbortError" ? "timeout" : error?.cause?.code || error?.name || "error");
        throw error;
      }
      if (!response.ok && !(response.status >= 300 && response.status < 400)) recordFailure(url, response.status);
      const contentLength = Number(response.headers.get("content-length") || 0);

      // Read with a hard response cap rather than blindly buffering everything.
      if (contentLength > maxResponseBytes) {
        return makeResponse(response, "", response.url, true, "maxResponseBytes");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        return makeResponse(response, "", response.url);
      }

      const chunks = [];
      let total = 0;
      let dropped = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) {
          dropped = true;
          try { await reader.cancel(); } catch {}
          break;
        }
        chunks.push(Buffer.from(value));
      }

      if (dropped) {
        return makeResponse(response, "", response.url, true, "maxResponseBytes");
      }

      return makeResponse(response, Buffer.concat(chunks).toString("utf8"), response.url);
    } finally {
      clearTimeout(timeout);
    }
  }

  function hostSetTimeout(fn, ms, ...args) {
    const id = ++timerId;
    const handle = setTimeout(() => {
      timers.delete(id);
      try { fn(...args); } catch (e) { queueMicrotask(() => { throw e; }); }
    }, ms);
    timers.set(id, handle);
    return id;
  }

  function hostClearTimeout(id) {
    const handle = timers.get(id);
    if (handle) clearTimeout(handle);
    timers.delete(id);
  }

  const hostConsole = {
    log: (...args) => console.log("[module]", ...args),
    warn: (...args) => console.warn("[module]", ...args),
    error: (...args) => console.error("[module]", ...args)
  };

  const sandbox = {
    fetchv2,
    setTimeout: hostSetTimeout,
    clearTimeout: hostClearTimeout,
    console: hostConsole,

    // Standard Web/JS globals commonly used by modules.
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    AbortController,
    atob,
    btoa,
    crypto: webcrypto,

    // Common JS globals.
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    JSON,
    Math,
    Date,
    RegExp,
    Error,
    TypeError,
    String,
    Number,
    Boolean,
    Array,
    Object,
    parseInt,
    parseFloat,
    isNaN,
    Infinity,
    NaN
  };

  sandbox.globalThis = sandbox;
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;

  return { sandbox, vmContext: vm.createContext(sandbox), stats };
}

export async function loadModule(moduleDir) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const manifest = JSON.parse(await fs.readFile(path.join(moduleDir, "module.json"), "utf8"));

  if (manifest.contractVersion !== 4) {
    throw new Error(`Unsupported contractVersion: ${manifest.contractVersion}`);
  }

  const entry = manifest?.config?.runtime?.entry || "index.js";
  const code = await fs.readFile(path.join(moduleDir, entry), "utf8");
  const runtime = createRuntime({
    timeoutMs: manifest?.config?.caps?.timeoutMs ?? 30000,
    maxResponseBytes: manifest?.config?.caps?.maxResponseBytes ?? 5 * 1024 * 1024
  });

  const script = new vm.Script(`"use strict";\n${code}`, {
    filename: path.join(moduleDir, entry)
  });
  script.runInContext(runtime.vmContext);

  const exported = runtime.sandbox.module?.exports || {};
  const names = [
    "searchResults",
    "extractDetails",
    "extractEpisodes",
    "extractStreamUrl",
    "discoveryHome",
    "discoveryFeed",
    "extractHome",
    "extractFeed"
  ];

  // Prefer module.exports, then globalThis exports.
  for (const name of names) {
    if (typeof exported[name] !== "function" && typeof runtime.sandbox[name] === "function") {
      exported[name] = runtime.sandbox[name];
    }
  }

  return { manifest, exported, runtime };
}
