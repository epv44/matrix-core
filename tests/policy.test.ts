import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../src/core/policy.js";
import type { QualityConfig, BaselineData } from "../src/core/types.js";
const cfg: QualityConfig = {
  version:1,
  checks:{ ruff:{enabled:true,required:true}, mypy:{enabled:true,required:false}, pytest:{enabled:true,required:true}, coverage:{enabled:true,required:false} },
  policies:{
    coverage:{ metric:"pytest.coverage_percent", degradation_allowed:0, absolute_min:70 },
    ruff:{ metric:"ruff.violation_count", max:0, max_increase_percent:5 },
    mypy:{ metric:"mypy.error_count", max:0 }
  }
};
describe("policy",()=>{
  it("fails absolute_min",()=>{
    const res=evaluatePolicy({"pytest.coverage_percent":60} as any,cfg,null);
    expect(res.passed).toBe(false);
    expect(res.failures.some(f=>f.includes("coverage"))).toBe(true);
  });
  it("passes when above min",()=>{
    const res=evaluatePolicy({"pytest.coverage_percent":80, "ruff.violation_count":0, "mypy.error_count":0} as any,cfg,null);
    expect(res.passed).toBe(true);
  });
  it("detects degradation",()=>{
    const baseline: BaselineData = { version:1, timestamp:new Date().toISOString(), metrics:{ "pytest.coverage_percent":85 } };
    const res=evaluatePolicy({"pytest.coverage_percent":80} as any,cfg,baseline);
    expect(res.passed).toBe(false);
    expect(res.failures[0]).toMatch(/degraded/);
  });
  it("allows no degradation",()=>{
    const baseline: BaselineData = { version:1, timestamp:new Date().toISOString(), metrics:{ "pytest.coverage_percent":85 } };
    const res=evaluatePolicy({"pytest.coverage_percent":85} as any,cfg,baseline);
    expect(res.passed).toBe(true);
  });
  it("detects max increase",()=>{
    const baseline: BaselineData = { version:1, timestamp:new Date().toISOString(), metrics:{ "ruff.violation_count":10 } };
    const res=evaluatePolicy({"ruff.violation_count":11} as any,cfg,baseline);
    expect(res.passed).toBe(false);
  });
})
