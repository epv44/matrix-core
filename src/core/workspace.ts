import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ApplicationConfig,
  LanguageWorkspace,
  ResolutionEvidence,
  SqlApplicationFacet,
  SqlWorkspaceFacet,
  ToolEnvironment,
  WorkspaceLanguage,
  WorkspaceResolution,
} from "./types.js";

const IGNORED = new Set([
  ".git",
  ".quality",
  ".next",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  "node_modules",
  "__pycache__",
]);

function walk(root: string, visit: (file: string) => void) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) walk(absolute, visit);
    else if (entry.isFile()) visit(absolute);
  }
}

function nearest(start: string, root: string, names: string[]): string | null {
  let current = path.dirname(start);
  while (current === root || current.startsWith(`${root}${path.sep}`)) {
    for (const name of names) if (fs.existsSync(path.join(current, name))) return current;
    if (current === root) break;
    current = path.dirname(current);
  }
  return null;
}

function relative(root: string, files: string[]) {
  return files.map((file) => path.relative(root, file).split(path.sep).join("/")).sort();
}

function sha(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileRecords(root: string, files: string[]) {
  return files
    .map((file) => ({ path: relative(root, [file])[0], hash: sha(fs.readFileSync(file)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function pythonEnvironment(packageRoot: string): ToolEnvironment {
  for (const name of [".venv", "venv"]) {
    const bin = path.join(packageRoot, name, process.platform === "win32" ? "Scripts" : "bin");
    const python = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
    if (fs.existsSync(python)) {
      const binaries: Record<string, string> = { python };
      for (const tool of ["ruff", "mypy", "xenon", "deptry", "sqlfluff"]) {
        const candidate = path.join(bin, process.platform === "win32" ? `${tool}.exe` : tool);
        if (fs.existsSync(candidate)) binaries[tool] = candidate;
      }
      return { kind: "python-venv", root: path.join(packageRoot, name), binaries };
    }
  }
  return { kind: "system", root: packageRoot, binaries: {} };
}

function nodeEnvironment(packageRoot: string): ToolEnvironment {
  const bin = path.join(packageRoot, "node_modules", ".bin");
  const binaries: Record<string, string> = {};
  for (const tool of ["tsc", "eslint"]) {
    const candidate = path.join(bin, process.platform === "win32" ? `${tool}.cmd` : tool);
    if (fs.existsSync(candidate)) binaries[tool] = candidate;
  }
  return { kind: "node-package", root: packageRoot, binaries };
}

function evidence(kind: ResolutionEvidence["kind"], file: string, detail: string): ResolutionEvidence {
  return { kind, path: file, detail };
}

function validateNodeLocks(packageRoot: string) {
  const locks = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].filter((name) =>
    fs.existsSync(path.join(packageRoot, name)),
  );
  if (locks.length > 1)
    throw new Error(`Ambiguous dependency ownership at ${packageRoot}: conflicting lockfiles ${locks.join(", ")}`);
  return locks.map((name) => path.join(packageRoot, name));
}

function validatePythonLocks(packageRoot: string) {
  const locks = ["poetry.lock", "uv.lock", "Pipfile.lock", "pdm.lock"].filter((name) =>
    fs.existsSync(path.join(packageRoot, name)),
  );
  if (locks.length > 1)
    throw new Error(
      `Ambiguous Python dependency ownership at ${packageRoot}: conflicting lockfiles ${locks.join(", ")}`,
    );
  return locks.map((name) => path.join(packageRoot, name));
}

function typescriptConfigs(packageRoot: string) {
  const configs: string[] = [];
  walk(packageRoot, (file) => {
    if (
      /^tsconfig(?:\.[^.]+)*\.json$/i.test(path.basename(file)) &&
      nearest(file, packageRoot, ["package.json"]) === packageRoot
    )
      configs.push(file);
  });
  return configs.sort();
}

function makeWorkspace(
  root: string,
  language: WorkspaceLanguage,
  packageRoot: string,
  sources: string[],
): LanguageWorkspace {
  const configs =
    language === "python"
      ? ["pyproject.toml", "setup.cfg", "setup.py"].map((name) => path.join(packageRoot, name)).filter(fs.existsSync)
      : language === "typescript"
        ? typescriptConfigs(packageRoot)
        : [];
  const dependencies =
    language === "python"
      ? ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.cfg", "setup.py"]
          .map((name) => path.join(packageRoot, name))
          .filter(fs.existsSync)
          .concat(validatePythonLocks(packageRoot))
      : language === "typescript"
        ? [path.join(packageRoot, "package.json"), ...validateNodeLocks(packageRoot)].filter(fs.existsSync)
        : [];
  const environment = language === "python" ? pythonEnvironment(packageRoot) : nodeEnvironment(packageRoot);
  const sourceRoot = packageRoot;
  const idPath = path.relative(root, packageRoot) || ".";
  const resolutionEvidence = [
    ...sources
      .sort()
      .slice(0, 5)
      .map((file) => evidence("source", path.relative(root, file), `${language} source owned by ${idPath}`)),
    ...configs.map((file) => evidence("config", path.relative(root, file), "application resolution configuration")),
    ...dependencies.map((file) => evidence("manifest", path.relative(root, file), "dependency ownership")),
    evidence("environment", path.relative(root, environment.root) || ".", environment.kind),
  ];
  const portable = {
    id: `${language}:${idPath}`,
    language,
    sourceRoot: idPath,
    packageRoot: idPath,
    executionRoot: idPath,
    applicationConfigs: fileRecords(root, configs),
    dependencyFiles: fileRecords(root, dependencies),
    sources: relative(root, sources),
  };
  return {
    id: `${language}:${idPath}`,
    language,
    sourceRoot,
    packageRoot,
    executionRoot: packageRoot,
    applicationConfigs: relative(root, configs),
    dependencyFiles: relative(root, dependencies),
    toolEnvironment: { ...environment, root: path.relative(root, environment.root) || "." },
    sqlFacets: [],
    resolutionEvidence,
    resolutionHash: sha(JSON.stringify(portable)),
  };
}

const SQL_DIALECTS = new Set([
  "ansi",
  "athena",
  "bigquery",
  "clickhouse",
  "databricks",
  "db2",
  "duckdb",
  "exasol",
  "greenplum",
  "hive",
  "materialize",
  "mysql",
  "oracle",
  "postgres",
  "redshift",
  "snowflake",
  "soql",
  "sparksql",
  "sqlite",
  "starrocks",
  "teradata",
  "trino",
  "tsql",
  "vertica",
]);

function isWithin(parent: string, child: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function sqlFacetSources(sourceRoot: string, sources: SqlApplicationFacet["sources"]) {
  const files: string[] = [];
  walk(sourceRoot, (file) => {
    if (sources.includes("files") && /\.(?:sql|sql\.j2|dml|ddl)$/i.test(file)) files.push(file);
    if (sources.includes("python") && file.endsWith(".py")) files.push(file);
  });
  return files.sort();
}

function attachSqlFacets(root: string, workspaces: LanguageWorkspace[], application?: ApplicationConfig) {
  const configured = application?.sql ?? [];
  const resolvedRoots = configured.map((facet) => {
    const candidate = path.resolve(root, facet.root);
    if (!isWithin(root, candidate)) throw new Error(`SQL facet root escapes repository: ${facet.root}`);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory())
      throw new Error(`SQL facet root does not exist or is not a directory: ${facet.root}`);
    const real = fs.realpathSync(candidate);
    if (!isWithin(root, real)) throw new Error(`SQL facet root resolves outside repository: ${facet.root}`);
    if (!SQL_DIALECTS.has(facet.dialect))
      throw new Error(`Unsupported SQLFluff dialect '${facet.dialect}' for SQL facet ${facet.root}`);
    return { config: facet, root: real };
  });
  for (let i = 0; i < resolvedRoots.length; i++) {
    for (let j = i + 1; j < resolvedRoots.length; j++) {
      if (
        isWithin(resolvedRoots[i].root, resolvedRoots[j].root) ||
        isWithin(resolvedRoots[j].root, resolvedRoots[i].root)
      )
        throw new Error(`Overlapping SQL facet roots are ambiguous: ${configured[i].root} and ${configured[j].root}`);
    }
  }
  const uncoveredSql: string[] = [];
  walk(root, (file) => {
    if (!/\.(?:sql|sql\.j2|dml|ddl)$/i.test(file)) return;
    if (!resolvedRoots.some((facet) => isWithin(facet.root, file))) uncoveredSql.push(path.relative(root, file));
  });
  if (uncoveredSql.length > 0)
    throw new Error(`SQL sources are not covered by application.sql metadata: ${uncoveredSql.slice(0, 10).join(", ")}`);
  for (const { config, root: sourceRoot } of resolvedRoots.sort((a, b) => a.root.localeCompare(b.root))) {
    const owners = workspaces
      .filter((workspace) => isWithin(workspace.packageRoot, sourceRoot))
      .sort((a, b) => b.packageRoot.length - a.packageRoot.length || a.id.localeCompare(b.id));
    if (owners.length === 0) throw new Error(`Cannot resolve owning language workspace for SQL facet ${config.root}`);
    if (owners.length > 1 && owners[0].packageRoot === owners[1].packageRoot)
      throw new Error(`Ambiguous language workspace ownership for SQL facet ${config.root}`);
    const owner = owners[0];
    const environment = owner.language === "python" ? owner.toolEnvironment : pythonEnvironment(owner.packageRoot);
    const files = sqlFacetSources(sourceRoot, config.sources);
    const idPath = path.relative(root, sourceRoot) || ".";
    const portable = {
      id: `sql:${idPath}`,
      ownerWorkspaceId: owner.id,
      sourceRoot: idPath,
      dialect: config.dialect,
      templater: config.templater,
      sources: [...config.sources].sort(),
      files: relative(root, files),
    };
    const facet: SqlWorkspaceFacet = {
      id: portable.id,
      ownerWorkspaceId: owner.id,
      sourceRoot,
      dialect: config.dialect,
      templater: config.templater,
      sources: [...config.sources].sort() as SqlWorkspaceFacet["sources"],
      toolEnvironment: { ...environment, root: path.relative(root, environment.root) || "." },
      resolutionEvidence: [
        evidence("config", config.root, `SQL ${config.dialect}/${config.templater} application facet`),
        ...files.slice(0, 5).map((file) => evidence("source", path.relative(root, file), "SQL lint input")),
        evidence("environment", path.relative(root, environment.root) || ".", environment.kind),
      ],
      resolutionHash: sha(JSON.stringify(portable)),
    };
    owner.sqlFacets.push(facet);
  }
  for (const workspace of workspaces) {
    workspace.sqlFacets.sort((a, b) => a.id.localeCompare(b.id));
    if (workspace.sqlFacets.length > 0)
      workspace.resolutionHash = sha(
        JSON.stringify({
          workspace: workspace.resolutionHash,
          sql: workspace.sqlFacets.map((facet) => facet.resolutionHash),
        }),
      );
  }
}

export function resolveLanguageWorkspaces(rootInput: string, application?: ApplicationConfig): LanguageWorkspace[] {
  const root = fs.realpathSync(rootInput);
  const python: string[] = [];
  const typescript: string[] = [];
  walk(root, (file) => {
    if (file.endsWith(".py")) python.push(file);
    if (/\.(?:ts|tsx|mts|cts)$/.test(file) && !file.endsWith(".d.ts")) typescript.push(file);
  });
  const groups = new Map<string, { language: WorkspaceLanguage; files: string[] }>();
  for (const file of python) {
    const owner = nearest(file, root, ["pyproject.toml", "setup.py", "setup.cfg"]) ?? root;
    const key = `python\0${owner}`;
    const group = groups.get(key) ?? { language: "python" as const, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  for (const file of typescript) {
    const owner = nearest(file, root, ["package.json"]);
    if (!owner)
      throw new Error(`Cannot resolve TypeScript package ownership for ${path.relative(root, file)}: no package.json`);
    const key = `typescript\0${owner}`;
    const group = groups.get(key) ?? { language: "typescript" as const, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  const workspaces = [...groups.entries()]
    .map(([key, group]) => makeWorkspace(root, group.language, key.split("\0")[1], group.files))
    .sort((a, b) => a.id.localeCompare(b.id));
  attachSqlFacets(root, workspaces, application);
  return workspaces;
}

export function resolveWorkspaceSet(rootInput: string, application?: ApplicationConfig): WorkspaceResolution {
  const workspaces = resolveLanguageWorkspaces(rootInput, application);
  return {
    schemaVersion: 1,
    workspaces,
    workspaceHash: sha(
      JSON.stringify(workspaces.map(({ id, language, resolutionHash }) => ({ id, language, resolutionHash }))),
    ),
  };
}
