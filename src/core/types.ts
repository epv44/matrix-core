export type PluginStatus = "PASS" | "FAIL" | "SKIPPED" | "ERROR";
export interface Observation {
  file?: string;
  line?: number;
  col?: number;
  message: string;
  severity: "error" | "warn" | "info";
  ruleId?: string;
}
export interface PluginResult {
  plugin: string;
  status: PluginStatus;
  score?: number | null;
  observations: Observation[];
  metrics?: Record<string, number | null>;
  reason?: string;
}
export interface Capability {
  name: string;
  found: boolean;
  version?: string;
  path?: string;
  required: boolean;
  hint?: string;
}
export interface CheckCfg {
  enabled: boolean;
  required: boolean;
  args?: string[];
}
export interface PolicyCfg {
  metric: string;
  degradation_allowed?: number;
  max_increase_percent?: number;
  max?: number;
  absolute_min?: number;
}
export interface QualityConfig {
  version: number;
  checks: Record<string, CheckCfg>;
  policies: Record<string, PolicyCfg>;
  plugins?: string[];
}
export interface ResolvedConfig {
  config: QualityConfig;
  configPath: string | null;
  configRoot: string;
  isDefault: boolean;
}
export interface BaselineData {
  version: number;
  timestamp: string;
  configHash?: string;
  metrics: Record<string, number>;
}
export interface RunCtx {
  root: string;
  configRoot: string;
  changedFiles?: string[];
  full: boolean;
  baseBranch?: string;
  config?: QualityConfig;
}
export interface EngineResult {
  passed: boolean;
  results: PluginResult[];
  metrics: Record<string, number | null>;
  baseline: BaselineData | null;
  config: ResolvedConfig;
  capabilities: Capability[];
  failures: string[];
  report: string;
}
export interface DoctorResult {
  capabilities: Capability[];
  config: ResolvedConfig;
  baselineExists: boolean;
  baselinePath: string;
  gitRepo: boolean;
  passed: boolean;
}
