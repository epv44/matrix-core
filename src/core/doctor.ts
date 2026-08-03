import fs from "node:fs";
import { detectAll } from "./capability.js";
import { resolveConfig } from "./config-resolver.js";
import { getBaselinePath } from "./baseline.js";
import { isGitRepo } from "./changed.js";
import { formatDoctorReport } from "./report.js";
import type { DoctorResult, ResolvedConfig, Capability } from "./types.js";
export function runDoctor(opts:{configFlag?:string;cwd?:string;root?:string}):DoctorResult{
  const resolved:ResolvedConfig=resolveConfig({configFlag:opts.configFlag,cwd:opts.cwd,root:opts.root});
  const capabilities:Capability[]=detectAll(resolved.config);
  const configRoot=resolved.configRoot;
  const baselinePath=getBaselinePath(configRoot);
  const baselineExists=fs.existsSync(baselinePath);
  const gitRepo=isGitRepo(opts.cwd||opts.root||process.cwd());
  const passed=capabilities.filter(c=>c.required&&!c.found).length===0;
  return{capabilities,config:resolved,baselineExists,baselinePath,gitRepo,passed};
}
export function doctorToJson(result:DoctorResult){ return JSON.stringify({passed:result.passed,gitRepo:result.gitRepo,baselineExists:result.baselineExists,baselinePath:result.baselinePath,configPath:result.config.configPath,configRoot:result.config.configRoot,isDefault:result.config.isDefault,capabilities:result.capabilities},null,2); }
export function doctorToReport(result:DoctorResult):string{ return formatDoctorReport(result); }
