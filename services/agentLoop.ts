/**
 * Agentic Loop Orchestrator.
 *
 * One loop serves every entry point — a typed task, a voice command, an
 * "Apply Autonomously" tap from the job review screen, or a scheduled run.
 *
 * Turn shape: snapshot -> prompt -> LLM JSON -> execute -> repeat.
 *
 * Built to survive long, messy runs rather than to fail fast. A failed action
 * is a fact to feed back to the model, not a reason to abort: the page is
 * re-read, the error goes into the next prompt, and the model gets another go.
 * Only a hard budget, a genuine stall, or the user stops a run.
 */

import {
  AgentAction,
  AgentDecision,
  AutonomyMode,
  AgentRunLogEntry,
  AgentRunResult,
  AgentStatus,
  LLMMessage,
  PageSnapshot,
} from '@/types';
import { completeJson } from './apiManager';
import { ActionOutcome, Executor, summariseOutcomes } from './executor';
import { buildVaultContext, loadVault } from './knowledgeVault';
import { createLogger } from './logger';
import { AGENT_SYSTEM_PROMPT, TASK_PLANNER_SYSTEM_PROMPT, buildTurnPrompt } from './prompts';
import { loadSettings } from './settings';

const log = createLogger('agent');

/**
 * Wall-clock ceiling for one run. Steps alone are a poor budget when a single
 * turn can legitimately spend 30s waiting for a slow form to render.
 */
const DEFAULT_TIME_BUDGET_MS = 15 * 60_000;

/** Consecutive failed turns tolerated before giving up. */
const MAX_CONSECUTIVE_FAILURES = 6;

/** Soft pause after a failure, so the page can finish whatever it was doing. */
const RETRY_BACKOFF_MS = [2000, 3000, 4000, 5000, 6000, 8000];

export interface RunOptions {
  task: string;
  executor: Executor;
  maxSteps?: number;
  timeBudgetMs?: number;
  /** Called before each turn so the UI overlay can narrate what is happening. */
  onStatus?: (status: AgentStatus) => void;
  onLog?: (entry: AgentRunLogEntry) => void;
  /** Return false to veto a submission — the "confirm before submit" setting. */
  confirmSubmit?: (decision: AgentDecision) => Promise<boolean>;
  /**
   * Called when the agent hits a login wall, captcha or OTP. Resolve true once
   * the user has dealt with it and wants the run to continue; false to stop.
   */
  awaitResume?: (reason: string) => Promise<boolean>;
  signal?: AbortSignal;
}

/** Sends something on your behalf, but costs nothing. */
const SUBMIT_HINTS =
  /submit|apply now|send application|send message|save and (continue|submit)|finish|post\b/i;

/** Spends money or books something that is awkward to undo. */
const IRREVERSIBLE_HINTS =
  /\bpay\b|payment|checkout|place order|buy now|purchase|complete (order|purchase)|confirm (booking|order|payment)|billing|subscribe/i;

/**
 * The text a human would read on the control the agent is about to click.
 *
 * Matching against the whole page instead of the target is what made the
 * confirmation prompt fire on nearly every click: any application page
 * contains the words "confirm" or "pay" somewhere.
 */
function targetLabel(action: AgentAction, snapshot: PageSnapshot): string {
  const element = snapshot.elements.find((e) => e.agentId === action.targetAgentId);
  if (!element) return action.targetAgentId ?? '';
  return [element.text, element.label, element.name, element.agentId]
    .filter(Boolean)
    .join(' ');
}

/** Whether this batch needs a human nod, given the configured autonomy. */
function needsConfirmation(
  actions: AgentAction[],
  snapshot: PageSnapshot,
  mode: AutonomyMode
): boolean {
  if (mode === 'full') return false;
  const clicks = actions.filter((a) => a.type === 'click');
  if (!clicks.length) return false;

  return clicks.some((a) => {
    const label = targetLabel(a, snapshot);
    if (IRREVERSIBLE_HINTS.test(label)) return true;
    return mode === 'guided' && SUBMIT_HINTS.test(label);
  });
}

/** Pages that need a human before the agent can do anything useful. */
const BLOCKED_PAGE_PATTERNS = [
  /sign in to continue|log in to continue|register to continue/i,
  /authwall|checkpoint|security challenge/i,
  /verify (you are|that you are) (a )?human|captcha|unusual traffic/i,
  /page not found|this page (doesn.t|does not) exist/i,
  /access denied|you need to be logged in/i,
];

const BLOCKED_URL_PATTERNS = /\/(login|signin|sign-in|authwall|checkpoint|challenge|uas\/login)/i;

/**
 * Detects auth walls and challenge pages before the model burns turns on them.
 * Requires the page to also be sparse or carry a password field, so an
 * ordinary page that merely links to "Sign in" is not mistaken for a wall.
 */
function detectBlockedPage(snapshot: PageSnapshot): string | null {
  const text = snapshot.text.slice(0, 1200);
  const urlBlocked = BLOCKED_URL_PATTERNS.test(snapshot.url);
  const textBlocked = BLOCKED_PAGE_PATTERNS.some((p) => p.test(text));
  if (!urlBlocked && !textBlocked) return null;

  const hasPasswordField = snapshot.elements.some((e) => e.type === 'password');
  const sparse = snapshot.elements.length < 12;
  if (!urlBlocked && !hasPasswordField && !sparse) return null;

  return hasPasswordField || urlBlocked
    ? `This site is asking you to sign in.\n\n${snapshot.url}\n\nLog in on screen, then press Resume Agent.`
    : `This page looks like a block or challenge page.\n\n${snapshot.url}\n\nResolve it on screen, then press Resume Agent.`;
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
  if (decision.statusMessage) return decision.statusMessage;
  if (decision.actions.some((a) => a.type === 'upload')) return 'Agent uploading resume...';
  if (decision.actions.some((a) => a.type === 'fill')) return 'Agent filling the form...';
  if (decision.actions.some((a) => a.type === 'navigate')) return 'Agent navigating...';
  if (decision.actions.some((a) => a.type === 'click')) return 'Agent clicking through...';
  return 'Agent working...';
}

/**
 * Drops actions whose target is not in the snapshot — but only after asking the
 * page to wait for it, since the snapshot may simply predate the element.
 */
async function pruneUnknownTargets(
  decision: AgentDecision,
  knownIds: Set<string>,
  executor: Executor
): Promise<{ actions: AgentAction[]; dropped: string[] }> {
  const dropped: string[] = [];
  const actions: AgentAction[] = [];

  for (const action of decision.actions) {
    if (!action.targetAgentId || knownIds.has(action.targetAgentId)) {
      actions.push(action);
      continue;
    }
    // Not in the last snapshot — give the DOM a chance to catch up.
    const appeared = await executor.waitForElement(action.targetAgentId, 4000);
    if (appeared) actions.push(action);
    else dropped.push(action.targetAgentId);
  }

  return { actions, dropped };
}

export async function runAgent(options: RunOptions): Promise<AgentRunResult> {
  const settings = await loadSettings();
  const vault = await loadVault();
  const vaultContext = buildVaultContext(vault);
  const maxSteps = options.maxSteps ?? settings.maxAgentSteps;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const startedAt = Date.now();
  const { executor, onStatus, onLog, signal } = options;

  const logEntries: AgentRunLogEntry[] = [];
  const history: string[] = [];
  let lastResults: string | undefined;
  let previousError: string | undefined;
  let consecutiveFailures = 0;

  const status = (patch: Partial<AgentStatus>, step: number) =>
    onStatus?.({
      phase: 'thinking',
      message: '',
      step,
      maxSteps,
      task: options.task,
      ...patch,
    } as AgentStatus);

  const backoff = () =>
    RETRY_BACKOFF_MS[Math.min(consecutiveFailures - 1, RETRY_BACKOFF_MS.length - 1)];

  const finish = (ok: boolean, summary: string, steps: number): AgentRunResult => {
    log.info(
      `run finished after ${steps} steps in ${Math.round((Date.now() - startedAt) / 1000)}s: ${summary}`
    );
    return { ok, summary, steps, log: logEntries };
  };

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) return finish(false, 'Stopped by the user.', step - 1);

    const elapsed = Date.now() - startedAt;
    if (elapsed > timeBudgetMs) {
      return finish(
        false,
        `Ran out of time after ${Math.round(elapsed / 60_000)} minutes without confirming completion.`,
        step - 1
      );
    }

    /* ------------------------------ read the page ----------------------------- */

    status({ phase: 'reading_page', message: 'Agent reading the page...' }, step);

    let snapshot: PageSnapshot;
    try {
      snapshot = await executor.requestSnapshot();
    } catch (err) {
      // Recoverable: the page is probably mid-navigation. Wait and re-read.
      consecutiveFailures += 1;
      previousError = `Could not read the page: ${
        err instanceof Error ? err.message : String(err)
      }. Waiting for it to settle, then re-reading the DOM.`;
      log.warn(previousError);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return finish(false, 'The page could not be read several times in a row.', step);
      }
      await executor.waitForStable(600, 6000);
      await new Promise((r) => setTimeout(r, backoff()));
      continue;
    }

    /* --------------------------- human-in-the-loop ---------------------------- */

    const blocked = detectBlockedPage(snapshot);
    if (blocked && options.awaitResume) {
      status({ phase: 'waiting_user', message: blocked }, step);
      log.info(`paused for user: ${blocked.split('\n')[0]}`);
      const resumed = await options.awaitResume(blocked);
      if (!resumed) return finish(false, 'Stopped at a page that needed you.', step);

      await executor.waitForStable(600, 8000);
      previousError = 'The user has just resolved a login or challenge page. Re-read the page state.';
      continue;
    }

    /* ------------------------------- decide ----------------------------------- */

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
          previousError,
          step,
          maxSteps,
          elapsedMs: elapsed,
          timeBudgetMs,
        }),
      },
    ];

    let decision: AgentDecision;
    let provider: string;
    try {
      const result = await completeJson<AgentDecision>(messages, {
        onFallback: (from, reason) =>
          status(
            { phase: 'thinking', message: `${from} unavailable (${reason}), switching...` },
            step
          ),
      });
      decision = result.value;
      provider = result.provider;
    } catch (err) {
      // Every provider failed this turn — usually a shared rate limit. Wait it
      // out and retry rather than throwing the whole run away.
      consecutiveFailures += 1;
      previousError = `All AI providers failed: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(previousError);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return finish(false, previousError, step);

      status({ phase: 'thinking', message: 'Providers busy, waiting to retry...' }, step);
      await new Promise((r) => setTimeout(r, backoff()));
      continue;
    }

    decision.actions = Array.isArray(decision.actions) ? decision.actions : [];
    previousError = undefined;

    if (decision.needsUser) {
      if (options.awaitResume) {
        status({ phase: 'waiting_user', message: decision.needsUser }, step);
        const resumed = await options.awaitResume(decision.needsUser);
        if (!resumed) return finish(false, `Needs you: ${decision.needsUser}`, step);
        await executor.waitForStable(600, 8000);
        previousError = `The user handled: ${decision.needsUser}. Continue from the current page.`;
        continue;
      }
      status({ phase: 'waiting_user', message: decision.needsUser, provider }, step);
      return finish(false, `Needs you: ${decision.needsUser}`, step);
    }

    if (decision.isTaskComplete) {
      status({ phase: 'done', message: decision.summary ?? 'Task complete.', provider }, step);
      return finish(true, decision.summary ?? decision.thought ?? 'Task complete.', step);
    }

    /* ------------------------------- act -------------------------------------- */

    // The model can ask to wait when it can see the page is still rendering.
    if (decision.waitMilliseconds && decision.waitMilliseconds > 0) {
      const waitMs = Math.min(decision.waitMilliseconds, 15_000);
      status(
        {
          phase: 'acting',
          message: decision.statusMessage ?? `Waiting ${waitMs}ms for the page...`,
          provider,
        },
        step
      );
      await new Promise((r) => setTimeout(r, waitMs));
      await executor.waitForStable(400, 6000);
    }

    const knownIds = new Set(snapshot.elements.map((e) => e.agentId));
    const { actions, dropped } = await pruneUnknownTargets(decision, knownIds, executor);

    if (!actions.length) {
      consecutiveFailures += 1;
      previousError =
        dropped.length > 0
          ? `Targets ${dropped.join(', ')} were still not in the DOM after waiting 4s. The page has re-rendered — read the new snapshot and use current agentIds.`
          : 'You returned no runnable actions. Choose a concrete next action, or set isTaskComplete when the page confirms success.';

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return finish(false, 'The agent stalled without a workable next action.', step);
      }
      await executor.waitForStable(500, 5000);
      continue;
    }

    if (options.confirmSubmit && needsConfirmation(actions, snapshot, settings.autonomy)) {
      status({ phase: 'waiting_user', message: 'Waiting for you to confirm...' }, step);
      const approved = await options.confirmSubmit(decision);
      if (!approved) return finish(false, 'You declined the action.', step);
    }

    status({ phase: 'acting', message: phaseMessageFor(decision), provider }, step);

    let outcomes: ActionOutcome[];
    try {
      outcomes = await executor.execute(actions);
    } catch (err) {
      // Navigation mid-batch rejects pending requests; that is normal, and the
      // next turn simply reads the new page.
      outcomes = [
        { action: actions[0], ok: false, detail: err instanceof Error ? err.message : String(err) },
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
    logEntries.push(entry);
    onLog?.(entry);

    // The whole point of this block: when a run "does nothing", these lines are
    // what say which element it touched and what the page reported back.
    log.info(`step ${step} @ ${snapshot.url}`);
    log.info(`  thought: ${decision.thought}`);
    for (const outcome of outcomes) {
      const target = outcome.action?.targetAgentId ? ` ${outcome.action.targetAgentId}` : '';
      const value = outcome.action?.value ? ` = "${String(outcome.action.value).slice(0, 40)}"` : '';
      log.info(
        `  ${outcome.ok ? 'OK  ' : 'FAIL'} ${outcome.action?.type}${target}${value}: ${outcome.detail}`
      );
    }

    history.push(`${decision.thought} -> ${actions.map(describeAction).join('; ')}`);
    lastResults = summariseOutcomes(outcomes);
    if (dropped.length) lastResults += `\nSkipped stale elements: ${dropped.join(', ')}`;

    const allFailed = outcomes.length > 0 && outcomes.every((o) => !o.ok);
    if (allFailed) {
      consecutiveFailures += 1;
      previousError = `Every action failed this turn: ${outcomes
        .map((o) => o.detail)
        .join(' | ')}. The page may still have been rendering — re-read the DOM and try a different element, or wait first.`;

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return finish(
          false,
          'Every action failed several turns in a row; stopping to avoid a loop.',
          step
        );
      }
      await new Promise((r) => setTimeout(r, backoff()));
      await executor.waitForStable(500, 6000);
      continue;
    }

    consecutiveFailures = 0;

    // The page already settled inside the executor; this short extra wait keeps
    // SPA route transitions from being read half-finished.
    const after = await executor.waitForStable(400, 6000);

    /**
     * A click that reports success but changes nothing is the signature of a
     * swallowed popup, a disabled control, or a validation error the agent
     * cannot see. Saying so beats letting it click the same button forever.
     */
    if (after && actions.some((a) => a.type === 'click')) {
      const unchanged =
        after.url === snapshot.url &&
        after.elements.length === snapshot.elements.length &&
        after.text.length === snapshot.text.length;

      if (unchanged) {
        previousError =
          'Your click reported success but the page did not change: same URL, same elements, same text. ' +
          'The control may be disabled, the form may have a validation error, or the target may open in a new window. ' +
          'Do NOT click it again — scroll to check for an error message, try a different element, or navigate directly to the application URL.';
        log.warn(`step ${step}: click produced no visible change at ${snapshot.url}`);
      }
    }
  }

  return finish(false, `Reached the ${maxSteps}-step limit without confirming completion.`, maxSteps);
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
