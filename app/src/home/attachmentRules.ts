// Client-side mirror of the daemon's attachment rules (spec: Daemon API §1), so a bad
// file is rejected on its own chip before any upload. The daemon re-checks everything.
import type { Provider } from "../api/types";

export const MAX_ATTACHMENTS = 4;
export const MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;

export function validateImage(file: { type: string; size: number }, alreadyAttached: number): string | null {
  if (alreadyAttached >= MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} images per task.`;
  if (!(IMAGE_MIMES as readonly string[]).includes(file.type)) return `Unsupported type ${file.type || "unknown"}. Use PNG, JPEG or WebP.`;
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_BYTES) return "Images must be 5 MB or smaller.";
  return null;
}

export function providerLabel(p: Provider | string | null | undefined): "Anthropic" | "OpenAI" {
  return p === "openai" ? "OpenAI" : "Anthropic";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
