import { sha256Json } from "../../core/hash.js";

export interface HashDiffOptions {
  diff: string;
  config?: string;
}

export function hashDiff(opts: HashDiffOptions): string {
  return sha256Json({ diff: opts.diff, config: opts.config ?? "" });
}
