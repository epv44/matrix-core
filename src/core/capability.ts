import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Capability, QualityConfig } from "./types.js";

type Detected = { found: boolean; version?: string; path?: string };

function trySpawn(bin: string, args: string[]): Detected {
  try {
    const res = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });
    if (res.error) return { found: false };
    const out = (res.stdout || "") + (res.stderr || "");
    const firstLine = out.split("\n")[0]?.trim() || "";
    const versionMatch = out.match(/(\d+\.\d+[\.\d]*)/);
    return { found: res.status !== null, version: versionMatch?.[1] || firstLine.slice(0, 100), path: bin };
  } catch {
    return { found: false };
  }
}

function which(bin: string): string | undefined {
  const check = process.platform === "win32" ? `where ${bin}` : `which ${bin}`;
  try {
    const res = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8", timeout: 3000 });
    if (res.status === 0) {
      const p = res.stdout.trim().split("\n")[0]?.trim();
      return p || undefined;
    }
  } catch {}
  return undefined;
}

function detectBinary(names: string[], versionArgs: string[]): Detected {
  for (const n of names) {
    const p = which(n);
    if (p) {
      const ver = trySpawn(n, versionArgs);
      return { found: true, version: ver.version, path: p };
    }
    const direct = trySpawn(n, versionArgs);
    if (direct.found) return { ...direct, path: n };
  }
  return { found: false };
}

function detectPython(): Detected {
  const candidates = ["python3", "python"];
  for (const c of candidates) {
    const r = trySpawn(c, ["--version"]);
    if (r.found) {
      const p = which(c);
      return { found: true, version: r.version, path: p || c };
    }
  }
  return { found: false };
}

function detectPytestCov(): Detected {
  const py = detectPython();
  if (py.found) {
    const bin = py.path || "python3";
    const check = spawnSync(bin, ["-c", "import pytest_cov; print(pytest_cov.__version__)"], { encoding: "utf8", timeout: 3000 });
    if (check.status === 0) {
      return { found: true, version: check.stdout.trim(), path: `${bin} -m pytest_cov` };
    }
    const pipCheck = spawnSync(bin, ["-m", "pip", "show", "pytest-cov"], { encoding: "utf8", timeout: 3000 });
    if (pipCheck.status === 0 && pipCheck.stdout.includes("pytest-cov")) {
      return { found: true, version: "found via pip", path: bin };
    }
  }
  const direct = trySpawn("pytest", ["--version"]);
  if (direct.found) {
    const combined = (direct.version || "") + "";
    if (combined.toLowerCase().includes("cov") || direct.version?.includes("cov")) {
      return direct;
    }
  }
  return { found: false };
}

const HINTS: Record<string, string> = {
  python: "Install python3 from python.org or via brew/apt",
  ruff: "pip install ruff or brew install ruff",
  mypy: "pip install mypy",
  pytest: "pip install pytest",
  coverage: "pip install pytest-cov or coverage",
  git: "Install git from git-scm.com",
  node: "Install node.js from nodejs.org",
};

export function detectAll(config?: QualityConfig): Capability[] {
  const checks = config?.checks || {};
  const getReq = (name: string, def: boolean) => checks[name]?.required ?? def;

  const detections: Capability[] = [];

  const nodeDet = detectBinary(["node"], ["--version"]);
  detections.push({ name: "node", found: nodeDet.found, version: nodeDet.version, path: nodeDet.path, required: true, hint: HINTS.node });

  const gitDet = detectBinary(["git"], ["--version"]);
  detections.push({ name: "git", found: gitDet.found, version: gitDet.version, path: gitDet.path, required: false, hint: HINTS.git });

  const pyDet = detectPython();
  detections.push({ name: "python", found: pyDet.found, version: pyDet.version, path: pyDet.path, required: true, hint: HINTS.python });

  const ruffDet = detectBinary(["ruff"], ["--version"]);
  detections.push({ name: "ruff", found: ruffDet.found, version: ruffDet.version, path: ruffDet.path, required: getReq("ruff", true), hint: HINTS.ruff });

  const mypyDet = detectBinary(["mypy"], ["--version"]);
  detections.push({ name: "mypy", found: mypyDet.found, version: mypyDet.version, path: mypyDet.path, required: getReq("mypy", false), hint: HINTS.mypy });

  const pytestDet = detectBinary(["pytest", "python3 -m pytest", "python -m pytest"], ["--version"]);
  const pytestReal = pytestDet.found ? pytestDet : detectBinary(["pytest"], ["--version"]);
  const pytestPyFallback = !pytestReal.found && pyDet.found ? trySpawn(pyDet.path || "python3", ["-m", "pytest", "--version"]) : { found: false } as Detected;
  const finalPytest = pytestReal.found ? pytestReal : pytestPyFallback.found ? { ...pytestPyFallback, path: `${pyDet.path} -m pytest` } : { found: false } as Detected;
  detections.push({ name: "pytest", found: finalPytest.found, version: finalPytest.version, path: finalPytest.path, required: getReq("pytest", true), hint: HINTS.pytest });

  const covDet = detectPytestCov();
  const coverageBin = detectBinary(["coverage"], ["--version"]);
  const finalCovFound = covDet.found || coverageBin.found;
  const finalCovVersion = covDet.version || coverageBin.version;
  const finalCovPath = covDet.path || coverageBin.path;
  detections.push({ name: "coverage", found: finalCovFound, version: finalCovVersion, path: finalCovPath, required: getReq("coverage", false), hint: HINTS.coverage });

  return detections;
}

export function detectMap(list: Capability[]): Map<string, Capability> {
  return new Map(list.map((c) => [c.name, c]));
}
