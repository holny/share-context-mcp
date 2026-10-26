/**
 * Public barrel of @share-context-mcp/protocol.
 * Crypto primitives (E2E) + claim schema (validation, idempotency).
 */
export {
  deriveChannelKey,
  seal,
  open,
  hmacProof,
  type SealedEnvelope,
} from "./crypto";
export {
  CLAIM_KINDS,
  LIMITS,
  CREDENTIAL_PATTERNS,
  idempotencyKey,
  validateClaim,
  type ClaimKind,
  type ClaimMessage,
  type ClaimProvenance,
  type ClaimSource,
  type CredentialPattern,
  type ValidateResult,
} from "./schema";
