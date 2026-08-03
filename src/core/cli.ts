#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import { runEngine } from "./runner.js";
import { runDoctor, doctorToJson, doctorToReport } from "./doctor.js";
import { loadBaseline, saveBaseline, getBaselinePath, hashConfig, diffBaseline } from "./baseline.js";
import { resolveConfig } from "./config-resolver.js";
const program=new Command();
program.name("quality").description("Standalone Quality Engine").version("0.1.0");
program.command("run").description("Run quality checks").option("-c, --config <path>","Path to quality.yaml").option("--changed","Run only on changed files (git diff)",false).option("--full","Run full checks (default)",false).option("--base <branch>","Base branch for --changed","main").option("--root <path>","Project root",process.cwd()).option("--json","JSON output",false).action(async(opts)=>{
  try{
    const isChanged=opts.changed && !opts.full;
    const result=await runEngine({configFlag:opts.config,cwd:opts.root,changed:isChanged,full:opts.full||!opts.changed,baseBranch:opts.base,json:opts.json});
    if(opts.json) console.log(JSON.stringify({passed:result.passed,metrics:result.metrics,results:result.results,failures:result.failures},null,2));
    else console.log(result.report);
    process.exit(result.passed?0:1);
  }catch(e:any){ console.error(`Error: ${e.message}`); process.exit(2); }
});
program.command("doctor").description("Check environment capabilities").option("-c, --config <path>","Path to quality.yaml").option("--root <path>","Project root",process.cwd()).option("--json","JSON output",false).action(async(opts)=>{
  try{ const res=runDoctor({configFlag:opts.config,cwd:opts.root}); if(opts.json) console.log(doctorToJson(res)); else console.log(doctorToReport(res)); process.exit(res.passed?0:1);}catch(e:any){ console.error(`doctor error: ${e.message}`); process.exit(2); }
});
const baselineCmd=program.command("baseline").description("Manage baseline");
baselineCmd.command("create").description("Create baseline from current metrics (explicit)").option("-c, --config <path>","Path to quality.yaml").option("--root <path>","Project root",process.cwd()).option("--force","Overwrite existing baseline",false).action(async(opts)=>{
  try{
    const resolved=resolveConfig({configFlag:opts.config,cwd:opts.root});
    const bp=getBaselinePath(resolved.configRoot);
    if(fs.existsSync(bp) && !opts.force){ console.error(`Baseline exists at ${bp}. Use --force to overwrite.`); process.exit(1); }
    const result=await runEngine({configFlag:opts.config,cwd:opts.root,full:true});
    const metrics:Record<string,number>={};
    for(const [k,v] of Object.entries(result.metrics)) if(v!=null) metrics[k]=v;
    const saved=saveBaseline(resolved.configRoot,metrics,hashConfig(resolved.config));
    console.log(`Baseline created at ${bp}`); console.log(JSON.stringify(saved,null,2)); process.exit(0);
  }catch(e:any){ console.error(`baseline create failed: ${e.message}`); process.exit(2); }
});
baselineCmd.command("show").description("Show current baseline").option("--root <path>","Project root",process.cwd()).option("--json","JSON",false).action(async(opts)=>{
  try{
    const resolved=resolveConfig({cwd:opts.root});
    const b=loadBaseline(resolved.configRoot);
    if(!b){ console.log("No baseline found. Run: quality baseline create"); process.exit(3); }
    if(opts.json) console.log(JSON.stringify(b,null,2));
    else{ console.log(`Baseline @ ${getBaselinePath(resolved.configRoot)}`); console.log(`Timestamp: ${b.timestamp}`); console.log("Metrics:"); for(const [k,v] of Object.entries(b.metrics)) console.log(`  ${k}: ${v}`); }
  }catch(e:any){ console.error(e.message); process.exit(2); }
});
baselineCmd.command("diff").description("Diff current metrics vs baseline").option("-c, --config <path>","Config path").option("--root <path>","Project root",process.cwd()).option("--json","JSON",false).action(async(opts)=>{
  try{
    const resolved=resolveConfig({configFlag:opts.config,cwd:opts.root});
    const b=loadBaseline(resolved.configRoot);
    if(!b){ console.log("No baseline found."); process.exit(3); }
    const result=await runEngine({configFlag:opts.config,cwd:opts.root,full:true});
    const diffs=diffBaseline(result.metrics,b);
    if(opts.json) console.log(JSON.stringify(diffs,null,2));
    else{ console.log(`Baseline: ${b.timestamp}`); console.log("Diff:"); for(const d of diffs) console.log(`  ${d.metric}: ${d.baseline} -> ${d.current} delta=${d.delta} (${d.deltaPct?.toFixed(2)}%)`); if(diffs.length===0) console.log("  no metrics to compare or perfect match"); }
  }catch(e:any){ console.error(e.message); process.exit(2); }
});
program.command("config").description("Config utilities").command("show").option("-c, --config <path>","Config path").option("--root <path>","Project root",process.cwd()).action(async(opts)=>{ const resolved=resolveConfig({configFlag:opts.config,cwd:opts.root}); console.log(JSON.stringify({path:resolved.configPath,root:resolved.configRoot,isDefault:resolved.isDefault,config:resolved.config},null,2)); });
program.parse(process.argv);
