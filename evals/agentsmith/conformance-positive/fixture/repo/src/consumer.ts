import { loadUrl } from "./producer.js";

export function normalizedUrl(): string {
  return loadUrl().trim();
}
