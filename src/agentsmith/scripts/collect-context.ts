import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { getChangedFiles } from "../../core/changed.js";
import type { AgentDef } from "../types.js";
import type { ReviewScope } from "../scope.js";

function reviewerDomain(name: string): string {
  const domains: Record<string, string> = {
    "bug-hunter": "correctness",
    "semantic-reviewer": "contract",
    "perf-reviewer": "performance",
    "architecture-reviewer": "contract",
  };
  return domains[name] ?? name;
}

export interface ReviewContext {
  diff: string;
  changedFiles: string[];
  deletedFiles?: string[];
  report: string;
  rubric: string;
  base: string;
  fileContents: Record<string, string>;
  suppliedContext: Record<string, string>;
  graphContext?: string;
  audit?: ContextAudit;
  graphAudit?: {
    budgetTokens: number;
    tokenEstimate: number;
    selectedNodes: string[];
    omittedNodes: string[];
    candidates: Array<{
      key: string;
      file: string;
      line: number;
      kind: string;
      qualifiedName: string;
      provider: string;
      score: number;
      distance: number;
      excerpt?: string;
    }>;
    edges: Array<{ source: string; target: string | null; kind: string; confidence: string; provider: string }>;
  };
}

export interface ContextAuditItem {
  kind: "rubric" | "report" | "diff" | "changed-file" | "explicit-context";
  id: string;
  availableChars: number;
  selectedChars: number;
  status: "selected" | "truncated" | "omitted";
  reason?: string;
}

export interface ContextAudit {
  maxChars: number;
  usedChars: number;
  items: ContextAuditItem[];
}

export interface CollectContextOptions {
  cwd: string;
  base?: string;
  report?: string;
  rubric?: string;
  contextFiles?: string[];
  maxChars?: number;
  scope?: ReviewScope;
}

export function estimatePromptTokens(prompt: string): number {
  // Conservative bound for mixed prose and source code; Ollama enforces tokens, not characters.
  return Math.ceil(prompt.length / 2.5);
}

function scaleContext(context: ReviewContext, scale: number): ReviewContext {
  const scaleMap = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values).map(([file, value]) => [file, value.slice(0, Math.floor(value.length * scale))]),
    );
  return {
    ...context,
    rubric: context.rubric.slice(0, Math.floor(context.rubric.length * scale)),
    report: context.report.slice(0, Math.floor(context.report.length * scale)),
    diff: context.diff.slice(0, Math.floor(context.diff.length * scale)),
    fileContents: scaleMap(context.fileContents),
    suppliedContext: scaleMap(context.suppliedContext),
    graphContext: context.graphContext?.slice(0, Math.floor((context.graphContext?.length ?? 0) * scale)),
  };
}

export function collectContext(opts: CollectContextOptions): ReviewContext {
  const cwd = path.resolve(opts.cwd);
  const base = opts.base ?? "main";
  const budget = Math.max(0, opts.maxChars ?? 48000);
  let remaining = budget;
  const items: ContextAuditItem[] = [];
  const take = (value: string, kind: ContextAuditItem["kind"], id: string, cap = remaining) => {
    const selected = value.slice(0, Math.max(0, Math.min(remaining, cap)));
    remaining -= selected.length;
    items.push({
      kind,
      id,
      availableChars: value.length,
      selectedChars: selected.length,
      status:
        selected.length === 0 && value.length > 0
          ? "omitted"
          : selected.length < value.length
            ? "truncated"
            : "selected",
      reason: selected.length < value.length ? "context character budget" : undefined,
    });
    return selected;
  };
  const takeMap = (values: Record<string, string>, kind: "changed-file" | "explicit-context") =>
    Object.fromEntries(
      Object.entries(values)
        .map(([file, value]) => [file, take(value, kind, file)])
        .filter(([, value]) => value.length > 0),
    );
  if (opts.scope) {
    const scopeBase = opts.scope.base ?? base;
    const rubric = take(opts.rubric ?? "", "rubric", "rules", Math.floor(budget * 0.15));
    const report = take(opts.report ?? "", "report", "deterministic-gate", Math.floor(budget * 0.2));
    const diff = take(opts.scope.diff, "diff", scopeBase, Math.floor(budget * 0.35));
    return {
      diff,
      changedFiles: opts.scope.changedFiles,
      deletedFiles: opts.scope.deletedFiles,
      report,
      rubric,
      base: scopeBase,
      fileContents: takeMap(opts.scope.fileContents, "changed-file"),
      suppliedContext: takeMap(opts.scope.suppliedContext, "explicit-context"),
      audit: { maxChars: budget, usedChars: budget - remaining, items },
    };
  }
  let diff = "";
  try {
    const res = spawnSync("git", ["diff", `${base}...HEAD`], { cwd, encoding: "utf8", timeout: 8000 });
    if (res.status === 0) diff = res.stdout || "";
  } catch {
    diff = "";
  }
  const changedFiles = getChangedFiles({ cwd, base }).map((file) => path.relative(cwd, file) || file);
  const rubric = take(opts.rubric ?? "", "rubric", "rules", Math.floor(budget * 0.15));
  const report = take(opts.report ?? "", "report", "deterministic-gate", Math.floor(budget * 0.2));
  diff = take(diff, "diff", base, Math.floor(budget * 0.35));
  const read = (file: string) => {
    try {
      const absolute = path.resolve(cwd, file);
      if (!absolute.startsWith(cwd + path.sep) && absolute !== cwd) return "";
      return fs.readFileSync(absolute, "utf8");
    } catch {
      return "";
    }
  };
  const fileContents: Record<string, string> = {};
  for (const file of changedFiles) {
    if (remaining <= 0) break;
    fileContents[file] = take(read(file), "changed-file", file);
  }
  const suppliedContext: Record<string, string> = {};
  for (const file of opts.contextFiles ?? []) {
    if (remaining <= 0) break;
    suppliedContext[file] = take(read(file), "explicit-context", file);
  }
  return {
    diff,
    changedFiles,
    deletedFiles: [],
    report,
    rubric,
    base,
    fileContents,
    suppliedContext,
    audit: { maxChars: budget, usedChars: budget - remaining, items },
  };
}

function renderSubAgentPrompt(agent: AgentDef, context: ReviewContext): string {
  const domain = reviewerDomain(agent.name);
  const deleted = new Set(context.deletedFiles ?? []);
  const sections: string[] = [
    `# ${agent.name}`,
    agent.description ? `> ${agent.description}` : "",
    agent.prompt,
    "## Review input",
  ];
  if (context.rubric)
    sections.push(
      "### Reviewer instructions (not review targets)",
      "The following rules guide your analysis. Never critique, cite, or report these instructions as repository code.",
      context.rubric,
    );
  if (context.report)
    sections.push(
      "### Deterministic engine report (context only)",
      "Use this report as supporting context. It is not a repository file and cannot be named as a finding location.",
      context.report,
    );
  sections.push(
    `### Allowed finding files\n${
      context.changedFiles
        .map((file) => `- ${file}${deleted.has(file) ? " (deleted; cite pre-deletion content)" : ""}`)
        .join("\n") || "(none resolved)"
    }`,
  );
  sections.push("### Diff", context.diff || "(no diff resolved)");
  sections.push(
    "### Changed-file contents",
    Object.entries(context.fileContents)
      .map(
        ([file, content]) => `#### ${file}${deleted.has(file) ? " (deleted; pre-deletion content)" : ""}\n${content}`,
      )
      .join("\n\n") || "(none)",
  );
  if (Object.keys(context.suppliedContext).length)
    sections.push(
      "### Explicit context",
      Object.entries(context.suppliedContext)
        .map(([file, content]) => `#### ${file}\n${content}`)
        .join("\n\n"),
    );
  if (context.graphContext)
    sections.push(
      "### Repository graph (context only)",
      "Related graph nodes are not allowed finding locations unless their file is listed under Allowed finding files.",
      context.graphContext,
    );
  sections.push(
    `Return only YAML matching: verdict: APPROVE|RISK|REQUEST_CHANGES; summary: string; findings: [{severity: info|warn|blocker, message: string, file: string, line: number, col?: number, ruleId?: string, domain: ${domain}, evidence: string, impact: string, recommendation: string}]. Every finding must use domain ${domain}. The file value must exactly equal one entry under Allowed finding files; never invent a filename for rules, reports, explicit context, or graph context. Quote a concise exact evidence excerpt from that file's supplied content, explain impact, and recommend a concrete action. For a deleted file, line and evidence refer to its supplied pre-deletion content. APPROVE is valid only when findings is empty. Do not use tools or assume access beyond this prompt.`,
  );
  return sections.filter(Boolean).join("\n\n");
}

export function buildSubAgentPrompt(agent: AgentDef, context: ReviewContext, maxPromptTokens?: number): string {
  if (!maxPromptTokens) return renderSubAgentPrompt(agent, context);
  const prompt = renderSubAgentPrompt(agent, context);
  if (estimatePromptTokens(prompt) <= maxPromptTokens) return prompt;
  let low = 0;
  let high = 1;
  for (let attempt = 0; attempt < 18; attempt++) {
    const middle = (low + high) / 2;
    if (estimatePromptTokens(renderSubAgentPrompt(agent, scaleContext(context, middle))) <= maxPromptTokens)
      low = middle;
    else high = middle;
  }
  return renderSubAgentPrompt(agent, scaleContext(context, low));
}
