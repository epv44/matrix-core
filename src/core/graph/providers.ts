import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import type { LanguageWorkspace } from "../types.js";
import type { GraphEdge, GraphFacts, GraphFile, GraphProvider, GraphSymbol } from "./types.js";
import { sha256 } from "../hash.js";
import { isWithinMatrixCoreIgnore } from "../filesystem.js";

function sha(value: string) {
  return sha256(value);
}
function lineAt(source: string, offset: number) {
  return source.slice(0, offset).split("\n").length;
}
function language(file: string): "python" | "typescript" | null {
  if (/\.(py|pyi)$/.test(file)) return "python";
  if (/\.(ts|tsx|js|jsx)$/.test(file)) return "typescript";
  return null;
}
function gitFiles(root: string): string[] {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "buffer" });
  if (result.status !== 0) return [];
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => !isWithinMatrixCoreIgnore(root, path.join(root, file)))
    .sort();
}

export function scanFile(
  root: string,
  relative: string,
): { file: GraphFile; symbols: GraphSymbol[]; edges: GraphEdge[] } | null {
  const kind = language(relative);
  if (!kind) return null;
  const absolute = path.join(root, relative);
  let source: string;
  try {
    source = fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
  const contentHash = sha(source);
  const provider = "tree-sitter-fallback";
  const symbols: GraphSymbol[] = [];
  const edges: GraphEdge[] = [];
  const add = (name: string, symbolKind: GraphSymbol["kind"], offset: number, exported = false) => {
    const symbol: GraphSymbol = {
      file: relative,
      provider,
      kind: symbolKind,
      name,
      qualifiedName: name,
      startLine: lineAt(source, offset),
      endLine: lineAt(source, offset),
      contentHash,
    };
    symbols.push(symbol);
    if (exported)
      edges.push({
        source: `${relative}:${name}`,
        target: null,
        targetText: name,
        kind: "exports",
        confidence: "syntactic",
        provider,
      });
  };
  const declaration =
    kind === "typescript"
      ? /(?:(export)\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)|(?:(export)\s+)?class\s+([A-Za-z_$][\w$]*)/g
      : /^(?:\s*)(?:(async)\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm;
  for (const match of source.matchAll(declaration)) {
    const name = match[2] ?? match[4];
    if (name) add(name, /class/.test(match[0]) ? "class" : "function", match.index ?? 0, Boolean(match[1] || match[3]));
  }
  const imports =
    kind === "typescript"
      ? /(?:import\s+.*?from\s+|import\s*\(\s*|export\s+.*?from\s+)["']([^"']+)["']/g
      : /(?:from\s+([\w.]+)\s+import|import\s+)([\w.]+)/g;
  for (const match of source.matchAll(imports)) {
    const target = match[1] ?? match[2];
    if (!target) continue;
    const sourceSymbol = symbols[0]?.qualifiedName;
    if (sourceSymbol)
      edges.push({
        source: `${relative}:${sourceSymbol}`,
        target: null,
        targetText: target,
        kind: "imports",
        confidence: "syntactic",
        provider,
      });
  }
  for (const symbol of symbols) {
    const call = new RegExp(`\\b${symbol.name}\\s*\\(`, "g");
    for (const match of source.matchAll(call))
      if ((match.index ?? 0) > 0)
        edges.push({
          source: `${relative}:${symbols[0]?.name ?? symbol.name}`,
          target: `${relative}:${symbol.qualifiedName}`,
          targetText: symbol.name,
          kind: "calls",
          confidence: "syntactic",
          provider,
        });
  }
  return { file: { path: relative, language: kind, contentHash }, symbols, edges };
}

export class TreeSitterProvider implements GraphProvider {
  readonly id = "tree-sitter-wasm";
  readonly version = "0.26.12-vscode-0.3.1-v2";
  supports(workspace: LanguageWorkspace) {
    return workspace.language === "typescript" || workspace.language === "python";
  }
  async indexFiles(root: string, files: GraphFile[]): Promise<GraphFacts> {
    await Parser.init();
    const require = createRequire(import.meta.url);
    const wasmRoot = path.join(path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
    const languages = new Map<string, Language>();
    for (const language of ["python", "typescript"])
      languages.set(language, await Language.load(path.join(wasmRoot, `tree-sitter-${language}.wasm`)));
    const scanned = files
      .filter((file) => file.language === "python")
      .map((file) => scanWasmFile(root, file, languages.get("python")!));
    return {
      files: scanned.map((item) => item.file),
      symbols: scanned.flatMap((item) => item.symbols),
      edges: scanned.flatMap((item) => item.edges),
      provider: this.id,
      providerVersion: this.version,
    };
  }
}

function scanWasmFile(root: string, file: GraphFile, language: Language) {
  const source = fs.readFileSync(path.join(root, file.path), "utf8");
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    return { file, symbols: [], edges: [] };
  }
  const symbols: GraphSymbol[] = [];
  const edges: GraphEdge[] = [];
  const visit = (node: any) => {
    const nameNode = node.childForFieldName?.("name");
    const type = String(node.type);
    if (
      nameNode &&
      ["function_definition", "class_definition", "function_declaration", "class_declaration"].includes(type)
    ) {
      const name = source.slice(nameNode.startIndex, nameNode.endIndex);
      const kind: GraphSymbol["kind"] = type.includes("class") ? "class" : "function";
      symbols.push({
        file: file.path,
        provider: "tree-sitter-wasm",
        kind,
        name,
        qualifiedName: name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        contentHash: file.contentHash,
      });
    }
    for (let index = 0; index < node.childCount; index++) visit(node.child(index));
  };
  visit(tree.rootNode);
  const sourceSymbol = symbols[0]?.qualifiedName;
  if (sourceSymbol) {
    for (const match of source.matchAll(/^(?:from\s+([\w.]+)\s+import|import\s+)([\w.]+)/gm)) {
      const target = match[1] ?? match[2];
      if (target)
        edges.push({
          source: `${file.path}:${sourceSymbol}`,
          target: null,
          targetText: target,
          kind: "imports",
          confidence: "syntactic",
          provider: "tree-sitter-wasm",
        });
    }
    const declared = new Set(symbols.map((symbol) => symbol.name));
    for (const match of source.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const target = match[1];
      if (!declared.has(target))
        edges.push({
          source: `${file.path}:${sourceSymbol}`,
          target: null,
          targetText: target,
          kind: "calls",
          confidence: "textual",
          provider: "tree-sitter-wasm",
        });
    }
  }
  parser.delete();
  return { file, symbols, edges };
}

export class TypeScriptCompilerProvider implements GraphProvider {
  readonly id = "typescript-compiler";
  readonly version = `${ts.version}-v5-workspace-symbol-resolution`;
  supports(workspace: LanguageWorkspace) {
    return workspace.language === "typescript";
  }
  async indexFiles(root: string, files: GraphFile[]): Promise<GraphFacts> {
    const selected = files.filter((file) => file.language === "typescript");
    const allTypeScriptFiles = gitFiles(root).filter((file) => language(file) === "typescript");
    const configPath =
      selected
        .map((file) => ts.findConfigFile(path.dirname(path.join(root, file.path)), ts.sys.fileExists, "tsconfig.json"))
        .find((value): value is string => Boolean(value)) ??
      ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
    let compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.Latest,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      baseUrl: root,
    };
    if (configPath) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!config.error)
        compilerOptions = {
          ...compilerOptions,
          ...ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options,
        };
    }
    const program = ts.createProgram(
      allTypeScriptFiles.map((file) => path.join(root, file)),
      compilerOptions,
    );
    const checker = program.getTypeChecker();
    const relativeSourceFile = (sourceFile: ts.SourceFile) =>
      path.relative(root, sourceFile.fileName).replaceAll("\\", "/");
    const symbols: GraphSymbol[] = [];
    const edges: GraphEdge[] = [];

    const declarationName = (node: ts.Node): string | undefined => {
      if (!("name" in node)) return undefined;
      const name = (node as ts.NamedDeclaration).name;
      return name && ts.isIdentifier(name) ? name.text : name?.getText();
    };
    const symbolKind = (node: ts.Node): GraphSymbol["kind"] | undefined => {
      if (ts.isFunctionDeclaration(node)) return "function";
      if (ts.isMethodDeclaration(node)) return "method";
      if (ts.isClassDeclaration(node)) return "class";
      if (ts.isInterfaceDeclaration(node)) return "interface";
      if (ts.isTypeAliasDeclaration(node)) return "type";
      if (ts.isEnumDeclaration(node)) return "enum";
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return "variable";
      return undefined;
    };
    const qualifiedName = (node: ts.Node, name: string) => {
      const parent = node.parent;
      if ((ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && parent.name)
        return `${parent.name.text}.${name}`;
      return name;
    };
    const symbolForDeclaration = (node: ts.Node, sourceFile: ts.SourceFile): GraphSymbol | undefined => {
      const name = declarationName(node);
      const kind = symbolKind(node);
      if (!name || !kind) return undefined;
      return {
        file: relativeSourceFile(sourceFile),
        provider: this.id,
        kind,
        name,
        qualifiedName: qualifiedName(node, name),
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
        contentHash:
          selected.find((file) => file.path === relativeSourceFile(sourceFile))?.contentHash ?? sha(sourceFile.text),
      };
    };
    const key = (symbol: GraphSymbol) => `${symbol.file}:${symbol.qualifiedName}`;
    const declarationKey = (node: ts.Node): string | undefined => {
      const sourceFile = node.getSourceFile();
      const symbol = symbolForDeclaration(node, sourceFile);
      return symbol ? key(symbol) : undefined;
    };
    const declarationsByName = new Map<string, string[]>();
    for (const sourceFile of program.getSourceFiles()) {
      if (!sourceFile.fileName.startsWith(root)) continue;
      for (const statement of sourceFile.statements) {
        const declaration = symbolForDeclaration(statement, sourceFile);
        if (!declaration) continue;
        const values = declarationsByName.get(declaration.name) ?? [];
        values.push(key(declaration));
        declarationsByName.set(declaration.name, values);
      }
    }
    const resolvedTarget = (node: ts.Node): string | undefined => {
      let symbol = checker.getSymbolAtLocation(node as ts.Node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.declarations?.find((candidate) =>
        candidate.getSourceFile().fileName.startsWith(root),
      );
      const direct = declaration ? declarationKey(declaration) : undefined;
      if (direct) return direct;
      const names = [symbol?.getName(), node.getText().split(".").at(-1)].filter(
        (name): name is string => Boolean(name) && name !== "unknown",
      );
      for (const name of names) {
        const local = [...new Set(declarationsByName.get(name) ?? [])];
        if (local.length === 1) return local[0];
      }
      return undefined;
    };

    for (const file of selected) {
      let source: string;
      try {
        source = fs.readFileSync(path.join(root, file.path), "utf8");
      } catch {
        continue;
      }
      const ast =
        program.getSourceFile(path.join(root, file.path)) ??
        ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true);
      const local: GraphSymbol[] = [];
      const owners = new Map<ts.Node, GraphSymbol | undefined>();
      const collect = (node: ts.Node, owner?: GraphSymbol) => {
        const symbol = symbolForDeclaration(node, ast);
        const currentOwner = symbol ?? owner;
        owners.set(node, currentOwner);
        if (symbol) local.push(symbol);
        ts.forEachChild(node, (child) => collect(child, currentOwner));
      };
      collect(ast);
      const visit = (node: ts.Node) => {
        const owner = owners.get(node);
        if (symbolKind(node) && node.parent && ts.isSourceFile(node.parent)) {
          const symbol = symbolForDeclaration(node, ast);
          if (symbol)
            edges.push({
              source: key(symbol),
              target: null,
              targetText: symbol.name,
              kind: "exports",
              confidence: "exact",
              provider: this.id,
            });
        }
        if (ts.isImportDeclaration(node) && owner)
          edges.push({
            source: key(owner),
            target: resolvedTarget(node.moduleSpecifier) ?? null,
            targetText: node.moduleSpecifier.getText(ast).slice(1, -1),
            kind: "imports",
            confidence: "exact",
            provider: this.id,
          });
        if (ts.isCallExpression(node) && owner) {
          const expression = node.expression.getText(ast);
          edges.push({
            source: key(owner),
            target: resolvedTarget(node.expression) ?? null,
            targetText: expression.split(".").at(-1) ?? expression,
            kind: "calls",
            confidence: resolvedTarget(node.expression) ? "exact" : "syntactic",
            provider: this.id,
          });
        }
        if (ts.isTypeReferenceNode(node) && owner) {
          const target = resolvedTarget(node.typeName);
          edges.push({
            source: key(owner),
            target: target ?? null,
            targetText: node.typeName.getText(ast),
            kind: "reads-type",
            confidence: target ? "exact" : "syntactic",
            provider: this.id,
          });
        }
        if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name)
          for (const clause of node.heritageClauses ?? [])
            for (const type of clause.types) {
              const target = resolvedTarget(type.expression);
              edges.push({
                source: `${file.path}:${node.name.getText(ast)}`,
                target: target ?? null,
                targetText: type.expression.getText(ast),
                kind: clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends",
                confidence: target ? "exact" : "syntactic",
                provider: this.id,
              });
            }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      symbols.push(...local);
    }
    return { files: selected, symbols, edges, provider: this.id, providerVersion: this.version };
  }
}

export function discoverGraphFiles(root: string): GraphFile[] {
  return gitFiles(root).flatMap((file) => {
    const lang = language(file);
    if (!lang) return [];
    let content = "";
    try {
      content = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return [];
    }
    return [{ path: file, language: lang, contentHash: sha(content) }];
  });
}
