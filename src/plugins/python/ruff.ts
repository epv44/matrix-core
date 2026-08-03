import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
function tryRuff(root: string, files: string[] | undefined): { stdout: string; status: number | null; err?: string } {
  const args = ["check", "--output-format", "json"];
  const cfg = files && files.length>0 ? files : ["."];
  args.push(...cfg);
  try {
    const res = spawnSync("ruff", args, { cwd: root, encoding: "utf8", timeout: 30000 });
    if (res.error) return { stdout: "", status: null, err: (res.error as any).message };
    return { stdout: res.stdout || "", status: res.status, err: res.stderr || undefined };
  } catch (e:any) { return { stdout:"", status:null, err:e.message }; }
}
export const ruffPlugin: QualityPlugin = {
  name:"ruff",
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("ruff");
    if (!cap || !cap.found) {
      const req = cap?.required ?? true;
      return { plugin:"ruff", status: req?"FAIL":"SKIPPED", observations:[{message:"ruff executable not found", severity:req?"error":"info"}], metrics:{"ruff.violation_count":null,"ruff.complexity.max":null}, reason:req?"executable not found but required=true":"executable not found, required=false" };
    }
    let targets = ctx.changedFiles;
    const extraArgs = ctx.config?.checks["ruff"]?.args || [];
    if (!ctx.full && targets) {
      targets = targets.filter(f=>f.endsWith(".py"));
      if (targets.length===0) return { plugin:"ruff", status:"PASS", observations:[], metrics:{"ruff.violation_count":0,"ruff.complexity.max":0}, score:100, reason:"no python files changed" };
    } else targets = undefined;
    try {
      const res = (()=>{ const a=["check","--output-format","json",...(extraArgs as string[]),...(targets||["."])]; const r=spawnSync("ruff",a,{cwd:ctx.root,encoding:"utf8",timeout:30000}); return {stdout:r.stdout||"",status:r.status,err:r.stderr}; })();
      if (res.status===null && !res.stdout) return { plugin:"ruff", status:"ERROR", observations:[{message:`ruff execution failed: ${res.err?.slice(0,2000)}`, severity:"error"}], metrics:{"ruff.violation_count":null}, reason:"engine/plugin malfunction" };
      let violations:any[]=[];
      try{ const t=res.stdout.trim(); if(t){ const p=JSON.parse(t); if(Array.isArray(p)) violations=p; } }catch{ violations=[]; }
      const obs:Observation[]=violations.map((v:any)=>({ file:v.filename||v.location?.path, line:v.location?.row||v.row||v.line, col:v.location?.column, message:v.message||JSON.stringify(v), severity:"error" as const, ruleId:v.code||v.rule }));
      const count=violations.length;
      return { plugin:"ruff", status:count>0?"FAIL":"PASS", score:count===0?100:Math.max(0,100-count), observations:obs, metrics:{"ruff.violation_count":count,"ruff.complexity.max":null}, reason:count>0?`${count} violations`:undefined };
    } catch (e:any) { return { plugin:"ruff", status:"ERROR", observations:[{message:e.message,severity:"error"}], metrics:{"ruff.violation_count":null}, reason:"exception" }; }
  },
};
