import ts from "typescript";
import type { ControlFlowDelta } from "../core/review-contracts.js";
import type { ReviewWorkItem } from "./engine-types.js";

const UNKNOWN = Symbol("unknown-control-flow-value");
type Value = string | boolean | null | undefined | { readonly properties: Readonly<Record<string, Value>> } | typeof UNKNOWN;

interface GuardChange {
  file: string;
  line: number;
  oldStatement: ts.IfStatement;
  newStatement: ts.IfStatement;
}

function ifStatement(source: string): ts.IfStatement | undefined {
  const file = ts.createSourceFile("guard.ts", `function review() { ${source} }`, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(ts.isFunctionDeclaration);
  return declaration?.body?.statements.find(ts.isIfStatement);
}

function blocks(statement: ts.IfStatement) {
  const then = statement.thenStatement;
  return ts.isThrowStatement(then) || ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.some((entry) => ts.isThrowStatement(entry) || ts.isReturnStatement(entry)));
}

function changedGuards(diff: string): GuardChange[] {
  const guards: GuardChange[] = [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;
  let oldCandidates: Array<{ line: number; source: string }> = [];
  let newCandidates: Array<{ line: number; source: string }> = [];
  const flush = () => {
    const count = Math.min(oldCandidates.length, newCandidates.length);
    for (let index = 0; index < count; index++) {
      const previous = ifStatement(oldCandidates[index]!.source);
      const current = ifStatement(newCandidates[index]!.source);
      if (previous && current && blocks(previous) && blocks(current))
        guards.push({ file, line: newCandidates[index]!.line, oldStatement: previous, newStatement: current });
    }
    oldCandidates = [];
    newCandidates = [];
  };
  for (const raw of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (header) {
      flush();
      file = header[2]!;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!file || !oldLine || !newLine) continue;
    if (raw.startsWith("-") && !raw.startsWith("---")) {
      if (/^\-\s*if\s*\(/.test(raw)) oldCandidates.push({ line: oldLine, source: raw.slice(1).trim() });
      oldLine++;
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (/^\+\s*if\s*\(/.test(raw)) newCandidates.push({ line: newLine, source: raw.slice(1).trim() });
      newLine++;
    } else if (raw.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }
  flush();
  return guards;
}

function finitePropertyDomains(source: string) {
  const domains = new Map<string, string[]>();
  const expression = /\b([A-Za-z_$][\w$]*)\??\s*:\s*((?:["'][^"']+["']\s*\|\s*)+["'][^"']+["'])/g;
  for (const match of source.matchAll(expression)) {
    const values = [...match[2]!.matchAll(/["']([^"']+)["']/g)].map((value) => value[1]!);
    if (values.length > 1) domains.set(match[1]!, [...new Set(values)]);
  }
  return domains;
}

function nullableParameters(source: string) {
  const result = new Set<string>();
  // Stop at a member/type declaration boundary so a preceding interface field
  // cannot consume forward into an unrelated nullable function parameter.
  const expression = /\b([A-Za-z_$][\w$]*)\s*:\s*[^,)=;\n]+\|\s*(?:null|undefined)\b/g;
  for (const match of source.matchAll(expression)) result.add(match[1]!);
  return result;
}

function optionalAliases(source: string) {
  const result = new Map<string, { base: string; property: string }>();
  const expression = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\?\.([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(expression)) result.set(match[1]!, { base: match[2]!, property: match[3]! });
  return result;
}

function truthy(value: Value): boolean | typeof UNKNOWN {
  if (value === UNKNOWN) return UNKNOWN;
  return Boolean(value);
}

function evaluate(expression: ts.Expression, values: Readonly<Record<string, Value>>, aliases: ReadonlyMap<string, { base: string; property: string }>): Value {
  if (ts.isParenthesizedExpression(expression)) return evaluate(expression.expression, values, aliases);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expression)) {
    const direct = values[expression.text];
    if (direct !== undefined || Object.hasOwn(values, expression.text)) return direct;
    const alias = aliases.get(expression.text);
    if (!alias) return UNKNOWN;
    const base = values[alias.base];
    return base && typeof base === "object" ? base.properties[alias.property] ?? UNKNOWN : undefined;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const base = evaluate(expression.expression, values, aliases);
    if (base === UNKNOWN) return UNKNOWN;
    if (base === null || base === undefined) return expression.questionDotToken ? undefined : UNKNOWN;
    return typeof base === "object" ? base.properties[expression.name.text] ?? UNKNOWN : UNKNOWN;
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const value = truthy(evaluate(expression.operand, values, aliases));
    return value === UNKNOWN ? UNKNOWN : !value;
  }
  if (!ts.isBinaryExpression(expression)) return UNKNOWN;
  const left = evaluate(expression.left, values, aliases);
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const value = truthy(left);
    return value === UNKNOWN ? UNKNOWN : value ? truthy(evaluate(expression.right, values, aliases)) : false;
  }
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const value = truthy(left);
    return value === UNKNOWN ? UNKNOWN : value ? true : truthy(evaluate(expression.right, values, aliases));
  }
  const right = evaluate(expression.right, values, aliases);
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
  if (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
  if (expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
  return UNKNOWN;
}

function statesFor(source: string) {
  const domains = finitePropertyDomains(source);
  const nullable = nullableParameters(source);
  const aliases = optionalAliases(source);
  const states: Array<{ label: string; values: Record<string, Value> }> = [];
  for (const base of nullable) {
    const property = [...aliases.values()].find((alias) => alias.base === base)?.property;
    const domain = property ? domains.get(property) : undefined;
    if (!property || !domain?.length) continue;
    states.push({ label: `${base} = null`, values: { [base]: null } });
    for (const value of domain)
      states.push({
        label: `${base} present, ${property} = ${JSON.stringify(value)}`,
        values: { [base]: { properties: { [property]: value } } },
      });
  }
  return states.slice(0, 4);
}

function visible(item: ReviewWorkItem, delta: ControlFlowDelta) {
  const ranges = item.promptVisibleRanges ?? item.code.map((snippet) => ({ file: snippet.file, start: snippet.startLine, end: snippet.endLine }));
  return ranges.some((range) => range.file === delta.file && range.start <= delta.startLine && range.end >= delta.endLine);
}

/** Derive only mechanically proven guard-state changes from a TypeScript diff. */
export function deriveControlFlowDeltas(opts: { diff: string; workItem: ReviewWorkItem; maxTokens?: number }): ControlFlowDelta[] {
  const source = opts.workItem.code.map((snippet) => snippet.content).join("\n");
  const aliases = optionalAliases(source);
  const deltas: ControlFlowDelta[] = [];
  let usedTokens = 0;
  for (const guard of changedGuards(opts.diff)) {
    for (const state of statesFor(source)) {
      const previous = evaluate(guard.oldStatement.expression, state.values, aliases);
      const current = evaluate(guard.newStatement.expression, state.values, aliases);
      if (typeof previous !== "boolean" || typeof current !== "boolean" || previous === current) continue;
      const delta: ControlFlowDelta = {
        file: guard.file,
        startLine: guard.line,
        endLine: guard.line,
        state: state.label,
        previousOutcome: previous ? "blocked" : "passes",
        currentOutcome: current ? "blocked" : "passes",
      };
      if (!visible(opts.workItem, delta)) continue;
      const estimated = Math.ceil((delta.state.length + 40) / 3);
      if (deltas.length >= 2 || usedTokens + estimated > (opts.maxTokens ?? 96)) return deltas;
      usedTokens += estimated;
      deltas.push(delta);
    }
  }
  return deltas;
}
