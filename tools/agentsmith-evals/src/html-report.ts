/** Render a generic AgentSmith suite/run report as one deterministic HTML document. */
export type EvalHtmlInput = { suite?: unknown; run?: unknown; baseline?: unknown; comparison?: unknown; [key: string]: unknown };

const escapeHtml = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const safeJson = (value: unknown) => JSON.stringify(value ?? null).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const status = (value: unknown) => { const s = String(value ?? "N/A").toUpperCase(); return ["PASS", "FAIL", "PARTIAL", "INCOMPLETE", "ERROR", "INCOMPATIBLE", "DRAFT", "N/A"].includes(s) ? s : "N/A"; };

function rows(value: unknown, key = "root"): string {
  if (value === null || typeof value !== "object") return `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`;
  if (Array.isArray(value)) return value.length ? value.map((v, i) => rows(v, `${key}[${i}]`)).join("") : `<tr><th>${escapeHtml(key)}</th><td>[]</td></tr>`;
  return Object.entries(value).map(([k, v]) => rows(v, key === "root" ? k : `${key}.${k}`)).join("");
}
const table = (title: string, value: unknown) => `<div class="metric"><h3>${escapeHtml(title)}</h3><table><tbody>${rows(value)}</tbody></table></div>`;
const section = (id: string, title: string, value: unknown) => `<section id="${escapeHtml(id)}"><h2>${escapeHtml(title)}</h2>${table(title, value)}</section>`;

export function renderEvalHtml(input: EvalHtmlInput): string {
  const run = input.run ?? input;
  const record = run && typeof run === "object" ? run as Record<string, unknown> : {};
  const badge = status(record.status ?? record.outcome);
  const links = [["overview", "Overview"], ["suites", "Suites"], ["matrix", "Component Matrix"], ["detail", "Case Detail"], ["comparison", "Tier/Mode comparison"], ["pipeline", "Pipeline stages"], ["graph", "Graph/Risk"], ["lifecycle", "Finding Lifecycle"], ["gaps", "Gaps"], ["hillclimb", "Hill-climb"], ["raw", "Raw data"]].map(([id, label]) => `<a href="#${id}">${label}</a>`).join("");
  const sections = [
    section("overview", "Overview", run), section("suites", "Suites", input.suite ?? record.suites), section("matrix", "Component Matrix", record.componentMatrix),
    section("detail", "Case Detail", record.cases), section("comparison", "Tier/Mode comparison", input.comparison ?? record.comparisons), section("pipeline", "Pipeline stages", record.pipeline ?? record.stages),
    section("graph", "Graph/Risk", record.graph ?? record.risk), section("lifecycle", "Finding Lifecycle", record.findingLifecycle ?? record.findings), section("gaps", "Gaps", record.gaps ?? record.coverage),
    section("hillclimb", "Hill-climb", record.hillClimb ?? record.hillclimb), section("raw", "Raw data", input),
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentSmith Evaluation Report</title><style>body{font:14px system-ui,sans-serif;margin:0;background:#f5f7fb;color:#20242a}nav{position:sticky;top:0;background:#17202a;padding:12px;display:flex;gap:14px;flex-wrap:wrap}nav a{color:#fff;text-decoration:none}main{max-width:1200px;margin:auto;padding:20px}section{background:#fff;border:1px solid #d9e0e8;border-radius:8px;margin:16px 0;padding:16px}h2{margin-top:0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e0e5eb;padding:5px;text-align:left;vertical-align:top}th{background:#f0f3f7;white-space:nowrap}.state{font-weight:700;padding:3px 7px;border-radius:4px}.pass{color:#176b35;background:#d9f4e2}.fail,.error{color:#9c1c1c;background:#ffe0e0}.partial,.incomplete{color:#855b00;background:#fff0c2}</style></head><body><nav>${links}</nav><main><h1>AgentSmith Evaluation Report <span class="state ${badge.toLowerCase()}">${badge}</span></h1>${sections}</main><script type="application/json" id="report-data">${safeJson(input)}</script><script>document.querySelectorAll('section').forEach(s=>{const h=s.querySelector('h2');if(h)h.tabIndex=0})</script></body></html>`;
}
