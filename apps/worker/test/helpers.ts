/// <reference types="node" />

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";

export function sqliteD1Binding(sqlite: DatabaseSync): D1Database {
  function prepare(query: string) {
    return {
      bind(...params: SQLInputValue[]) {
        function all() {
          const results = sqlite.prepare(query).all(...params);
          const changes = sqlite.prepare("SELECT changes() AS changes").get()?.changes;
          return { results, success: true, meta: { changes } };
        }
        return { all, run: all, raw: async () => all().results.map((row) => Object.values(row)) };
      },
    };
  }

  return {
    prepare,
    async batch(statements: ReturnType<ReturnType<typeof prepare>["bind"]>[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.all());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

export function applyMigrations(
  sqlite: DatabaseSync,
  files: readonly string[] = ["0001_slice1.sql", "0002_slice2.sql", "0003_slice3.sql", "0004_slice4_5.sql"],
) {
  for (const migration of files) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
}

export function createMemoryKv(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number; metadata?: unknown }>();
  function isExpired(entry: { expiration?: number }): boolean {
    return entry.expiration !== undefined && Date.now() / 1000 >= entry.expiration;
  }
  return {
    async get(key: string, typeOrOptions?: string | { type?: string }) {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) {
        store.delete(key);
        return null;
      }
      const mode = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
      if (mode === "json") return JSON.parse(entry.value) as unknown;
      if (mode === "arrayBuffer") return new TextEncoder().encode(entry.value).buffer;
      return entry.value;
    },
    async put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
      const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
      const expiration = options?.expiration ?? (options?.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : undefined);
      store.set(key, { value: text, expiration, metadata: options?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      const keys = [...store.entries()]
        .filter(([k, v]) => k.startsWith(prefix) && !isExpired(v))
        .map(([name, v]) => ({ name, expiration: v.expiration, metadata: v.metadata }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

export function createMemoryR2(): R2Bucket & { objects: Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }> } {
  const objects = new Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  return {
    objects,
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions) {
      let bytes: Uint8Array;
      if (value === null) bytes = new Uint8Array();
      else if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      else bytes = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, {
        bytes: new Uint8Array(bytes),
        httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
        customMetadata: options?.customMetadata,
      });
      return { key, size: bytes.byteLength } as R2Object;
    },
    async get(key: string) {
      const found = objects.get(key);
      if (!found) return null;
      return {
        key,
        size: found.bytes.byteLength,
        httpMetadata: found.httpMetadata,
        customMetadata: found.customMetadata,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(found.bytes);
            controller.close();
          },
        }),
        async arrayBuffer() {
          return found.bytes.buffer.slice(found.bytes.byteOffset, found.bytes.byteOffset + found.bytes.byteLength);
        },
      } as unknown as R2ObjectBody;
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) objects.delete(key);
    },
  } as unknown as R2Bucket & { objects: Map<string, { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }> };
}

export function createTestEnv(sqlite: DatabaseSync, overrides: Partial<Env> = {}): Env {
  return {
    DB: sqliteD1Binding(sqlite),
    OAUTH_KV: createMemoryKv(),
    RECEIPTS_BUCKET: createMemoryR2(),
    ENVIRONMENT: "production",
    AUTH_DEV_IDENTITIES: "false",
    LINE_LOGIN_CHANNEL_ID: "",
    LINE_LOGIN_CHANNEL_SECRET: "",
    LINE_LIFF_ID: "",
    COOKIE_ENCRYPTION_KEY: "",
    MCP_ALLOWED_EMAILS: "",
    PUBLIC_BASE_URL: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    ...overrides,
  } as Env;
}
