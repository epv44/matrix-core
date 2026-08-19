import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Capability, QualityConfig } from "./types.js";
import type { LanguageSet } from "./language.js";

type Detected = { found: boolean; version?: string; path?: string };

function trySpawn(bin: string, args: string[], timeoutMs = 5000): Detected {
  try {
    const res = spawnSync(bin, args, { encoding: "utf8", timeout: timeoutMs });
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
    const candidates = [n, path.join(process.cwd(), "node_modules", ".bin", n), path.join(process.cwd(), ".bin", n)];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const ver = trySpawn(cand, versionArgs);
        if (ver.found) return { found: true, version: ver.version, path: cand };
      }
      const direct = trySpawn(cand, versionArgs);
      if (direct.found) return { ...direct, path: cand };
    }
  }
  return { found: false };
}

function detectPython(): Detected {
  for (const c of ["python3", "python"]) {
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
    const check = spawnSync(bin, ["-c", "import pytest_cov; print(pytest_cov.__version__)"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (check.status === 0) return { found: true, version: check.stdout.trim(), path: `${bin} -m pytest_cov` };
    const pipCheck = spawnSync(bin, ["-m", "pip", "show", "pytest-cov"], { encoding: "utf8", timeout: 3000 });
    if (pipCheck.status === 0 && pipCheck.stdout.includes("pytest-cov"))
      return { found: true, version: "found via pip", path: bin };
  }
  const direct = trySpawn("pytest", ["--version"]);
  if (direct.found) {
    if ((direct.version || "").toLowerCase().includes("cov")) return direct;
  }
  return { found: false };
}

function detectNodeBin(name: string, root: string): Detected {
  const localPath = path.join(root, "node_modules", ".bin", name);
  if (fs.existsSync(localPath)) {
    const ver = trySpawn(localPath, ["--version"]);
    if (ver.found) return { found: true, version: ver.version, path: localPath };
    // try via npx
    const ver2 = trySpawn("npx", [name, "--version"]);
    if (ver2.found) return { found: true, version: ver2.version, path: `npx ${name}` };
    return { found: true, version: "found local", path: localPath };
  }
  const p = which(name);
  if (p) {
    const ver = trySpawn(name, ["--version"]);
    return { found: true, version: ver.version, path: p };
  }
  // no npx fallback: npx global resolution is slow (network) and optional node tools should be project-local
  return { found: false };
}

const CAP_CACHE = new Map<string, Capability[]>();

function cacheKey(root: string, config?: QualityConfig, languages?: LanguageSet): string {
  const sig = config ? JSON.stringify(config.checks || {}) : "default";
  const langSig = languages
    ? `${!!languages.python}${!!languages.typescript}${!!languages.go}${!!languages.rust}`
    : "all";
  return `${root}|${sig}|${langSig}`;
}

const HINTS: Record<string, string> = {
  python: "Install python3 from python.org or via brew/apt",
  ruff: "pip install ruff or brew install ruff",
  mypy: "pip install mypy",
  pytest: "pip install pytest",
  coverage: "pip install pytest-cov or coverage",
  xenon: "pip install xenon==0.9.3",
  deptry: "pip install deptry==0.25.1",
  sqlfluff: "pip install sqlfluff==4.2.2",
  git: "Install git from git-scm.com",
  node: "Install node.js from nodejs.org",
  typescript: "npm install -D typescript or brew? Actually npm i -D typescript",
  tsc: "npm install -D typescript",
  eslint: "npm install -D eslint",
  prettier: "npm install -D prettier",
  vitest: "npm install -D vitest",
  go: "Install go from golang.org",
  rustc: "Install Rust with rustup",
  cargo: "Install Rust with rustup",
  rustfmt: "rustup component add rustfmt",
  clippy: "rustup component add clippy",
  "golangci-lint":
    "brew install golangci-lint or go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest",
};

export function detectAll(config?: QualityConfig, root?: string, languages?: LanguageSet): Capability[] {
  const key = root ? cacheKey(root, config, languages) : "";
  if (key && CAP_CACHE.has(key)) return CAP_CACHE.get(key)!;
  const checks = config?.checks || {};
  const getReq = (name: string, def: boolean) => {
    if (checks[name]?.required !== undefined) return checks[name].required;
    // also check canonical alias resolution? we will also check alias via imported map in runner, but here fallback
    // try alias mapping manually for backward compat
    const aliasMap: Record<string, string[]> = {
      typescript: ["typescript.tsc", "tsc"],
      tsc: ["typescript.tsc"],
      eslint: ["typescript.eslint"],
      prettier: ["typescript.prettier"],
      vitest: ["typescript.vitest"],
      ruff: ["python.ruff"],
      mypy: ["python.mypy"],
      pytest: ["python.pytest"],
      xenon: ["python.xenon"],
      deptry: ["python.deptry"],
      sqlfluff: ["sql.sqlfluff"],
      go: ["go.test", "go.vet"],
      "golangci-lint": ["go.golangci"],
    };
    const alts = aliasMap[name] || [];
    for (const alt of alts) if (checks[alt]?.required !== undefined) return checks[alt].required;
    return def;
  };

  const caps: Capability[] = [];

  const nodeDet = detectBinary(["node"], ["--version"]);
  caps.push({
    name: "node",
    found: nodeDet.found,
    version: nodeDet.version,
    path: nodeDet.path,
    required: true,
    hint: HINTS.node,
  });

  const gitDet = detectBinary(["git"], ["--version"]);
  caps.push({
    name: "git",
    found: gitDet.found,
    version: gitDet.version,
    path: gitDet.path,
    required: false,
    hint: HINTS.git,
  });

  if (!languages || languages.python) {
    const pyDet = detectPython();
    caps.push({
      name: "python",
      found: pyDet.found,
      version: pyDet.version,
      path: pyDet.path,
      required: getReq("python", true),
      hint: HINTS.python,
    });

    const ruffDet = detectBinary(["ruff"], ["--version"]);
    caps.push({
      name: "ruff",
      found: ruffDet.found,
      version: ruffDet.version,
      path: ruffDet.path,
      required: getReq("ruff", true),
      hint: HINTS.ruff,
    });

    const mypyDet = detectBinary(["mypy"], ["--version"]);
    caps.push({
      name: "mypy",
      found: mypyDet.found,
      version: mypyDet.version,
      path: mypyDet.path,
      required: getReq("mypy", false),
      hint: HINTS.mypy,
    });

    const pytestDet = detectBinary(["pytest"], ["--version"]);
    const pytestPyFallback =
      !pytestDet.found && pyDet.found
        ? trySpawn(pyDet.path || "python3", ["-m", "pytest", "--version"])
        : ({ found: false } as Detected);
    const finalPytest = pytestDet.found
      ? pytestDet
      : pytestPyFallback.found
        ? { ...pytestPyFallback, path: `${pyDet.path} -m pytest` }
        : ({ found: false } as Detected);
    caps.push({
      name: "pytest",
      found: finalPytest.found,
      version: finalPytest.version,
      path: finalPytest.path,
      required: getReq("pytest", true),
      hint: HINTS.pytest,
    });

    const covDet = detectPytestCov();
    const coverageBin = detectBinary(["coverage"], ["--version"]);
    const finalCovFound = covDet.found || coverageBin.found;
    caps.push({
      name: "coverage",
      found: finalCovFound,
      version: covDet.version || coverageBin.version,
      path: covDet.path || coverageBin.path,
      required: getReq("coverage", false),
      hint: HINTS.coverage,
    });

    for (const name of ["xenon", "deptry", "sqlfluff"]) {
      const detected = detectBinary([name], ["--version"]);
      caps.push({
        name,
        found: detected.found,
        version: detected.version,
        path: detected.path,
        required: getReq(name, false),
        hint: HINTS[name],
      });
    }
  }

  if (!languages || languages.typescript) {
    const tscDet = detectNodeBin("tsc", root || process.cwd());
    caps.push({
      name: "typescript",
      found: tscDet.found,
      version: tscDet.version,
      path: tscDet.path,
      required: getReq("typescript", false),
      hint: HINTS.typescript,
    });
    caps.push({
      name: "tsc",
      found: tscDet.found,
      version: tscDet.version,
      path: tscDet.path,
      required: getReq("tsc", false),
      hint: HINTS.tsc,
    });

    const eslintDet = detectNodeBin("eslint", root || process.cwd());
    caps.push({
      name: "eslint",
      found: eslintDet.found,
      version: eslintDet.version,
      path: eslintDet.path,
      required: getReq("eslint", false),
      hint: HINTS.eslint,
    });

    const prettierDet = detectNodeBin("prettier", root || process.cwd());
    caps.push({
      name: "prettier",
      found: prettierDet.found,
      version: prettierDet.version,
      path: prettierDet.path,
      required: getReq("prettier", false),
      hint: HINTS.prettier,
    });

    const vitestDet = detectNodeBin("vitest", root || process.cwd());
    caps.push({
      name: "vitest",
      found: vitestDet.found,
      version: vitestDet.version,
      path: vitestDet.path,
      required: getReq("vitest", false),
      hint: HINTS.vitest,
    });
  }

  if (!languages || languages.go) {
    const goDet = detectBinary(["go"], ["version"]);
    caps.push({
      name: "go",
      found: goDet.found,
      version: goDet.version,
      path: goDet.path,
      required: getReq("go", false),
      hint: HINTS.go,
    });

    const golangciDet = detectBinary(["golangci-lint"], ["--version"]);
    caps.push({
      name: "golangci-lint",
      found: golangciDet.found,
      version: golangciDet.version,
      path: golangciDet.path,
      required: getReq("golangci-lint", false),
      hint: HINTS["golangci-lint"],
    });
  }

  if (!languages || languages.rust) {
    for (const [name, args] of [
      ["rustc", ["--version"]],
      ["cargo", ["--version"]],
      ["rustfmt", ["--version"]],
      ["clippy", ["clippy", "--version"]],
    ] as Array<[string, string[]]>) {
      const detected = name === "clippy" ? detectBinary(["cargo"], args) : detectBinary([name], args);
      const check =
        name === "clippy" ? "rust.clippy" : name === "rustfmt" ? "rust.fmt" : name === "cargo" ? "rust.test" : name;
      caps.push({
        name,
        found: detected.found,
        version: detected.version,
        path: detected.path,
        required: getReq(check, false),
        hint: HINTS[name],
      });
    }
  }

  if (key) CAP_CACHE.set(key, caps);
  return caps;
}

export function clearCapabilityCache(): void {
  CAP_CACHE.clear();
}

export function detectMap(list: Capability[]): Map<string, Capability> {
  const m = new Map<string, Capability>();
  for (const c of list) {
    m.set(c.name, c);
    // also map canonical packs for convenience
    if (c.name === "ruff") m.set("python.ruff", c);
    if (c.name === "mypy") m.set("python.mypy", c);
    if (c.name === "pytest") {
      m.set("python.pytest", c);
      m.set("python.coverage", { ...c, name: "python.coverage" });
    }
    if (c.name === "typescript") {
      m.set("typescript.tsc", c);
      m.set("python.typescript" as any, c);
    }
    if (c.name === "tsc") m.set("typescript.tsc", c);
    if (c.name === "eslint") m.set("typescript.eslint", c);
    if (c.name === "prettier") m.set("typescript.prettier", c);
    if (c.name === "vitest") m.set("typescript.vitest", c);
    if (c.name === "go") {
      m.set("go.test", c);
      m.set("go.vet", c);
    }
    if (c.name === "golangci-lint") {
      m.set("go.golangci", c);
      m.set("golangci", c);
    }
    if (c.name === "xenon") m.set("python.xenon", c);
    if (c.name === "deptry") m.set("python.deptry", c);
    if (c.name === "sqlfluff") m.set("sql.sqlfluff", c);
    if (c.name === "coverage") m.set("python.coverage", c);
    if (c.name === "rustfmt") m.set("rust.fmt", c);
    if (c.name === "clippy") m.set("rust.clippy", c);
    if (c.name === "cargo") m.set("rust.test", c);
  }
  return m;
}
