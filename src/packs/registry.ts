import { ruffPlugin } from "./python/ruff.js";
import { ruffFormatPlugin } from "./python/ruff-format.js";
import { mypyPlugin } from "./python/mypy.js";
import { pytestPlugin } from "./python/pytest.js";
import { xenonPlugin } from "./python/xenon.js";
import { deptryPlugin } from "./python/deptry.js";
import { sqlfluffPlugin } from "./sql/sqlfluff.js";
import { tscPlugin } from "./typescript/tsc.js";
import { eslintPlugin } from "./typescript/eslint.js";
import { prettierPlugin } from "./typescript/prettier.js";
import { vitestPlugin } from "./typescript/vitest.js";
import { complexityPlugin } from "./typescript/complexity.js";
import { golangciPlugin } from "./go/golangci.js";
import { govetPlugin } from "./go/govet.js";
import { gotestPlugin } from "./go/gotest.js";
import type { QualityPack, QualityPlugin } from "./interface.js";
import { rustFmtPlugin } from "./rust/fmt.js";
import { rustClippyPlugin } from "./rust/clippy.js";
import { rustTestPlugin } from "./rust/test.js";

export const ALL_PLUGINS: QualityPlugin[] = [
  ruffPlugin,
  ruffFormatPlugin,
  mypyPlugin,
  pytestPlugin,
  xenonPlugin,
  deptryPlugin,
  sqlfluffPlugin,
  tscPlugin,
  eslintPlugin,
  prettierPlugin,
  vitestPlugin,
  complexityPlugin,
  golangciPlugin,
  govetPlugin,
  gotestPlugin,
];
export const REGISTERED_PLUGINS: QualityPlugin[] = [...ALL_PLUGINS, rustFmtPlugin, rustClippyPlugin, rustTestPlugin];

export const ALIAS_MAP: Record<string, string> = {
  ruff: "python.ruff",
  mypy: "python.mypy",
  pytest: "python.pytest",
  coverage: "python.pytest",
  xenon: "python.xenon",
  deptry: "python.deptry",
  sqlfluff: "sql.sqlfluff",
  "ruff-format": "python.ruff-format",
  ruff_format: "python.ruff-format",
  ruffFormat: "python.ruff-format",
  tsc: "typescript.tsc",
  typescript: "typescript.tsc",
  eslint: "typescript.eslint",
  prettier: "typescript.prettier",
  vitest: "typescript.vitest",
  jest: "typescript.vitest",
  complexity: "typescript.complexity",
  "ts-complexity": "typescript.complexity",
  "golangci-lint": "go.golangci",
  golangci: "go.golangci",
  "go vet": "go.vet",
  govet: "go.vet",
  "go test": "go.test",
  gotest: "go.test",
  go: "go.test",
  rustfmt: "rust.fmt",
  "cargo fmt": "rust.fmt",
  clippy: "rust.clippy",
  "cargo clippy": "rust.clippy",
  "cargo test": "rust.test",
};

export const QUALITY_PACKS: QualityPack[] = [
  {
    id: "python",
    extensions: [".py"],
    manifests: ["pyproject.toml", "requirements.txt"],
    capabilities: ["python", "ruff", "mypy", "pytest", "xenon", "deptry"],
    rule: "python",
    plugins: ALL_PLUGINS.filter((p) => p.pack === "python"),
  },
  {
    id: "sql",
    extensions: [".sql", ".sql.j2", ".dml", ".ddl"],
    manifests: ["quality.yaml"],
    capabilities: ["python", "sqlfluff"],
    rule: "sql",
    plugins: ALL_PLUGINS.filter((p) => p.pack === "sql"),
  },
  {
    id: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    manifests: ["tsconfig.json", "package.json"],
    capabilities: ["node", "tsc", "eslint", "prettier", "vitest"],
    rule: "typescript",
    plugins: ALL_PLUGINS.filter((p) => p.pack === "typescript"),
  },
  {
    id: "go",
    extensions: [".go"],
    manifests: ["go.mod", "go.work"],
    capabilities: ["go", "golangci-lint"],
    rule: "go",
    plugins: ALL_PLUGINS.filter((p) => p.pack === "go"),
  },
  {
    id: "rust",
    extensions: [".rs"],
    manifests: ["Cargo.toml"],
    capabilities: ["rustc", "cargo", "rustfmt", "clippy"],
    rule: "rust",
    plugins: REGISTERED_PLUGINS.filter((p) => p.pack === "rust"),
  },
];
export function getPack(id: string): QualityPack | undefined {
  return QUALITY_PACKS.find((p) => p.id === id);
}

export function resolveCanonicalKey(key: string): string {
  if (REGISTERED_PLUGINS.some((p) => p.name === key)) return key;
  if (ALIAS_MAP[key]) return ALIAS_MAP[key];
  return key;
}

export function getPluginByName(name: string): QualityPlugin | undefined {
  const canonical = resolveCanonicalKey(name);
  return REGISTERED_PLUGINS.find(
    (p) => p.name === canonical || p.aliases?.includes(name) || p.aliases?.includes(canonical),
  );
}

export function getPluginsForPack(pack: string): QualityPlugin[] {
  return REGISTERED_PLUGINS.filter((p) => p.pack === pack);
}
