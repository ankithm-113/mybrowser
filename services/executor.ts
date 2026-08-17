/**
 * Action Execution Engine.
 *
 * Owns the request/response bridge between React Native and the injected
 * dom_reader script: it serialises LLM actions into WebView commands, resolves
 * vault documents into base64 payloads for file inputs, and waits for the
 * page's structured result.
 */

import { AgentAction, PageSnapshot } from '@/types';
import { getPrimaryResume, loadVault, readDocumentBase64 } from './knowledgeVault';

export interface ActionOutcome {
  action: AgentAction;
  ok: boolean;
  detail: string;
}

/** Anything that can push JS into the page — the WebView ref wrapper. */
export interface WebViewTransport {
  injectJavaScript(script: string): void;
}

type Pending<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Generous, because the page itself now waits — up to 10s for each element to
 * appear, plus a settle window after every mutating action. A tight native
 * timeout here would defeat that waiting entirely.
 */
const ACTION_TIMEOUT_MS = 90_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 15_000;
/** WebView file payloads above this get rejected rather than freezing the bridge. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export class Executor {
  private transport: WebViewTransport | null = null;
  private requestCounter = 0;
  private pendingActions = new Map<string, Pending<ActionOutcome[]>>();
  private pendingSnapshots = new Map<string, Pending<PageSnapshot>>();
  private pendingWaits = new Map<string, Pending<boolean>>();
  private pendingSettles = new Map<string, Pending<PageSnapshot>>();

  /** Set by Browser.tsx when the page reports an SPA route change. */
  lastUrlChangeAt = 0;

  /** Latest snapshot pushed by the page's MutationObserver. */
  latestSnapshot: PageSnapshot | null = null;
  onSnapshot: ((snapshot: PageSnapshot) => void) | null = null;
  onUrlChange: ((url: string) => void) | null = null;

  attach(transport: WebViewTransport | null): void {
    this.transport = transport;
  }

  isAttached(): boolean {
    return this.transport !== null;
  }

  private nextId(): string {
    this.requestCounter += 1;
    return `req_${this.requestCounter}`;
  }

  private send(command: unknown): void {
    if (!this.transport) throw new Error('Executor is not attached to a WebView');
    // JSON.stringify twice: once for the payload, once to embed it as a JS
    // string literal safe against quotes, newlines and unicode separators.
    const literal = JSON.stringify(JSON.stringify(command));
    this.transport.injectJavaScript(
      `(function(){ if (window.__AGENT__) { window.__AGENT__.handleCommand(${literal}); } })(); true;`
    );
  }

  /** Called by Browser.tsx for every message arriving from the page. */
  handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.channel === 'snapshot' && msg.snapshot) {
      this.latestSnapshot = msg.snapshot as PageSnapshot;
      this.onSnapshot?.(this.latestSnapshot);
      const pending = msg.requestId ? this.pendingSnapshots.get(msg.requestId) : undefined;
      if (pending && msg.requestId) {
        clearTimeout(pending.timer);
        this.pendingSnapshots.delete(msg.requestId);
        pending.resolve(this.latestSnapshot);
      }
      return;
    }

    if (msg.channel === 'actionResult' && msg.requestId) {
      const pending = this.pendingActions.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingActions.delete(msg.requestId);
        pending.resolve(msg.results as ActionOutcome[]);
      }
      return;
    }

    if (msg.channel === 'waitResult' && msg.requestId) {
      const pending = this.pendingWaits.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingWaits.delete(msg.requestId);
        pending.resolve(!!msg.found);
      }
      return;
    }

    if (msg.channel === 'settleResult' && msg.requestId) {
      const pending = this.pendingSettles.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingSettles.delete(msg.requestId);
        if (msg.snapshot) this.latestSnapshot = msg.snapshot as PageSnapshot;
        pending.resolve(this.latestSnapshot as PageSnapshot);
      }
      return;
    }

    // An SPA route change fires no load event; the page tells us instead.
    if (msg.channel === 'urlchange') {
      this.lastUrlChangeAt = Date.now();
      this.onUrlChange?.(msg.url as string);
    }
  }

  /**
   * Asks the page to wait for an element to enter the DOM. Used by the loop
   * before reporting a target as missing, so a slow-rendering widget is not
   * mistaken for a broken plan.
   */
  async waitForElement(agentId: string, timeout = 10_000): Promise<boolean> {
    const requestId = this.nextId();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWaits.delete(requestId);
        resolve(false);
      }, timeout + SETTLE_TIMEOUT_MS);

      this.pendingWaits.set(requestId, { resolve, reject: () => resolve(false), timer });
      try {
        this.send({ op: 'waitFor', requestId, agentId, timeout });
      } catch {
        clearTimeout(timer);
        this.pendingWaits.delete(requestId);
        resolve(false);
      }
    });
  }

  /** Waits for the DOM to go quiet, then returns the resulting snapshot. */
  async waitForStable(quietMs = 500, maxMs = 8000): Promise<PageSnapshot | null> {
    const requestId = this.nextId();
    return new Promise<PageSnapshot | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSettles.delete(requestId);
        resolve(this.latestSnapshot);
      }, maxMs + SETTLE_TIMEOUT_MS);

      this.pendingSettles.set(requestId, {
        resolve: resolve as (v: PageSnapshot) => void,
        reject: () => resolve(this.latestSnapshot),
        timer,
      });
      try {
        this.send({ op: 'settle', requestId, quietMs, maxMs });
      } catch {
        clearTimeout(timer);
        this.pendingSettles.delete(requestId);
        resolve(this.latestSnapshot);
      }
    });
  }

  /** Drops every in-flight request — used on navigation and on abort. */
  reset(reason = 'page navigated'): void {
    for (const [, pending] of this.pendingWaits) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    for (const [, pending] of this.pendingSettles) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingWaits.clear();
    this.pendingSettles.clear();

    for (const [, pending] of this.pendingActions) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    for (const [, pending] of this.pendingSnapshots) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingActions.clear();
    this.pendingSnapshots.clear();
  }

  async requestSnapshot(): Promise<PageSnapshot> {
    const requestId = this.nextId();
    return new Promise<PageSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSnapshots.delete(requestId);
        // A slow page is not fatal if we already have a recent snapshot.
        if (this.latestSnapshot) resolve(this.latestSnapshot);
        else reject(new Error('Timed out waiting for a page snapshot'));
      }, SNAPSHOT_TIMEOUT_MS);

      this.pendingSnapshots.set(requestId, { resolve, reject, timer });
      try {
        this.send({ op: 'snapshot', requestId });
      } catch (err) {
        clearTimeout(timer);
        this.pendingSnapshots.delete(requestId);
        reject(err as Error);
      }
    });
  }

  /**
   * Resolves `upload` actions into inline file payloads and runs the batch.
   * Actions are executed in order and stop at the first failure, so the model
   * sees exactly how far it got.
   */
  async execute(actions: AgentAction[]): Promise<ActionOutcome[]> {
    if (!actions.length) return [];

    const wire: any[] = [];
    const preflightFailures: ActionOutcome[] = [];

    for (const action of actions) {
      if (action.type === 'wait') {
        await new Promise((r) => setTimeout(r, Math.min(action.amount ?? 1000, 8000)));
        preflightFailures.push({ action, ok: true, detail: `waited ${action.amount ?? 1000}ms` });
        continue;
      }

      if (action.type === 'upload') {
        const vault = await loadVault();
        const doc = action.documentId
          ? vault.documents.find((d) => d.id === action.documentId)
          : await getPrimaryResume();

        if (!doc) {
          preflightFailures.push({
            action,
            ok: false,
            detail: 'No matching document in the vault. Add a resume in the Vault tab.',
          });
          break;
        }
        if (doc.sizeBytes > MAX_UPLOAD_BYTES) {
          preflightFailures.push({
            action,
            ok: false,
            detail: `${doc.name} is ${(doc.sizeBytes / 1e6).toFixed(1)}MB — too large to inject.`,
          });
          break;
        }

        wire.push({
          type: 'upload',
          targetAgentId: action.targetAgentId,
          fileName: doc.name,
          mimeType: doc.mimeType,
          base64: await readDocumentBase64(doc),
        });
        continue;
      }

      wire.push(action);
    }

    if (!wire.length) return preflightFailures;

    const requestId = this.nextId();
    const results = await new Promise<ActionOutcome[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(requestId);
        reject(new Error('Timed out waiting for the page to run the actions'));
      }, ACTION_TIMEOUT_MS);

      this.pendingActions.set(requestId, { resolve, reject, timer });
      try {
        this.send({ op: 'execute', requestId, actions: wire });
      } catch (err) {
        clearTimeout(timer);
        this.pendingActions.delete(requestId);
        reject(err as Error);
      }
    });

    // Strip the base64 back out so the log and the LLM never see the payload.
    const cleaned = results.map((r) =>
      r.action?.type === 'upload'
        ? { ...r, action: { type: 'upload', targetAgentId: r.action.targetAgentId } as AgentAction }
        : r
    );
    return [...preflightFailures, ...cleaned];
  }
}

export function summariseOutcomes(outcomes: ActionOutcome[]): string {
  if (!outcomes.length) return 'No actions were run.';
  return outcomes
    .map((o) => {
      const target = o.action?.targetAgentId ? ` ${o.action.targetAgentId}` : '';
      return `${o.ok ? 'OK' : 'FAILED'} ${o.action?.type ?? '?'}${target}: ${o.detail}`;
    })
    .join('\n');
}

/** One shared executor per app session; the Browser attaches its WebView to it. */
export const executor = new Executor();
