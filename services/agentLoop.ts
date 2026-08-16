/**
 * Agentic Loop Orchestrator.
 *
 * One loop serves every entry point — a typed task, a voice command, a
 * "Apply Autonomously" tap from the job review screen, or a scheduled run.
 *
 * Turn shape: snapshot -> prompt -> LLM JSON -> execute -> repeat.
 */

import {
  AgentAction,
  AgentDecision,
  AgentRunLogEntry,
  AgentRunResult,
  AgentStatus,
  LLMMessage,
} from '@/types';
import { completeJson } from './apiManager';
import { ActionOutcome, Executor, summariseOutcomes } from './executor';
import { buildVaultContext, loadVault } from './knowledgeVault';
import { AGENT_SYSTEM_PROMPT, TASK_PLANNER_SYSTEM_PROMPT, buildTurnPrompt } from './prompts';
import { loadSettings } from './settings';

export interface RunOptions {
  task: string;
  executor: Executor;
  maxSteps?: number;
  /** Called before each turn so the UI overlay can narrate what is happening. */
  onStatus?: (status: AgentStatus) => void;
  onLog?: (entry: AgentRunLogEntry) => void;
  /** Return false to veto a submission — used by the "confirm before submit" setting. */
  confirmSubmit?: (decision: AgentDecision) => Promise<boolean>;
  signal?: AbortSignal;
}

const SUBMIT_HINTS = /submit|apply now|place order|pay|checkout|confirm|book now|send application/i;

function looksLikeSubmit(decision: AgentDecision, snapshotText: string): boolean {
  return decision.actions.some(
    (a) => a.type === 'click' && (SUBMIT_HINTS.test(a.targetAgentId ?? '') || SUBMIT_HINTS.test(snapshotText))
  );
}

function describeAction(a: AgentAction): string {
  switch (a.type) {
    case 'fill':
      return `filled ${a.targetAgentId} with "${(a.value ?? '').slice(0, 40)}"`;
    case 'upload':
      return `attached a document to ${a.targetAgentId}`;
    case 'navigate':
      return `navigated to ${a.url}`;
    case 'scroll':
      return 'scrolled the page';
    default:
      return `${a.type} ${a.targetAgentId ?? ''}`.trim();
  }
}

function phaseMessageFor(decision: AgentDecision): string {
  if (decision.actions.some((a) => a.type === 'upload')) return 'Agent uploading resume...';
  if (decision.actions.some((a) => a.type === 'fill')) return 'Agent filling the form...';
  if (decision.actions.some((a) => a.type === 'navigate')) return 'Agent navigating...';
  if (decision.actions.some((a) => a.type === 'click')) return 'Agent clicking through...';
  return 'Agent working...';
}

/**
 * Guards against the model referencing elements that vanished between the
 * snapshot and execution, which otherwise wastes a whole turn.
 */
function pruneUnknownTargets(
  decision: AgentDecision,
  knownIds: Set<string>
): { actions: AgentAction[]; dropped: string[] } {
  const dropped: string[] = [];
  const actions = decision.actions.filter((a) => {
    if (!a.targetAgentId) return true;
    if (knownIds.has(a.targetAgentId)) return true;
    dropped.push(a.targetAgentId);
    return false;
  });
  return { actions, dropped };
}

export async function runAgent(options: RunOptions): Promise<AgentRunResult> {
  const settings = await loadSettings();
  const vault = await loadVault();
  const vaultContext = buildVaultContext(vault);
  const maxSteps = options.maxSteps ?? settings.maxAgentSteps;
  const { executor, onStatus, onLog, signal } = options;

  const log: AgentRunLogEntry[] = [];
  const history: string[] = [];
  let lastResults: string | undefined;
  let repeatedFailures = 0;

  const status = (patch: Partial<AgentStatus>, step: number) =>
    onStatus?.({
      phase: 'thinking',
      message: '',
      step,
      maxSteps,
      task: options.task,
      ...patch,
    } as AgentStatus);

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      return { ok: false, summary: 'Stopped by the user.', steps: step - 1, log };
    }

    status({ phase: 'reading_page', message: 'Agent reading the page...' }, step);

    let snapshot;
    try {
      snapshot = await executor.requestSnapshot();
    } catch (err) {
      return {
        ok: false,
        summary: `Could not read the page: ${err instanceof Error ? err.message : String(err)}`,
        steps: step - 1,
        log,
      };
    }

    status({ phase: 'thinking', message: 'Agent deciding what to do...' }, step);

    const messages: LLMMessage[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildTurnPrompt({
          task: options.task,
          vaultContext,
          snapshot,
          history,
          lastActionResults: lastResults,
          step,
          maxSteps,
        }),
      },
    ];

    let decision: AgentDecision;
    let provider: string;
    try {
      const result = await completeJson<AgentDecision>(messages, {
        onFallback: (from, reason) =>
          status({ phase: 'thinking', message: `${from} unavailable (${reason}), switching...` }, step),
      });
      decision = result.value;
      provider = result.provider;
    } catch (err) {
      return {
        ok: false,
        summary: `All AI providers failed: ${err instanceof Error ? err.message : String(err)}`,
        steps: step - 1,
        log,
      };
    }

    decision.actions = Array.isArray(decision.actions) ? decision.actions : [];

    if (decision.needsUser) {
      status({ phase: 'waiting_user', message: decision.needsUser, provider }, step);
      return { ok: false, summary: `Needs you: ${decision.needsUser}`, steps: step, log };
    }

    if (decision.isTaskComplete) {
      status({ phase: 'done', message: decision.summary ?? 'Task complete.', provider }, step);
      return {
        ok: true,
        summary: decision.summary ?? decision.thought ?? 'Task complete.',
        steps: step,
        log,
      };
    }

    const knownIds = new Set(snapshot.elements.map((e) => e.agentId));
    const { actions, dropped } = pruneUnknownTargets(decision, knownIds);

    if (!actions.length) {
      repeatedFailures += 1;
      lastResults =
        dropped.length > 0
          ? `Those elements no longer exist: ${dropped.join(', ')}. Re-read the snapshot and pick real agentIds.`
          : 'You returned no runnable actions. Choose a concrete next action or set isTaskComplete.';
      if (repeatedFailures >= 3) {
        return { ok: false, summary: 'The agent stalled without a workable next action.', steps: step, log };
      }
      continue;
    }

    if (
      settings.confirmBeforeSubmit &&
      options.confirmSubmit &&
      looksLikeSubmit(decision, snapshot.text)
    ) {
      status({ phase: 'waiting_user', message: 'Waiting for you to confirm submission...' }, step);
      const approved = await options.confirmSubmit(decision);
      if (!approved) {
        return { ok: false, summary: 'You declined the submission.', steps: step, log };
      }
    }

    status({ phase: 'acting', message: phaseMessageFor(decision), provider }, step);

    let outcomes: ActionOutcome[];
    try {
      outcomes = await executor.execute(actions);
    } catch (err) {
      // A navigation mid-batch rejects pending requests; that is normal, so we
      // report it to the model and let it re-read the new page next turn.
      outcomes = [
        {
          action: actions[0],
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        },
      ];
    }

    const entry: AgentRunLogEntry = {
      step,
      thought: decision.thought ?? '',
      actions,
      url: snapshot.url,
      provider,
      at: Date.now(),
    };
    log.push(entry);
    onLog?.(entry);

    history.push(`${decision.thought} -> ${actions.map(describeAction).join('; ')}`);
    lastResults = summariseOutcomes(outcomes);
    if (dropped.length) lastResults += `\nSkipped stale elements: ${dropped.join(', ')}`;

    repeatedFailures = outcomes.every((o) => !o.ok) ? repeatedFailures + 1 : 0;
    if (repeatedFailures >= 4) {
      return {
        ok: false,
        summary: 'Every action failed several turns in a row; stopping to avoid a loop.',
        steps: step,
        log,
      };
    }

    // Let the page settle (SPA transitions, XHR-driven form steps).
    await new Promise((r) => setTimeout(r, 900));
  }

  return {
    ok: false,
    summary: `Reached the ${maxSteps}-step limit without confirming completion.`,
    steps: maxSteps,
    log,
  };
}

/* ------------------------------ voice / intent ---------------------------- */

export interface PlannedTask {
  task: string;
  startUrl: string;
  needsConfirmation: boolean;
  note: string;
}

/** Turns a raw spoken/typed command into a task plus a starting URL. */
export async function planTask(command: string): Promise<PlannedTask> {
  const vault = await loadVault();
  const { value } = await completeJson<PlannedTask>([
    { role: 'system', content: TASK_PLANNER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${buildVaultContext(vault, { includeResume: false })}\n\n## COMMAND\n${command}`,
    },
  ]);

  return {
    task: value.task || command,
    startUrl: /^https?:\/\//.test(value.startUrl ?? '')
      ? value.startUrl
      : `https://duckduckgo.com/?q=${encodeURIComponent(command)}`,
    needsConfirmation: !!value.needsConfirmation,
    note: value.note ?? '',
  };
}
