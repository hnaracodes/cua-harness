import { HttpError } from "../api/errors";

/** The user-facing reason for a failed call: C2 puts it in `body.error` for an HttpError. */
export const msg = (e: unknown): string =>
  e instanceof HttpError ? String(e.body.error ?? e.message) : e instanceof Error ? e.message : String(e);
