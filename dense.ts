/**
 * GAP-4b Phase-2 — dense (semantic) retrieval module (#10060808).
 *
 * The FIRST permanent ML dependency in the task-board. It AUGMENTS the shipped
 * BM25/FTS5 recall() — it NEVER replaces it:
 *   - Feature-flagged OFF by default (`TASKBOARD_DENSE_RECALL`). Flag OFF ⇒ this
 *     module is never imported at runtime (the dense path dynamic-imports
 *     `fastembed` only when enabled), so a flag-OFF server has ZERO ML cost and
 *     byte-identical behavior to today.
 *   - ANY failure (model load, embed, missing vectors) degrades silently to the
 *     existing BM25 path — recall can never break because of dense.
 *
 * Reproduces Kiera's validated dense arm (#10060807 / arms_dense.py), proven to
 * match MRR@3=0.7976 / recall@10=1.0 on the frozen brand eval:
 *   - model BAAI/bge-small-en-v1.5, INT8-quantized ONNX (qdrant onnx-q
 *     model_optimized.onnx), 384-dim, via fastembed-js (onnxruntime-node, CPU).
 *   - content truncated to 2000 chars, plain embed() (NO bge query-instruction
 *     prefix), L2-normalized; cosine == dot of normalized vectors.
 *   - deterministic tiebreak (-score, id); brute-force search (NO ANN — the
 *     in-scope candidate set is ≤ a few hundred; search is sub-ms-to-ms).
 *
 * NOTE: all `fastembed` access is behind a dynamic import inside getEmbedder()
 * so this file (and the server) load fine even if `fastembed` is absent or the
 * flag is OFF.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { DB_PATH } from './config'

export const DENSE_FLAG_ENV = 'TASKBOARD_DENSE_RECALL'
export const DENSE_MODE_ENV = 'TASKBOARD_DENSE_MODE' // 'rrf' (default, augment) | 'dense'
export const DENSE_MODEL_ID = 'BAAI/bge-small-en-v1.5'
export const DENSE_DIM = 384
export const DENSE_TRUNC_CHARS = 2000
export const DENSE_RRF_K = 60

/**
 * Memoized read of the task-board server's env block from the on-disk mcp.json —
 * the authoritative, operator/Boss-gated source of truth. Located module-relatively
 * (next to the DB, which is anchored on $HOME — NOT cwd), so this is cwd-independent.
 * Read ONCE and cached: a /mcp reconnect respawns the module (fresh code → fresh
 * cache), which is exactly the intended deploy boundary. Fail-safe: any missing or
 * invalid mcp.json yields an empty env (today's safe defaults).
 */
let _mcpEnv: Record<string, string> | null = null
function mcpJsonEnv(): Record<string, string> {
  if (_mcpEnv !== null) return _mcpEnv
  _mcpEnv = {}
  try {
    const cfg = JSON.parse(readFileSync(join(dirname(DB_PATH), 'mcp.json'), 'utf-8'))
    const env = cfg?.mcpServers?.['task-board']?.env
    if (env && typeof env === 'object') _mcpEnv = env as Record<string, string>
  } catch {
    /* no/invalid mcp.json → empty env (safe default, byte-identical to pre-fix) */
  }
  return _mcpEnv
}

/**
 * Resolve a TASKBOARD_* setting with the #10060814 fallback chain:
 *   1. process.env[key] (non-empty) — primary (a /mcp reconnect's cached env, or a
 *      full-restart's fresh env). An explicit value here always wins.
 *   2. else the on-disk mcp.json task-board env block — authoritative config.
 *
 * Why the on-disk fallback: a Claude Code `/mcp` reconnect respawns FRESH CODE but
 * REUSES the cached env captured at SESSION-START. A session that started before a
 * setting was added to mcp.json would otherwise run without it (e.g. dense silently
 * OFF → pure BM25; the exact production symptom). Reading the authoritative on-disk
 * mcp.json as a fallback makes a cheap /mcp reconnect — not a heavyweight full
 * session restart — sufficient to pick the setting up.
 */
function resolveSetting(key: string): string | undefined {
  const fromEnv = process.env[key]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return mcpJsonEnv()[key]
}

/**
 * Dense recall is OFF unless explicitly enabled. Default OFF until validated +
 * Boss-gated deploy. Resolves TASKBOARD_DENSE_RECALL via resolveSetting (process env
 * first, else mcp.json). An explicit process-env 'off' still wins (force-disable),
 * since it is returned as a non-empty value and is simply not 'on'.
 */
export function isDenseEnabled(): boolean {
  return (resolveSetting(DENSE_FLAG_ENV) ?? '').toLowerCase() === 'on'
}

/**
 * Live blend mode. CODE DEFAULT is 'rrf' (augment: fuse BM25 ∪ dense, never replaces);
 * 'dense' = pure dense ranking (the validated arm). Resolves TASKBOARD_DENSE_MODE via
 * resolveSetting (process env first, else mcp.json), then falls back to the 'rrf' code
 * default. NOTE (#10060814): dense mode is turned on ONLY via config — the code default
 * intentionally stays 'rrf' (a later Option B may flip the code default to hybrid).
 */
export function denseMode(): 'rrf' | 'dense' {
  return (resolveSetting(DENSE_MODE_ENV) ?? 'rrf').toLowerCase() === 'dense' ? 'dense' : 'rrf'
}

/** Where the int8 ONNX model + tokenizer cache lives (next to the DB). Override via env. */
export function denseCacheDir(): string {
  return process.env.TASKBOARD_DENSE_CACHE_DIR ?? join(dirname(DB_PATH), '.fastembed_cache')
}

// ---- vector (de)serialization: 384 × float32 stored as a SQLite BLOB ----------

export function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

export function blobToVec(b: Uint8Array): Float32Array {
  // Copy into a fresh aligned buffer (SQLite blobs may not be 4-byte aligned).
  const copy = new Uint8Array(b.byteLength)
  copy.set(b)
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4)
}

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) + 1e-9
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

/** Cosine for already-L2-normalized vectors == dot product. */
export function cosineNormalized(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** Stable content fingerprint so the backfill can skip unchanged rows / re-embed changed ones. */
export function contentHash(content: string): string {
  return String(Bun.hash(content.slice(0, DENSE_TRUNC_CHARS)))
}

/**
 * Reciprocal Rank Fusion. Each input is an ordered id list (best first); the
 * fused order maximizes Σ 1/(k+rank). Deterministic tiebreak: higher fused
 * score first, then ascending id. AUGMENTATION primitive — every id in any
 * input list survives into the fused ranking (nothing is dropped before slice).
 */
export function rrfFuse(rankings: number[][], k: number = DENSE_RRF_K): number[] {
  const score = new Map<number, number>()
  for (const list of rankings) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1))
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id]) => id)
}

// ---- embedder (lazy, dynamic-imported; only loaded when dense is enabled) -----

type Embedder = { embed: (texts: string[], batch?: number) => AsyncGenerator<number[][]> }
let _embedderPromise: Promise<Embedder> | null = null

let _denseInitLogged = false
/** Lazy singleton fastembed embedder (int8 bge-small). Throws if fastembed/onnxruntime unavailable. */
export async function getEmbedder(): Promise<Embedder> {
  if (!_embedderPromise) {
    _embedderPromise = (async () => {
      // Dynamic import: a flag-OFF server never touches fastembed/onnxruntime-node.
      const { FlagEmbedding, EmbeddingModel } = (await import('fastembed')) as any
      const embedder = (await FlagEmbedding.init({
        model: EmbeddingModel.BGESmallENV15, // qdrant onnx-q int8 model_optimized.onnx, 384-dim
        cacheDir: denseCacheDir(),
        maxLength: 512,
        showDownloadProgress: false,
      })) as Embedder
      // One-time success breadcrumb on stderr (safe for stdio MCP) so future canaries
      // can confirm dense actually initialized rather than silently degrading.
      if (!_denseInitLogged) {
        _denseInitLogged = true
        console.error(`[task-board] dense init OK — ${DENSE_MODEL_ID}, cacheDir=${denseCacheDir()}`)
      }
      return embedder
    })().catch((err) => {
      _embedderPromise = null // allow retry on a later call
      // #10060814: NEVER swallow silently again. Surface the FULL reason dense
      // degraded to BM25 (this catch previously hid the only signal of a degrade).
      console.error(
        `[task-board] dense init FAILED — degrading to BM25 (cacheDir=${denseCacheDir()}, cwd=${process.cwd()}):\n`,
        (err as Error)?.stack ?? err,
      )
      throw err
    })
  }
  return _embedderPromise
}

// TEST-ONLY seam: lets unit tests inject a deterministic embedder so they never
// load onnxruntime/fastembed. null in production (the real fastembed path runs).
let _testEmbedder: ((texts: string[]) => Promise<Float32Array[]>) | null = null
export function __setTestEmbedder(fn: ((texts: string[]) => Promise<Float32Array[]>) | null): void {
  _testEmbedder = fn
}

/** Embed a batch of texts (truncated to 2000 chars, plain embed, L2-normalized). */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const trunc = texts.map((t) => (t ?? '').slice(0, DENSE_TRUNC_CHARS))
  if (_testEmbedder) return _testEmbedder(trunc)
  const embedder = await getEmbedder()
  const out: Float32Array[] = []
  for await (const batch of embedder.embed(trunc, 32)) {
    for (const e of batch) out.push(l2normalize(Float32Array.from(e as ArrayLike<number>)))
  }
  return out
}

/** Embed a single text → L2-normalized 384-dim vector. */
export async function embedOne(text: string): Promise<Float32Array> {
  const [v] = await embedTexts([text])
  if (!v) throw new Error('dense: embedder returned no vector')
  return v
}

// ---- vector store (memory_vectors table) --------------------------------------

/** Create the memory_vectors sidecar table (idempotent). Mirrors the FTS migration pattern. */
export function ensureVectorTable(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id    INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      dim          INTEGER NOT NULL,
      model        TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      vec          BLOB NOT NULL,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TRIGGER IF NOT EXISTS trg_memory_vectors_ad
    AFTER DELETE ON memories
    BEGIN
      DELETE FROM memory_vectors WHERE memory_id = old.id;
    END;
  `)
}

/** True if the memory_vectors table exists in this DB. */
export function vectorTableExists(db: any): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vectors'")
    .get() as { name: string } | undefined
  return !!row
}

export function vectorCount(db: any): number {
  if (!vectorTableExists(db)) return 0
  return (db.prepare('SELECT count(*) AS n FROM memory_vectors').get() as { n: number }).n
}

/** Load vectors for the given ids → Map<id, Float32Array> (ids without a stored vector are absent). */
export function getVectors(db: any, ids: number[]): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>()
  if (ids.length === 0 || !vectorTableExists(db)) return out
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const rows = db
      .prepare(`SELECT memory_id, vec FROM memory_vectors WHERE memory_id IN (${slice.map(() => '?').join(',')})`)
      .all(...slice) as Array<{ memory_id: number; vec: Uint8Array }>
    for (const r of rows) out.set(r.memory_id, blobToVec(r.vec))
  }
  return out
}

/** Write/replace one memory's vector (vector already L2-normalized). Sync DB write. */
export function putVector(db: any, id: number, vec: Float32Array, content: string): void {
  ensureVectorTable(db)
  db.prepare(
    `INSERT INTO memory_vectors (memory_id, dim, model, content_hash, vec, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(memory_id) DO UPDATE SET
       dim=excluded.dim, model=excluded.model, content_hash=excluded.content_hash,
       vec=excluded.vec, updated_at=excluded.updated_at`,
  ).run(id, vec.length, DENSE_MODEL_ID, contentHash(content), vecToBlob(vec))
}

/** Embed + store one memory's vector. async (embedding). Caller wraps in try/catch (never fail the write). */
export async function upsertVector(db: any, id: number, content: string): Promise<void> {
  const vec = await embedOne(content)
  putVector(db, id, vec, content)
}
