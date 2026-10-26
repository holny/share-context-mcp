/**
 * In-process fake S3 for deterministic S3Bridge tests (M3 Task 2).
 * Implements the exact REST surface the bridge uses:
 *   PUT  /{bucket}/{key}          (If-Match / If-None-Match conditional writes)
 *   GET  /{bucket}/{key}          → body + ETag
 *   GET  /{bucket}?list-type=2&prefix=&start-after=  → ListObjectsV2 XML
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

interface StoredObject {
  body: Uint8Array;
  etag: string;
}

export function startFakeS3(port: number): { stop: () => void; url: string } {
  const objects = new Map<string, StoredObject>();
  const etagOf = (body: Uint8Array) => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.slice(1).split("/"); // [bucket, ...key]
      const bucket = parts[0];
      const key = parts.slice(1).join("/");
      const body = new Uint8Array(await req.arrayBuffer());

      if (req.method === "PUT") {
        if (parts.length < 2 || !key) return new Response("no key", { status: 400 });
        const ifMatch = req.headers.get("if-match");
        const ifNoneMatch = req.headers.get("if-none-match");
        const storeKey = key;
        const existing = objects.get(storeKey);
        if (ifNoneMatch === "*" && existing) return new Response("Precondition Failed", { status: 412 });
        if (ifMatch && (!existing || existing.etag.replace(/"/g, "") !== ifMatch.replace(/"/g, ""))) {
          return new Response("Precondition Failed", { status: 412 });
        }
        const etag = etagOf(body);
        objects.set(storeKey, { body, etag });
        return new Response(null, { status: 200, headers: { etag } });
      }

      if (req.method === "GET") {
        if (!key) {
          // ListObjectsV2 (subset): prefix + start-after
          const listType = url.searchParams.get("list-type");
          if (listType !== "2") return new Response("bad list", { status: 400 });
          const prefix = url.searchParams.get("prefix") ?? "";
          const startAfter = url.searchParams.get("start-after") ?? "";
          const keys = [...objects.keys()]
            .filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter))
            .sort();
          const xml =
            `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult>\n` +
            keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("\n") +
            `\n</ListBucketResult>`;
          return new Response(xml, { headers: { "content-type": "application/xml" } });
        }
        const obj = objects.get(key);
        if (!obj) return new Response("NoSuchKey", { status: 404 });
        return new Response(obj.body as unknown as BodyInit, { headers: { etag: obj.etag } });
      }

      return new Response("method not allowed", { status: 405 });
    },
  });
  return { stop: () => server.stop(true), url: `http://127.0.0.1:${server.port}` };
}
