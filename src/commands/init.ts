import * as p from "@clack/prompts";

import { detect } from "../detect.js";
import { applyPlan, makeDefaultChoices, plan } from "../engine/planner.js";
import type { Choices } from "../engine/planner.js";
import { parseAgentList } from "../presets.js";
import { isInteractive, runWizard } from "../ui/prompts.js";
import { logPlan } from "./preview.js";

export interface InitOptions {
  yes: boolean;
  all: boolean;
  dryRun: boolean;
  agents?: string;
}

export async function runInit(options: InitOptions): Promise<number> {
  const root = process.cwd();
  const detection = await detect(root);

  let choices: Choices;
  if (!isInteractive() || options.yes) {
    if (options.agents !== undefined) {
      const { ids, unknown } = parseAgentList(options.agents);
      if (unknown.length > 0) {
        console.error(`--agents: unknown agent id(s): ${unknown.join(", ")}`);
        return 2;
      }
      choices = makeDefaultChoices(detection, { all: options.all, agents: ids });
    } else {
      choices = makeDefaultChoices(detection, { all: options.all });
    }
  } else {
    const wizardChoices = await runWizard(detection);
    if (wizardChoices === null) return 0;
    choices = wizardChoices;
  }

  const planResult = await plan(detection, choices);
  logPlan(planResult);

  const hasWork =
    planResult.actions.length > 0 ||
    planResult.warnings.length > 0 ||
    planResult.blocked.length > 0;

  if (!hasWork) {
    p.outro("Everything already wired up.");
    return 0;
  }

  if (options.dryRun) {
    p.outro("Dry run — no changes were made.");
    return planResult.blocked.length > 0 ? 1 : 0;
  }

  const proceed =
    isInteractive() && !options.yes
      ? await p.confirm({ message: "Apply this plan?", initialValue: true })
      : true;
  if (p.isCancel(proceed)) {
    p.cancel("Cancelled.");
    return 0;
  }
  if (!proceed) {
    p.outro("Aborted. Nothing was changed.");
    return 0;
  }

  const spinner = p.spinner();
  spinner.start("Applying plan…");
  const summary = await applyPlan(detection, planResult, false);
  const parts = [
    summary.scaffolded && `${summary.scaffolded} scaffolded`,
    summary.created && `${summary.created} links created`,
    summary.replaced && `${summary.replaced} replaced`,
    summary.repaired && `${summary.repaired} repaired`,
    summary.generated && `${summary.generated} generated`,
  ].filter(Boolean);
  if (summary.errors.length === 0 && planResult.blocked.length === 0) {
    spinner.stop(`Done: ${parts.join(", ") || "no changes"}.`);
  } else {
    spinner.stop("Finished with warnings.", 1);
  }
  for (const err of summary.errors) p.log.error(err);
  for (const b of planResult.blocked) p.log.warn(`Blocked: ${b}`);
  for (const w of planResult.warnings) p.log.warn(w);
  if (planResult.blocked.length === 0 && summary.errors.length === 0) {
    p.note("Commit the new symlinks so your team gets the same wiring.", "next steps");
  }
  p.outro("Done.");
  return summary.errors.length > 0 ? 1 : planResult.blocked.length > 0 ? 1 : 0;
}
