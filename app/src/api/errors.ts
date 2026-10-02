export class HttpError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body?.error ?? `HTTP ${status}`));
  }
}
