import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { syncPluginVersion, validatePluginSync } from "../scripts/sync-plugin-version.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-plugin-sync-"));
  fs.mkdirSync(path.join(root, "plugins", "matrix-core", ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "plugins", "matrix-core", "skills", "matrix-core"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  fs.writeFileSync(
    path.join(root, "plugins", "matrix-core", ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "matrix-core", version: "0.0.0+codex.old" }),
  );
  fs.writeFileSync(path.join(root, "plugins", "matrix-core", "skills", "matrix-core", "SKILL.md"), "one\n");
  return root;
}

describe("plugin synchronization", () => {
  it("derives the plugin base version from the engine", () => {
    const root = fixture();
    try {
      expect(syncPluginVersion("test-token", root).pluginVersion).toBe("1.2.3+codex.test-token");
      expect(validatePluginSync(root).packageVersion).toBe("1.2.3");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects version divergence and plugin edits without a new cachebuster", () => {
    const root = fixture();
    try {
      syncPluginVersion("test-token", root);
      fs.writeFileSync(path.join(root, "plugins", "matrix-core", "skills", "matrix-core", "SKILL.md"), "two\n");
      expect(() => validatePluginSync(root)).toThrow(/plugin files changed/);
      syncPluginVersion("next-token", root);
      const manifest = path.join(root, "plugins", "matrix-core", ".codex-plugin", "plugin.json");
      const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
      value.version = "9.9.9+codex.next-token";
      fs.writeFileSync(manifest, JSON.stringify(value));
      expect(() => validatePluginSync(root)).toThrow(/does not equal engine package version/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
