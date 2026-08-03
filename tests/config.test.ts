import { describe, it, expect } from "vitest";
import { resolveConfig } from "../src/core/config-resolver.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
describe("config-resolver",()=>{
  it("resolves nearest file wins monorepo",()=>{
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"qe-"));
    const root=path.join(tmp,"repo");
    const svc=path.join(root,"svc");
    fs.mkdirSync(svc,{recursive:true});
    fs.writeFileSync(path.join(root,"quality.yaml"),"version: 1\nchecks:\n  ruff: {enabled: true, required: true}\npolicies: {}\n");
    fs.writeFileSync(path.join(svc,"quality.yaml"),"version: 1\nchecks:\n  ruff: {enabled: false, required: false}\npolicies: {}\n");
    const res=resolveConfig({cwd:svc});
    expect(res.configPath).toContain("svc");
    expect(res.config.checks["ruff"].enabled).toBe(false);
    fs.rmSync(tmp,{recursive:true,force:true});
  });
  it("returns default when none found",()=>{
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"qe-"));
    const res=resolveConfig({cwd:tmp});
    expect(res.isDefault).toBe(true);
    expect(res.config.checks["ruff"]).toBeDefined();
    fs.rmSync(tmp,{recursive:true,force:true});
  });
})
