export type CommitDecision = "finding" | "no_finding" | "insufficient_context";

export type CommitIncompleteReason =
  "missing-commit" | "extra-commit" | "unmatched-witness" | "unmatched-rule" | "malformed";

export type CommitScore =
  | {
      outcome: "finding";
      witnessKey: string;
      basisRuleId: string;
      form: { witnessKey: string; basisRuleId: string };
    }
  | { outcome: "no_finding" }
  | { outcome: "insufficient_context" }
  | { outcome: "incomplete"; reason: CommitIncompleteReason };

export interface CommitScoreResult {
  score: CommitScore;
  thinkingMentionsAllowedWitness: boolean;
}

const COMMIT_LINE = /^DECISION:\s*(finding|no_finding|insufficient_context)\s+WITNESS:\s*(\S+)\s+RULE:\s*(\S+)\s*$/;

export function parseCommitAllowList(workItemBody: string): { witnessKeys: string[]; ruleIds: string[] } {
  const ruleIds = [...workItemBody.matchAll(/^- ([a-z][a-z0-9.-]*) \[categories:/gm)].map((match) => match[1]);
  const witnessSection = workItemBody.split("Control-flow witnesses")[1] ?? "";
  const witnessKeys = [...witnessSection.matchAll(/^- ([A-Za-z0-9][A-Za-z0-9._-]*):/gm)].map((match) => match[1]);
  return {
    witnessKeys: [...new Set(witnessKeys)],
    ruleIds: [...new Set(ruleIds)],
  };
}

export function answerFromGuidedContinuation(continuation: string): string {
  const text = continuation.trim();
  if (text.startsWith("DECISION:")) return text;
  return `DECISION: ${text}`;
}

export function scoreCommitAnswer(input: {
  answer: string;
  allowedWitnessKeys: readonly string[];
  allowedRuleIds: readonly string[];
  thinking?: string;
}): CommitScoreResult {
  const allowedWitnesses = new Set(input.allowedWitnessKeys);
  const allowedRules = new Set(input.allowedRuleIds);
  const lines = input.answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const commitLines = lines.filter((line) => line.startsWith("DECISION:"));
  const thinkingMentionsAllowedWitness = input.allowedWitnessKeys.some((key) => (input.thinking ?? "").includes(key));
  const score = scoreLines(lines, commitLines, allowedWitnesses, allowedRules);
  return { score, thinkingMentionsAllowedWitness };
}

function scoreLines(
  lines: string[],
  commitLines: string[],
  allowedWitnesses: ReadonlySet<string>,
  allowedRules: ReadonlySet<string>,
): CommitScore {
  if (commitLines.length === 0) return { outcome: "incomplete", reason: "missing-commit" };
  if (commitLines.length > 1) return { outcome: "incomplete", reason: "extra-commit" };
  if (lines.at(-1) !== commitLines[0]) return { outcome: "incomplete", reason: "malformed" };
  const match = COMMIT_LINE.exec(commitLines[0]);
  if (!match) return { outcome: "incomplete", reason: "malformed" };
  const decision = match[1] as CommitDecision;
  const witnessKey = match[2];
  const basisRuleId = match[3];
  if (decision !== "finding") return { outcome: decision };
  if (!allowedWitnesses.has(witnessKey)) return { outcome: "incomplete", reason: "unmatched-witness" };
  if (!allowedRules.has(basisRuleId)) return { outcome: "incomplete", reason: "unmatched-rule" };
  return { outcome: "finding", witnessKey, basisRuleId, form: { witnessKey, basisRuleId } };
}
