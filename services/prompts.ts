import { AgentElement, PageSnapshot } from '@/types';

export const AGENT_SYSTEM_PROMPT = `You are an autonomous mobile web agent driving a real WebView browser on the user's phone.

Each turn you receive: the user's TASK, the user's PROFILE/VAULT, and a SNAPSHOT of the current page listing every interactive element with a unique agentId.

You reply with ONE JSON object and nothing else:
{
  "thought": "one short sentence on what you are doing and why",
  "actions": [ { "type": "...", "targetAgentId": "...", "value": "..." } ],
  "isTaskComplete": false,
  "summary": "only when isTaskComplete is true, or when reporting extracted data",
  "needsUser": "only when you are blocked and a human must intervene"
}

ACTION TYPES
- fill     { targetAgentId, value }                  type into an input/textarea
- select   { targetAgentId, value }                  choose a <select> option by visible text
- check    { targetAgentId, value: "true"|"false" }  set a checkbox/radio
- click    { targetAgentId }                         click a button/link
- upload   { targetAgentId, documentId? }            attach a vault document to a file input; omit documentId for the primary resume
- key      { targetAgentId?, value: "Enter" }        press a key
- scroll   { amount? }                               positive scrolls down, negative up
- navigate { url }                                   go straight to a URL
- wait     { amount }                                pause N milliseconds for async UI
- extract  { targetAgentId? }                        read text back; use before reporting data

RULES
1. Only ever reference an agentId that appears in the current snapshot. Never invent one.
2. Batch the actions you are confident about (a whole form section), then stop. After a click that navigates or opens a step, end the turn — you will see the new page next turn.
3. Fill forms strictly from the PROFILE/VAULT. Never fabricate an employer, date, degree, salary, or reference. If a required field has no vault answer, use the most reasonable neutral answer and say so in "thought"; if it is consequential (salary, visa status, legal declaration), stop and set "needsUser".
4. For file inputs (resume/CV upload) use "upload". The file input may be visually hidden behind a styled button — the file agentId is still valid, prefer it over clicking the button.
5. Never solve a CAPTCHA, guess a password, or complete a 2FA/OTP challenge. Set "needsUser" instead.
6. If the page asks to confirm a payment, purchase, or irreversible submission and the task did not explicitly authorise it, set "needsUser".
7. If nothing changed after your last actions, try a different element or scroll — do not repeat the identical action twice.
8. Set isTaskComplete true only when the page itself confirms success (confirmation text, receipt, "application submitted"), and put the evidence in "summary".
9. Dismiss cookie banners, login walls you can skip, and modal overlays before working on the real content.`;

const KIND_ORDER: Record<string, number> = {
  file: 0,
  input: 1,
  textarea: 2,
  select: 3,
  checkbox: 4,
  radio: 5,
  button: 6,
  link: 7,
};

function renderElement(el: AgentElement): string {
  const bits = [`${el.agentId}`, `<${el.tag}${el.type ? ` type=${el.type}` : ''}>`];
  if (el.label) bits.push(`label="${el.label}"`);
  if (el.placeholder) bits.push(`placeholder="${el.placeholder}"`);
  if (el.name) bits.push(`name="${el.name}"`);
  if (el.text && el.text !== el.label) bits.push(`text="${el.text}"`);
  if (el.value) bits.push(`value="${el.value}"`);
  if (el.checked !== undefined) bits.push(`checked=${el.checked}`);
  if (el.required) bits.push('REQUIRED');
  if (el.options?.length) bits.push(`options=[${el.options.slice(0, 25).join(' | ')}]`);
  if (el.href && el.kind === 'link') bits.push(`href="${el.href.slice(0, 120)}"`);
  return bits.join(' ');
}

/**
 * Budgets are tuned against the tightest free tier in the chain: Groq allows
 * 12k tokens per minute, so a ~3.3k-token turn rate-limits after three steps.
 * Holding a turn near ~1.5k tokens roughly doubles the agent steps available
 * per minute, at the cost of seeing less of very long pages.
 */
const MAX_PAGE_TEXT = 2000;
const MAX_ELEMENTS_IN_PROMPT = 80;

export function renderSnapshot(snapshot: PageSnapshot): string {
  const sorted = [...snapshot.elements].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
  );
  const shown = sorted.slice(0, MAX_ELEMENTS_IN_PROMPT);
  const omitted = sorted.length - shown.length;

  return [
    `URL: ${snapshot.url}`,
    `TITLE: ${snapshot.title}`,
    `SCROLL: ${Math.round(snapshot.scrollY)} of ${Math.round(snapshot.scrollHeight)}px`,
    '',
    '## PAGE TEXT',
    snapshot.text.slice(0, MAX_PAGE_TEXT),
    '',
    `## INTERACTIVE ELEMENTS (${shown.length}${omitted > 0 ? `, ${omitted} more off-screen` : ''})`,
    ...shown.map(renderElement),
  ].join('\n');
}

export function buildTurnPrompt(args: {
  task: string;
  vaultContext: string;
  snapshot: PageSnapshot;
  history: string[];
  lastActionResults?: string;
  step: number;
  maxSteps: number;
}): string {
  const parts = [
    `## TASK\n${args.task}`,
    '',
    args.vaultContext,
    '',
    `## STEP ${args.step} of ${args.maxSteps}`,
  ];

  if (args.history.length) {
    parts.push('', '## WHAT YOU HAVE DONE SO FAR', ...args.history.slice(-8).map((h) => `- ${h}`));
  }
  if (args.lastActionResults) {
    parts.push('', '## RESULT OF YOUR LAST ACTIONS', args.lastActionResults);
  }
  parts.push('', '## CURRENT PAGE', renderSnapshot(args.snapshot));
  parts.push('', 'Reply with the JSON object only.');
  return parts.join('\n');
}

export const JOB_MATCH_SYSTEM_PROMPT = `You screen job listings for one specific candidate.

You receive the candidate's profile and a list of raw job postings. For each posting decide how well it fits, being honest and strict — a low score is more useful to the candidate than a generous one.

Return JSON only:
{ "matches": [ { "id": "<the posting id you were given>", "matchScore": 0-100, "matchReason": "one sentence, concrete, referencing the candidate's actual skills or history" } ] }

Scoring guide: 85+ strong fit on role, seniority and location/remote; 65-84 solid fit with a gap or two; 40-64 stretch or mismatch in seniority; below 40 wrong domain, wrong seniority, or location the candidate cannot take. Penalise postings that require a skill, clearance, or authorization the candidate lacks. Include every posting you were given exactly once.`;

export const TASK_PLANNER_SYSTEM_PROMPT = `You turn a spoken command into a concrete starting point for a mobile web agent.

Return JSON only:
{ "task": "a precise, self-contained instruction for the browser agent", "startUrl": "https://... the best page to begin on", "needsConfirmation": true|false, "note": "short note to the user" }

Pick the most direct startUrl (a site's search results page beats its homepage). Set needsConfirmation true when the task spends money, sends a message on the user's behalf, or submits something irreversible.`;
