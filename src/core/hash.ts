import crypto from "node:crypto";

export function sha256(value: string | Buffer, length?: number): string {
  const digest = crypto.createHash("sha256").update(value).digest("hex");
  return length === undefined ? digest : digest.slice(0, length);
}

export function sha256Json(value: unknown, length?: number): string {
  return sha256(JSON.stringify(value), length);
}
