import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
function tryMypy(root:string, files:string[]|undefined, extra:string[]){
  const args=[...extra, ...(files&&files.length>0?files:["."])];
  try{ const res=spawnSync("mypy",args,{cwd:root,encoding:"utf8",timeout:60000}); if(res.error) return{stdout:"",stderr:(res.error as any).message,status:null}; return{stdout:res.stdout||"",stderr:res.stderr||"",status:res.status}; }catch(e:any){ return{stdout:"",stderr:e.message,status:null}; }
}
function parseOut(out:string):Observation[]{
  const obs:Observation[]=[]; const re=/^(.*?):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.*)$/;
  for(const line of out.split("\n")){ const m=line.match(re); if(m) obs.push({ file:m[1], line:parseInt(m[2],10), col:m[3]?parseInt(m[3],10):undefined, message:m[5], severity:m[4]==="error"?"error":m[4]==="warning"?"warn":"info", ruleId:"mypy"}); }
  return obs;
}
export const mypyPlugin: QualityPlugin={
  name:"mypy",
  async run(ctx:RunCtx,caps:Map<string,Capability>):Promise<PluginResult>{
    const cap=caps.get("mypy");
    if(!cap||!cap.found){ const req=cap?.required??false; return{plugin:"mypy",status:req?"FAIL":"SKIPPED",observations:[{message:"mypy executable not found",severity:req?"error":"info"}],metrics:{"mypy.error_count":null},reason:req?"executable not found but required=true":"executable not found, required=false"}; }
    let targets=ctx.changedFiles;
    const extra=ctx.config?.checks["mypy"]?.args||[];
    if(!ctx.full&&targets){ targets=targets.filter(f=>f.endsWith(".py")); if(targets.length===0) return{plugin:"mypy",status:"PASS",observations:[],metrics:{"mypy.error_count":0},score:100,reason:"no python files changed"}; } else targets=undefined;
    try{
      const result=tryMypy(ctx.root,targets,extra as string[]);
      if(result.status===null) return{plugin:"mypy",status:"ERROR",observations:[{message:`mypy failed: ${result.stderr}`,severity:"error"}],metrics:{"mypy.error_count":null},reason:"engine malfunction"};
      const obs=parseOut(result.stdout+"\n"+result.stderr);
      const errs=obs.filter(o=>o.severity==="error").length;
      return{plugin:"mypy",status:errs>0?"FAIL":"PASS",score:errs===0?100:Math.max(0,100-errs*5),observations:obs,metrics:{"mypy.error_count":errs},reason:errs>0?`${errs} mypy errors`:undefined};
    }catch(e:any){ return{plugin:"mypy",status:"ERROR",observations:[{message:e.message,severity:"error"}],metrics:{"mypy.error_count":null},reason:"exception"}; }
  },
};
