import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Capability, Observation, PluginResult, RunCtx } from "../../core/types.js";
import type { QualityPlugin } from "../interface.js";
import { verboseEnabled } from "../../core/verbose.js";
import { walkFiles } from "../../core/filesystem.js";

interface ExtractedFragment {
  file: string;
  line: number;
  callLine: number;
  sink: string;
  sql: string;
}

interface ExtractionResult {
  fragments: ExtractedFragment[];
  unresolved: Array<{ file: string; line: number; sink: string; reason: string }>;
  errors: Array<{ file: string; message: string }>;
}

interface GeneratedRegion {
  fragment: ExtractedFragment;
  startLine: number;
  endLine: number;
}

function relevantFiles(ctx: RunCtx) {
  const facet = ctx.sqlFacet!;
  const all: string[] = [];
  walkFiles(facet.sourceRoot, (file) => {
    if (facet.sources.includes("files") && /\.(?:sql|sql\.j2|dml|ddl)$/i.test(file)) all.push(file);
    if (facet.sources.includes("python") && file.endsWith(".py")) all.push(file);
  });
  if (ctx.full || !ctx.changedFiles) return all;
  const changed = new Set(ctx.changedFiles.map((file) => path.resolve(ctx.root, file)));
  return all.filter((file) => changed.has(file));
}

function extractorAsset() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../policy/python-sql-extract.py.txt");
}

function extract(python: string, files: string[], temporary: string): ExtractionResult {
  if (files.length === 0) return { fragments: [], unresolved: [], errors: [] };
  const request = path.join(temporary, "extract.json");
  fs.writeFileSync(request, JSON.stringify({ files }));
  if (verboseEnabled()) {
    console.debug(`[matrix-core] sqlfluff-extract argv: ${python} ${extractorAsset()} ${request}`);
  }
  const run = spawnSync(python, [extractorAsset(), request], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (verboseEnabled()) {
    console.debug(
      `[matrix-core] sqlfluff-extract exit=${run.status} stdout=${(run.stdout || "").slice(0, 500)} stderr=${(run.stderr || "").slice(0, 500)}`,
    );
  }
  if (run.error || run.status !== 0)
    throw new Error(`embedded SQL extraction failed: ${run.error?.message ?? run.stderr ?? "unknown error"}`);
  try {
    return JSON.parse(run.stdout) as ExtractionResult;
  } catch {
    throw new Error("embedded SQL extractor produced malformed JSON");
  }
}

export const sqlfluffPlugin: QualityPlugin = {
  name: "sql.sqlfluff",
  pack: "sql",
  aliases: ["sqlfluff"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const facet = ctx.sqlFacet;
    const cap = caps.get("sqlfluff") ?? caps.get("sql.sqlfluff");
    const binary = facet?.toolEnvironment.binaries.sqlfluff;
    const python = facet?.toolEnvironment.binaries.python;
    if (!facet || !cap?.found || !binary || (facet.sources.includes("python") && !python))
      return {
        plugin: "sql.sqlfluff",
        status: "FAIL",
        observations: [
          {
            message: "SQLFluff and its Python environment are missing from the designated SQL facet",
            severity: "error",
          },
        ],
        metrics: { "sql.sqlfluff.violation_count": null, "sql.extraction.unresolved_count": null },
        reason: "required SQL tool environment missing",
      };

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-sqlfluff-"));
    try {
      const inputs = relevantFiles(ctx);
      const standalone = inputs.filter((file) => !file.endsWith(".py"));
      const pythonFiles = inputs.filter((file) => file.endsWith(".py"));
      const extraction = python
        ? extract(python, pythonFiles, temporary)
        : { fragments: [], unresolved: [], errors: [] };
      const observations: Observation[] = [
        ...extraction.unresolved.map((finding) => ({
          file: path.relative(ctx.configRoot, finding.file),
          line: finding.line,
          message: `${finding.sink}(): ${finding.reason}`,
          severity: "error" as const,
          ruleId: "sql.dynamic-unresolved",
        })),
        ...extraction.errors.map((error) => ({
          file: path.relative(ctx.configRoot, error.file),
          message: error.message,
          severity: "error" as const,
          ruleId: "sql.extraction-error",
        })),
      ];
      const generated = new Map<string, GeneratedRegion[]>();
      const uniqueFragments = [
        ...new Map(
          extraction.fragments.map((fragment) => [`${fragment.file}\0${fragment.line}\0${fragment.sql}`, fragment]),
        ).values(),
      ];
      const grouped = new Map<string, ExtractedFragment[]>();
      for (const fragment of uniqueFragments) {
        const list = grouped.get(fragment.file) ?? [];
        list.push(fragment);
        grouped.set(fragment.file, list);
      }
      [...grouped.values()].forEach((fragments, index) => {
        const file = path.join(temporary, `source-${index}.sql`);
        const chunks: string[] = [];
        const regions: GeneratedRegion[] = [];
        let nextLine = 1;
        for (const fragment of fragments) {
          const sql = fragment.sql.replace(/\n+$/, "").replace(/;?$/, ";");
          const lineCount = sql.split("\n").length;
          regions.push({ fragment, startLine: nextLine, endLine: nextLine + lineCount - 1 });
          chunks.push(sql);
          nextLine += lineCount + 1;
        }
        fs.writeFileSync(file, `${chunks.join("\n\n")}\n`);
        generated.set(path.resolve(file), regions);
      });
      const targets = [...standalone, ...generated.keys()];
      if (targets.length > 0) {
        const templaterConfig = path.join(temporary, "sqlfluff-project.cfg");
        const options = Object.entries(facet.templater_options ?? {});
        if (options.length > 0) {
          const section = options
            .map(([key, value]) => `${key} = ${value}`)
            .join("\n");
          fs.writeFileSync(
            templaterConfig,
            `[sqlfluff:templater:${facet.templater}]\n${section}\n`,
          );
        }
        const args = [
          "lint",
          "--format",
          "json",
          ...(ctx.policyCheck?.args ?? []),
          ...(options.length > 0 ? ["--config", templaterConfig] : []),
          "--dialect",
          facet.dialect,
          "--templater",
          facet.templater,
          ...targets,
        ];
        if (verboseEnabled()) {
          console.debug(`[matrix-core] sqlfluff argv: ${binary} ${args.join(" ")}`);
        }
        const run = spawnSync(binary, args, {
          cwd: ctx.root,
          encoding: "utf8",
          timeout: 120000,
          maxBuffer: 30 * 1024 * 1024,
        });
        if (verboseEnabled()) {
          console.debug(
            `[matrix-core] sqlfluff exit=${run.status} stdout=${(run.stdout || "").slice(0, 500)} stderr=${(run.stderr || "").slice(0, 500)}`,
          );
        }
        if (run.error || run.status === null)
          return {
            plugin: "sql.sqlfluff",
            status: "ERROR",
            observations: [
              ...observations,
              { message: run.error?.message ?? run.stderr ?? "SQLFluff failed", severity: "error" },
            ],
            metrics: {
              "sql.sqlfluff.violation_count": null,
              "sql.extraction.unresolved_count": extraction.unresolved.length,
            },
            reason: "SQLFluff execution failed",
          };
        let reports: any[];
        try {
          const value = JSON.parse(run.stdout || "[]");
          reports = Array.isArray(value) ? value : [];
        } catch {
          return {
            plugin: "sql.sqlfluff",
            status: "ERROR",
            observations: [...observations, { message: "SQLFluff produced malformed JSON output", severity: "error" }],
            metrics: {
              "sql.sqlfluff.violation_count": null,
              "sql.extraction.unresolved_count": extraction.unresolved.length,
            },
            reason: "malformed SQLFluff output",
          };
        }
        for (const report of reports) {
          const reported = path.resolve(ctx.root, report.filepath ?? report.path ?? "");
          const regions = generated.get(reported);
          for (const violation of report.violations ?? []) {
            const generatedLine = Number(violation.start_line_no ?? 1);
            const region = regions
              ?.filter((candidate) => candidate.startLine <= generatedLine)
              .sort((a, b) => b.startLine - a.startLine)[0];
            observations.push({
              file: path.relative(ctx.configRoot, region?.fragment.file ?? reported),
              line: region
                ? region.fragment.line + Math.max(0, generatedLine - region.startLine)
                : violation.start_line_no,
              col: violation.start_line_pos,
              message: violation.description ?? violation.message ?? "SQLFluff violation",
              severity: "error",
              ruleId: violation.code ?? violation.name,
            });
          }
        }
        if (run.status !== 0 && reports.every((report) => (report.violations ?? []).length === 0))
          observations.push({
            message: run.stderr || "SQLFluff failed without structured findings",
            severity: "error",
            ruleId: "sqlfluff",
          });
      }
      const failed = observations.length > 0;
      return {
        plugin: "sql.sqlfluff",
        status: failed ? "FAIL" : "PASS",
        observations,
        metrics: {
          "sql.sqlfluff.violation_count": observations.filter((item) => item.ruleId !== "sql.dynamic-unresolved")
            .length,
          "sql.extraction.sink_count": extraction.fragments.length + extraction.unresolved.length,
          "sql.extraction.fragment_count": uniqueFragments.length,
          "sql.extraction.unresolved_count": extraction.unresolved.length,
          "sql.files.linted_count": standalone.length,
        },
        score: failed ? 0 : 100,
        reason: failed
          ? extraction.unresolved.length > 0
            ? `${extraction.unresolved.length} executed SQL expressions are not statically resolvable`
            : `${observations.length} SQLFluff violations`
          : undefined,
      };
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
};
