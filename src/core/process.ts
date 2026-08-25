import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isMainModule(moduleUrl: string, executable = process.argv[1]): boolean {
  if (!executable) return false;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(path.resolve(executable));
  } catch {
    return false;
  }
}
