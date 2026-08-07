/**
 * models.dev metadata — the authoritative source for real context windows,
 * max output tokens, reasoning capability, and input modalities.
 *
 * NewAPI / one-api gateways do NOT expose context windows: the `/api/pricing`
 * `Pricing` struct carries only billing ratios (verified against upstream
 * source). So for accurate per-model context we consult the
 * community-maintained models.dev catalog instead of guessing from the model
 * name.
 *
 * The catalog is fetched (via `curl`, which honors system proxies + TLS
 * reliably — Node's global fetch does not) into a local cache file and read
 * synchronously at startup, so the hot path has zero network dependency.
 * Refresh with the `/newapi-refresh-meta` slash command.
 *
 * Lookup matches a gateway model name against models.dev by the id's
 * model-part (after the provider `/`) and by the display name, both
 * normalized: case-folded, `pool-` prefix stripped, and `.`, `_`, and spaces
 * treated as `-`. So `pool-glm-5.2`, `GLM-5.2`, `DeepSeek V4 Pro`, and
 * `deepseek-v4-flash-0731` all resolve to their canonical entries.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const MODELS_DEV_URL = "https://models.dev/models.json";

export interface ModelsDevEntry {
  id: string;
  name?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
}

/** Resolved, pi-shaped metadata for a single model, sourced from models.dev. */
export interface ModelsDevMeta {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  /** True for embedding / non-chat models — caller should skip registering them. */
  embedding?: boolean;
}

type Catalog = Record<string, ModelsDevEntry>;
interface Index {
  byIdPart: Map<string, ModelsDevEntry>;
  byName: Map<string, ModelsDevEntry>;
}

/** Resolve the pi agent config directory, honoring PI_CODING_AGENT_DIR override. */
export function agentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return join(homedir(), ".pi", "agent");
}
const CACHE_PATH = join(agentDir(), "modelsdev-cache.json");

/**
 * Shipped, read-only models.dev snapshot bundled with the extension. This is
 * the zero-network baseline: accurate context windows out of the box, with no
 * fetch required. `/newapi-refresh-meta` writes to the per-user agent cache
 * (CACHE_PATH) above, never here, so the snapshot stays a clean shipped
 * resource and survives reinstalls / `git pull`.
 */
const MODULE_DIR = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
})();
const SNAPSHOT_PATH = MODULE_DIR ? join(MODULE_DIR, "models.dev.snapshot.json") : "";

let indexCache: Index | null = null;
let activeSource: "cache" | "snapshot" | null = null;

/** Normalize a model name for matching: lowercase, strip `pool-`, fold separators to `-`. */
function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/^pool-/, "")
    .replace(/[\s_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function readCatalogFile(p: string): Catalog | undefined {
  try {
    if (!p || !existsSync(p)) return undefined;
    const c = JSON.parse(readFileSync(p, "utf-8"));
    // Reject arrays / non-objects so a malformed cache can't crash buildIndex.
    if (!c || typeof c !== "object" || Array.isArray(c)) return undefined;
    return c as Catalog;
  } catch {
    return undefined;
  }
}

function loadCatalog(): { catalog: Catalog; source: "cache" | "snapshot" } | undefined {
  // 1. Per-user agent cache — the result of /newapi-refresh-meta. Always
  //    wins when present (it is at least as recent as the shipped snapshot).
  const cache = readCatalogFile(CACHE_PATH);
  if (cache) return { catalog: cache, source: "cache" };
  // 2. Shipped read-only snapshot — zero-network baseline, no fetch needed.
  const snapshot = readCatalogFile(SNAPSHOT_PATH);
  if (snapshot) return { catalog: snapshot, source: "snapshot" };
  return undefined;
}

function buildIndex(catalog: Catalog): Index {
  const byIdPart = new Map<string, ModelsDevEntry>();
  const byName = new Map<string, ModelsDevEntry>();
  for (const v of Object.values(catalog)) {
    // Skip malformed entries so a single bad row can't poison the whole index.
    if (!v || typeof v.id !== "string") continue;
    const idKey = norm(v.id.split("/").slice(1).join("/"));
    if (idKey && !byIdPart.has(idKey)) byIdPart.set(idKey, v);
    if (v.name) {
      const nameKey = norm(v.name);
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, v);
    }
  }
  return { byIdPart, byName };
}

function getIndex(): Index | null {
  if (indexCache) return indexCache;
  const r = loadCatalog();
  if (!r) return null;
  indexCache = buildIndex(r.catalog);
  activeSource = r.source;
  return indexCache;
}

/** Allow tests / reload to reset the in-memory index. */
export function resetModelsDevCache(): void {
  indexCache = null;
  activeSource = null;
}

/** Path of the per-user agent cache file (written by /newapi-refresh-meta). */
export function cachePath(): string {
  return CACHE_PATH;
}

/** Path of the shipped read-only snapshot bundled with the extension. */
export function snapshotPath(): string {
  return SNAPSHOT_PATH || "(unresolved)";
}

/** Which catalog the in-memory index was built from: "cache" | "snapshot" | null. */
export function activeCatalogSource(): "cache" | "snapshot" | null {
  getIndex();
  return activeSource;
}

/** Look up models.dev metadata for a gateway model name. */
export function lookupModel(modelName: string): ModelsDevMeta | undefined {
  const idx = getIndex();
  if (!idx) return undefined;
  const n = norm(modelName);
  const e = idx.byIdPart.get(n) ?? idx.byName.get(n);
  if (!e) return undefined;

  const ctx = e.limit?.context;
  const out = e.limit?.output;
  const ins = e.modalities?.input ?? [];

  const input: ("text" | "image")[] = [];
  if (ins.includes("text")) input.push("text");
  // pi only distinguishes text|image; treat image / video / pdf as vision input.
  if (ins.some((m) => m === "image" || m === "video" || m === "pdf")) input.push("image");

  const embedding =
    /embedding/i.test(modelName) ||
    /embedding/i.test(e.id) ||
    (typeof out === "number" && out <= 1);

  return {
    contextWindow: typeof ctx === "number" && ctx > 0 ? ctx : undefined,
    maxTokens: typeof out === "number" && out > 0 ? out : undefined,
    reasoning: e.reasoning,
    input: input.length ? input : undefined,
    embedding,
  };
}

const PROXY_ENV = [
  "MODELS_DEV_PROXY",
  "MODELSDEV_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/** Resolve a proxy URL from the environment (caller may override with an explicit arg). */
export function resolveProxy(): string | undefined {
  for (const name of PROXY_ENV) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

export function cacheExists(): boolean {
  return existsSync(CACHE_PATH);
}

export interface RefreshResult {
  ok: boolean;
  count?: number;
  error?: string;
}

/**
 * Re-fetch models.dev/models.json via `curl` (handles system proxy + TLS) and
 * write it to the per-user agent cache (never the shipped read-only snapshot).
 * `proxyOverride`, if given, is passed to curl as `--proxy`; otherwise the
 * resolved env proxy is used; if no proxy is set the request is direct (works
 * when models.dev is reachable).
 */
export async function refreshModelsDev(proxyOverride?: string): Promise<RefreshResult> {
  const proxy = proxyOverride ?? resolveProxy();
  const args = ["-sL", "-m", "90", "-H", "Accept: application/json"];
  if (proxy) args.push("--proxy", proxy);
  args.push(MODELS_DEV_URL);
  try {
    const { stdout } = await execFileP("curl", args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 100_000,
      windowsHide: true,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { ok: false, error: "models.dev returned non-JSON (curl available?)" };
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "models.dev returned an empty response" };
    }
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(CACHE_PATH, stdout, "utf-8");
    resetModelsDevCache();
    const count = Object.keys(parsed as Record<string, unknown>).length;
    return { ok: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|command not found/i.test(msg)) {
      return { ok: false, error: "curl not found on PATH — install curl to refresh models.dev metadata" };
    }
    return { ok: false, error: msg };
  }
}
