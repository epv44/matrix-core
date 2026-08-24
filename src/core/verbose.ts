import fs from "node:fs";
import path from "node:path";

const ENGINE_NAME = "matrix-core";

function isVerboseEnabled(): boolean {
  const value = process.env.MATRIXCORE_LOG ?? "";
  return value.toLowerCase() === "debug" || value.toLowerCase() === "verbose";
}

function verboseLogRoot(root: string): string {
  return path.join(root, ".quality", "verbose.log");
}

function appendVerboseLog(root: string, line: string): void {
  if (!isVerboseEnabled()) return;
  const full = `${new Date().toISOString()} [DEBUG] ${line}`;
  try {
    fs.mkdirSync(path.join(root, ".quality"), { recursive: true });
    fs.appendFileSync(verboseLogRoot(root), `${full}\n`);
  } catch {}
  try {
    console.debug(`[${ENGINE_NAME}] ${full}`);
  } catch {}
}

function verboseEnabled(): boolean {
  return isVerboseEnabled();
}

export { appendVerboseLog, verboseEnabled, verboseLogRoot };
