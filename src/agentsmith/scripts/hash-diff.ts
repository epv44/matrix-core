import crypto from "node:crypto";

export interface HashDiffOptions {
  diff: string;
  config?: string;
}

export function hashDiff(opts: HashDiffOptions): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ diff: opts.diff, config: opts.config ?? "" }))
    .digest("hex");
}
