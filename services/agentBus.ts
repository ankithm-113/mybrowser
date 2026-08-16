/**
 * Tiny cross-screen bus so the Job Review screen can hand a task to the
 * Browser screen (which owns the WebView) without prop drilling or context.
 */

import { AgentRunResult } from '@/types';

export interface AgentRequest {
  task: string;
  url?: string;
  /** Correlates a run back to the job that started it. */
  jobId?: string;
}

type Handler = (request: AgentRequest) => Promise<AgentRunResult>;

let handler: Handler | null = null;
let queued: AgentRequest | null = null;
const completionListeners = new Set<(jobId: string, result: AgentRunResult) => void>();

/** The Browser screen registers itself here on mount. */
export function registerAgentHandler(next: Handler | null): void {
  handler = next;
  if (handler && queued) {
    const request = queued;
    queued = null;
    void dispatch(request);
  }
}

export async function dispatch(request: AgentRequest): Promise<AgentRunResult | null> {
  if (!handler) {
    // The Browser screen has not mounted yet; run it as soon as it does.
    queued = request;
    return null;
  }
  const result = await handler(request);
  if (request.jobId) {
    for (const listener of completionListeners) listener(request.jobId, result);
  }
  return result;
}

export function onRunComplete(
  listener: (jobId: string, result: AgentRunResult) => void
): () => void {
  completionListeners.add(listener);
  return () => completionListeners.delete(listener);
}
