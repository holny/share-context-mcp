/**
 * Minimal AWS Signature V4 (SigV4) request signer for the S3 REST API —
 * node:crypto only, no AWS SDK (project zero-dependency rule, M3 §3.3).
 */
import { createHash, createHmac } from "node:crypto";

export interface SigV4Params {
  method: string;
  /** Full URL (endpoint + path + query). */
  url: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  body?: Uint8Array | string;
}

const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();

export function sigv4Headers(params: SigV4Params): Record<string, string> {
  const url = new URL(params.url);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(params.body ?? "");

  // Canonical URI: the URL path, URI-encoded once per segment (S3 style).
  const canonicalUri = url.pathname.split("/").map((seg) => encodeURIComponent(seg)).join("/") || "/";

  // Canonical query: sorted by key, each k=v URI-encoded.
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of url.searchParams.entries()) pairs.push([encodeURIComponent(k), encodeURIComponent(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join("&");

  const host = url.host;
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [params.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac("AWS4" + params.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, params.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Host: host,
  };
}
