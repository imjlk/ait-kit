import { clientError, objectOrSelf } from "./toss-envelope";

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

  const supplied = [
    userKey !== undefined,
    tossUserKey !== undefined,
    anonKey !== undefined
  ].filter(Boolean).length;

  if (supplied === 0) {
    const invalidField = firstInvalidRecipientField(object);
    if (invalidField) {
      throw clientError(errorCode, `${errorContext}: ${invalidField.message}`, 400);
    }
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

  if (anonKey !== undefined) {
    return { kind: "anonymous", anonKey };
  }
  return { kind: "user", userKey: (userKey ?? tossUserKey) as string | number };
}

function recipientUserValue(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  return undefined;
}

function recipientAnonValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstInvalidRecipientField(object: Record<string, unknown>) {
  for (const field of ["userKey", "tossUserKey"] as const) {
    if (isPresent(object[field])) {
      return {
        message: `${field} must be a non-empty string or finite number`
      };
    }
  }
  if (isPresent(object.anonKey)) {
    return { message: "anonKey must be a non-empty string" };
  }
  return undefined;
}

function isPresent(value: unknown) {
  return value !== undefined && value !== null;
}
