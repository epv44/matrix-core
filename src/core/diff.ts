export interface ChangedRange {
  file: string;
  start: number;
  end: number;
}

export function parseChangedRanges(diff: string): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    const diffHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffHeader) file = diffHeader[2];
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) file = header[1];
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!file || !hunk) continue;
    const newCount = Number(hunk[4] ?? 1);
    const useOldSide = newCount === 0;
    const start = Number(useOldSide ? hunk[1] : hunk[3]);
    const count = Number(useOldSide ? (hunk[2] ?? 1) : newCount);
    ranges.push({ file, start, end: Math.max(start, start + count - 1) });
  }
  return ranges;
}

/**
 * Return exact post-image lines introduced by a patch. Unlike
 * parseChangedRanges, context lines in a unified-diff hunk are excluded.
 * Pure deletion hunks intentionally have no post-image changed lines.
 */
export function parseAddedLineRanges(diff: string): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  let file: string | undefined;
  let newLine: number | undefined;
  let pending: ChangedRange | undefined;
  const flush = () => {
    if (pending) ranges.push(pending);
    pending = undefined;
  };
  for (const line of diff.split("\n")) {
    const diffHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffHeader) {
      flush();
      file = diffHeader[2];
      newLine = undefined;
      continue;
    }
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      flush();
      file = header[1];
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      flush();
      newLine = Number(hunk[3]);
      continue;
    }
    if (!file || newLine === undefined) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (pending && pending.file === file && pending.end + 1 === newLine) pending.end = newLine;
      else {
        flush();
        pending = { file, start: newLine, end: newLine };
      }
      newLine++;
      continue;
    }
    flush();
    if (line.startsWith(" ")) newLine++;
    else if (!line.startsWith("-") && line !== "\\ No newline at end of file") newLine = undefined;
  }
  flush();
  return ranges;
}
