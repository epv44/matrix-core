import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import type { LanguageWorkspace } from "./types.js";
import { sha256 } from "./hash.js";

const RESOLUTION_OPTIONS = new Set([
  "target",
  "lib",
  "module",
  "moduleResolution",
  "baseUrl",
  "paths",
  "rootDirs",
  "typeRoots",
  "types",
  "jsx",
  "jsxFactory",
  "jsxFragmentFactory",
  "jsxImportSource",
  "allowJs",
  "esModuleInterop",
  "allowSyntheticDefaultImports",
  "resolveJsonModule",
  "customConditions",
  "moduleSuffixes",
  "resolvePackageJsonExports",
  "resolvePackageJsonImports",
  "allowImportingTsExtensions",
  "preserveSymlinks",
  "moduleDetection",
  "verbatimModuleSyntax",
]);

function sha(value: string) {
  return sha256(value);
}

function optionToJson(name: string, value: unknown): unknown {
  if (name === "lib" && Array.isArray(value))
    return value.map((entry) =>
      String(entry)
        .replace(/^lib\./, "")
        .replace(/\.d\.ts$/, ""),
    );
  const declarations = (ts as unknown as { optionDeclarations: readonly any[] }).optionDeclarations;
  const declaration = declarations.find((candidate) => candidate.name === name);
  const map = declaration?.type instanceof Map ? declaration.type : declaration?.type?.element?.type;
  if (map instanceof Map) {
    const reverse = (entry: unknown) => [...map.entries()].find(([, mapped]) => mapped === entry)?.[0] ?? entry;
    return Array.isArray(value) ? value.map(reverse) : reverse(value);
  }
  return value;
}

export interface MaterializedTypeScriptConfig {
  path: string;
  hash: string;
  cleanup(): void;
}

export function materializeTypeScriptConfig(
  workspace: LanguageWorkspace,
  qualityConfigPath: string,
): MaterializedTypeScriptConfig {
  const primary = path.join(workspace.executionRoot, "tsconfig.json");
  if (!primary || !fs.existsSync(primary))
    throw new Error(`${workspace.id} has TypeScript sources but no owning tsconfig.json`);

  const read = ts.readConfigFile(primary, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(primary), undefined, primary);
  if (parsed.errors.length)
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; "));

  const compilerOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.options))
    if (RESOLUTION_OPTIONS.has(key)) compilerOptions[key] = optionToJson(key, value);
  if (typeof compilerOptions.baseUrl === "string")
    compilerOptions.baseUrl = path.resolve(path.dirname(primary), compilerOptions.baseUrl);
  else if (compilerOptions.paths) compilerOptions.baseUrl = path.dirname(primary);
  if (!compilerOptions.typeRoots) {
    const workspaceTypes = path.join(workspace.executionRoot, "node_modules", "@types");
    if (fs.existsSync(workspaceTypes)) compilerOptions.typeRoots = [workspaceTypes];
  }
  const central = JSON.parse(fs.readFileSync(qualityConfigPath, "utf8")) as {
    compilerOptions?: Record<string, unknown>;
  };
  if (!central.compilerOptions) throw new Error(`Invalid MatrixCore TypeScript policy asset: ${qualityConfigPath}`);
  Object.assign(compilerOptions, central.compilerOptions);

  const body = {
    compilerOptions,
    files: parsed.fileNames.map((file) => path.resolve(file)).sort(),
    references: parsed.projectReferences?.map((reference) => ({ path: path.resolve(reference.path) })),
  };
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-tsconfig-"));
  const target = path.join(directory, "tsconfig.matrixcore.json");
  fs.writeFileSync(target, serialized, "utf8");
  return {
    path: target,
    hash: sha(serialized),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}
