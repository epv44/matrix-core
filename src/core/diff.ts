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
