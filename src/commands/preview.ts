import * as p from "@clack/prompts";

import { describeAction, type Plan } from "../engine/planner.js";

export function renderPlan(plan: Plan): string {
  const lines: string[] = [];
  if (plan.actions.length === 0) {
    lines.push("Nothing to change.");
  }
  for (const action of plan.actions) {
    const icon = action.kind === "scaffold" ? "+" : action.kind === "symlink" ? "~" : "*";
    lines.push(`  ${icon} ${describeAction(action, process.cwd())}`);
  }
  for (const warning of plan.warnings) {
    lines.push(`  ! warn: ${warning}`);
  }
  for (const conflict of plan.conflicts) {
    lines.push(
      `  ? conflict: ${conflict.targetPath} differs from ${conflict.canonicalPath}${
        conflict.gitRecoverable ? "" : " (no git safety net)"
      }`,
    );
  }
  for (const blocked of plan.blocked) {
    lines.push(`  x blocked: ${blocked}`);
  }
  return lines.join("\n");
}

export function logPlan(plan: Plan): void {
  p.log.message(renderPlan(plan));
}
