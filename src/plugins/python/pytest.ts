import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
function findPy(caps: Map<string, Capability>): string | null {
  const p = caps.get("python")?.path?.split(" ")[0];
  if (p) return p;
  for (const c of ["python3","python"]) {
    const r = spawnSync(c,["--version"],{encoding:"utf8",timeout:2000});
    if (!r.error && r.status===0) return c;
  }
  return null;
}
function getPBin(py:string|null,caps:Map<string,Capability>){
  const cap=caps.get("pytest");
  if(cap?.path?.includes("-m pytest"))return{bin:[cap.path.split(" ")[0],"-m","pytest"],found:true};
  if(cap?.path)return{bin:[cap.path],found:true};
  if(py){const r=spawnSync(py,["-m","pytest","--version"],{encoding:"utf8",timeout:3000}); if(!r.error&&r.status===0)return{bin:[py,"-m","pytest"],found:true};}
  const r=spawnSync("pytest",["--version"],{encoding:"utf8",timeout:2000});
  if(!r.error&&r.status===0)return{bin:["pytest"],found:true};
  return{bin:[] as string[],found:false};
}
function getCov(py:string|null){
  if(py){
    const c1=spawnSync(py,["-c","import pytest_cov"],{encoding:"utf8",timeout:2000});
    if(!c1.error&&c1.status===0)return{mode:"pytest-cov" as const,pref:[py,"-m","pytest"]};
    const c2=spawnSync(py,["-m","coverage","--version"],{encoding:"utf8",timeout:2000});
    if(!c2.error&&c2.status===0)return{mode:"coverage" as const,pref:[py,"-m","coverage"]};
  }
  const c3=spawnSync("coverage",["--version"],{encoding:"utf8",timeout:2000});
  if(!c3.error&&c3.status===0)return{mode:"coverage" as const,pref:["coverage"]};
  const c4=spawnSync("pytest",["--version"],{encoding:"utf8",timeout:2000});
  const out=(c4.stdout||"")+(c4.stderr||"");
  if(out.toLowerCase().includes("cov"))return{mode:"pytest-cov" as const,pref:["pytest"]};
  return{mode:"none" as const,pref:[] as string[]};
}
function runCov(root:string,b:string[],m:string,p:string[]){
  const j=path.join(root,"coverage.json");
  try{if(fs.existsSync(j))fs.unlinkSync(j);}catch{}
  if(m==="pytest-cov"){
    const args=[...b.slice(1),"--cov","--cov-report=json:"+j,"--cov-report=","-q"];
    const r=spawnSync(b[0],args,{cwd:root,encoding:"utf8",timeout:120000});
    return{out:(r.stdout||"")+(r.stderr||""),st:r.status,cp:fs.existsSync(j)?j:null};
  }
  if(m==="coverage"){
    const rt=spawnSync(p[0],[...p.slice(1),"run","-m","pytest","-q"],{cwd:root,encoding:"utf8",timeout:120000});
    if(rt.status===null)return{out:rt.stderr||"",st:null,cp:null};
    spawnSync(p[0],[...p.slice(1),"json","-o",j],{cwd:root,encoding:"utf8",timeout:10000});
    return{out:(rt.stdout||"")+(rt.stderr||""),st:rt.status,cp:fs.existsSync(j)?j:null};
  }
  const r=spawnSync(b[0],[...b.slice(1),"-q"],{cwd:root,encoding:"utf8",timeout:120000});
  return{out:(r.stdout||"")+(r.stderr||""),st:r.status,cp:null};
}
function parsePct(p:string|null):number|null{
  if(!p)return null;
  try{
    if(!fs.existsSync(p))return null;
    const d=JSON.parse(fs.readFileSync(p,"utf8"));
    if(typeof d.totals?.percent_covered==="number")return d.totals.percent_covered;
    if(typeof d.totals?.percent_covered_display==="string")return parseFloat(d.totals.percent_covered_display);
    return null;
  }catch{return null;}
}
export const pytestPlugin: QualityPlugin = {
  name:"pytest",
  async run(ctx:RunCtx,caps:Map<string,Capability>):Promise<PluginResult>{
    const cap=caps.get("pytest");
    if(!cap||!cap.found){
      const req=cap?.required??true;
      return{plugin:"pytest",status:req?"FAIL":"SKIPPED",observations:[{message:"pytest executable not found",severity:req?"error":"info"}],metrics:{"pytest.test_count":null,"pytest.passed":null,"pytest.failed":null,"pytest.coverage_percent":null},reason:req?"executable not found but required=true":"executable not found, required=false"};
    }
    if(!ctx.full&&ctx.changedFiles&&ctx.changedFiles.length>0){
      const has=ctx.changedFiles.some(f=>f.endsWith(".py"));
      if(!has&&!ctx.changedFiles.some(f=>f.includes("test_")||f.includes("/tests/"))){
        return{plugin:"pytest",status:"PASS",observations:[],metrics:{"pytest.test_count":0,"pytest.passed":0,"pytest.failed":0,"pytest.coverage_percent":null},score:100,reason:"no relevant files changed"};
      }
    }
    try{
      const py=findPy(caps);
      const {bin,found}=getPBin(py,caps);
      if(!found)return{plugin:"pytest",status:"ERROR",observations:[{message:"could not resolve pytest binary",severity:"error"}],metrics:{"pytest.test_count":null,"pytest.coverage_percent":null},reason:"binary resolution failed"};
      const cov=getCov(py);
      const mode=cov.mode;
      const run=runCov(ctx.root,bin,mode,cov.pref);
      if(run.st===null)return{plugin:"pytest",status:"ERROR",observations:[{message:run.out.slice(0,2000),severity:"error"}],metrics:{"pytest.test_count":null,"pytest.coverage_percent":null},reason:"execution error"};
      if(run.st===5){
        return{plugin:"pytest",status:"SKIPPED",observations:[{message:"no tests collected (pytest exit 5)",severity:"info"}],metrics:{"pytest.test_count":0,"pytest.passed":0,"pytest.failed":0,"pytest.coverage_percent":null},score:null,reason:"no tests ran"};
      }
      const passed=(run.out.match(/(\d+)\s+passed/)||[])[1]?parseInt((RegExp.$1 as any),10):0;
      const failed=(run.out.match(/(\d+)\s+failed/)||[])[1]?parseInt((RegExp.$1 as any),10):0;
      const pct=parsePct(run.cp);
      const obs:Observation[]=[];
      if(run.st!==0)obs.push({message:run.out.slice(0,5000),severity:"error",ruleId:"pytest"});
      if(mode==="none")obs.push({message:"coverage enabled but pytest-cov/coverage not found",severity:"warn",ruleId:"coverage"});
      const status=run.st===0?"PASS":"FAIL";
      return{plugin:"pytest",status,score:status==="PASS"?100:0,observations:obs,metrics:{"pytest.test_count":passed+failed||passed||null,"pytest.passed":passed||null,"pytest.failed":failed||null,"pytest.coverage_percent":pct},reason:status==="FAIL"?`pytest status ${run.st}`:pct!=null?`coverage ${pct.toFixed(1)}%`:undefined};
    }catch(e:any){
      return{plugin:"pytest",status:"ERROR",observations:[{message:e.message,severity:"error"}],metrics:{"pytest.test_count":null,"pytest.coverage_percent":null},reason:"exception"};
    }
  },
};
