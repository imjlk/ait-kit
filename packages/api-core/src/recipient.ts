import { clientError, objectOrSelf } from "./toss-envelope.js";

/**
 * A message recipient, normalized to exactly one identifier kind.
 *
 * `userKey`/`tossUserKey` inputs both map to `kind: "user"`; the official
 * messenger APIs accept a single user identifier header (or body field for
 * bulk sends) and an anonymous identifier. Values pass through unchanged —
 * the kit never adds, strips, or normalizes caller-side key prefixes.
 */
export type MessageRecipient =
  | { kind: "user"; userKey: string | number }
  | { kind: "anonymous"; anonKey: string };

/**
 * Normalizes legacy `{ userKey, tossUserKey, anonKey }` inputs into a single
 * {@link MessageRecipient}.
 *
 * Exactly one identifier must be supplied: requests with none, or with more
 * than one, are rejected instead of silently picking a winner, and values of
 * the wrong type or empty/whitespace-only strings are rejected rather than
 * being treated as absent. Callers pass the site-specific error code
 * (`INVALID_MESSAGE_RECIPIENT` for single sends, `INVALID_CONTEXT_RECIPIENT`
 * for bulk `contextList` items) so existing error handling keeps working.
 */
export function normalizeMessageRecipient(
  input: unknown,
  errorCode: string,
  errorContext: string
): MessageRecipient {
  const object = objectOrSelf(input, {});
  const userKey = recipientUserValue(object.userKey);
  const tossUserKey = recipientUserValue(object.tossUserKey);
  const anonKey = recipientAnonValue(object.anonKey);

  // Count fields that were supplied at all — not just ones that parsed — so a
  // malformed extra identifier next to a valid one is still rejected instead
  // of being silently discarded.
  const supplied = [
    isPresent(object.userKey),
    isPresent(object.tossUserKey),
    isPresent(object.anonKey)
  ].filter(Boolean).length;

  if (supplied === 0) {
    throw clientError(
      errorCode,
      `${errorContext} must include exactly one of userKey, tossUserKey, or anonKey`,
      400
    );
  }

  if (supplied > 1) {
    throw clientError(
      errorCode,
      `${errorContext} must include at most one of userKey, tossUserKey, or anonKey`,
      400
    );
  }

  if (isPresent(object.anonKey)) {
    if (anonKey === undefined) {
      throw invalidRecipientValue(errorCode, errorContext, "anonKey must be a non-empty string");
    }
    return { kind: "anonymous", anonKey };
  }

  const userValue = userKey ?? tossUserKey;
  if (userValue === undefined) {
    const field = isPresent(object.userKey) ? "userKey" : "tossUserKey";
    throw invalidRecipientValue(
      errorCode,
      errorContext,
      `${field} must be a non-empty string or safe integer`
    );
  }
  return { kind: "user", userKey: userValue };
}

function invalidRecipientValue(errorCode: string, errorContext: string, message: string) {
  return clientError(errorCode, `${errorContext}: ${message}`, 400);
}

/**
 * Converts a recipient into the request headers the server APIs expect
 * (`x-toss-user-key` for users, `x-anon-key` for anonymous recipients).
 * Values pass through byte-for-byte.
 */
export function recipientIdentifierHeaders(recipient: MessageRecipient): Record<string, string> {
  return recipient.kind === "user"
    ? { "x-toss-user-key": String(recipient.userKey) }
    : { "x-anon-key": recipient.anonKey };
}

function recipientUserValue(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  return undefined;
}

function recipientAnonValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isPresent(value: unknown) {
  return value !== undefined && value !== null;
}

/** Scrub only provider/transport prose; never rewrite codes or correlation keys. */
export function redactRecipientFailureReason(reason: string, recipient: MessageRecipient): string {
  const value = String(recipient.kind === "user" ? recipient.userKey : recipient.anonKey);
  // Some transports/providers trim header whitespace. Suppress the entire
  // message, including for one-character IDs, instead of rewriting fragments.
  // Malformed resultType evidence is uppercased by the promotion parser
  // before being included in failure prose; cover that spelling too.
  const identifiers = [value, value.trim()].filter(Boolean)
    .flatMap((identifier) => [identifier, identifier.toUpperCase()]);
  return identifiers.some((identifier) => reason.includes(identifier)) ? "[redacted]" : reason;
}
