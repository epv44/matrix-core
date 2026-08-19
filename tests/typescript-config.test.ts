import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLanguageWorkspaces } from "../src/core/workspace.js";
import { materializeTypeScriptConfig } from "../src/core/typescript-config.js";
import { resolvePolicy } from "../src/core/resolved-policy.js";

describe("central TypeScript configuration", () => {
  it("preserves resolution settings and replaces project quality settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-tsconfig-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"ts-app"}');
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/index.ts"), "export const value: number = 1;\n");
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "esnext",
            moduleResolution: "bundler",
            jsx: "react-jsx",
            paths: { "@/*": ["./src/*"] },
            strict: false,
            skipLibCheck: true,
            noUnusedLocals: false,
            incremental: true,
            plugins: [{ name: "project-diagnostics" }],
          },
          include: ["src/**/*.ts"],
        }),
      );
      const workspace = resolveLanguageWorkspaces(root)[0];
      const policyCheck = resolvePolicy().checks.find((check) => check.id === "typescript.tsc")!;
      const generated = materializeTypeScriptConfig(workspace, policyCheck.configAsset!);
      try {
        const config = JSON.parse(fs.readFileSync(generated.path, "utf8"));
        expect(config.compilerOptions).toMatchObject({
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noUnusedLocals: true,
          incremental: false,
          noEmit: true,
          baseUrl: fs.realpathSync(root),
        });
        expect(config.compilerOptions.plugins).toBeUndefined();
        expect(config.files).toEqual([path.join(fs.realpathSync(root), "src/index.ts")]);
        expect(generated.hash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        generated.cleanup();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
