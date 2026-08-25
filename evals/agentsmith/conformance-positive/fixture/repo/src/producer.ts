export function loadUrl(): string | undefined {
  return process.env.SERVICE_URL || undefined;
}
