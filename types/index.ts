/**
 * Shared domain types for the autonomous browser agent.
 */

/* ---------------------------------- DOM ---------------------------------- */

export type AgentElementKind =
  | 'input'
  | 'textarea'
  | 'select'
  | 'button'
  | 'link'
  | 'file'
  | 'checkbox'
  | 'radio';

/** One interactive element as reported by assets/dom_reader.js */
export interface AgentElement {
  agentId: string;
  kind: AgentElementKind;
  tag: string;
  type?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  required?: boolean;
  checked?: boolean;
  href?: string;
  options?: string[];
  /** Trimmed visible text (buttons / links / labels). */
  text?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Condensed readable text of the page, truncated for the LLM context. */
  text: string;
  elements: AgentElement[];
  scrollY: number;
  scrollHeight: number;
  capturedAt: number;
}

/* -------------------------------- Actions -------------------------------- */

export type AgentActionType =
  | 'fill'
  | 'click'
  | 'select'
  | 'check'
  | 'upload'
  | 'scroll'
  | 'navigate'
  | 'wait'
  | 'key'
  | 'extract';

export interface AgentAction {
  type: AgentActionType;
  /** data-agent-id of the target element (not needed for navigate/scroll/wait). */
  targetAgentId?: string;
  value?: string;
  /** For `upload`: id of the vault document to attach. Defaults to primary resume. */
  documentId?: string;
  /** For `scroll`: pixels (default one viewport). For `wait`: milliseconds. */
  amount?: number;
  url?: string;
}

/** The strict JSON contract the LLM must return every turn. */
export interface AgentDecision {
  thought: string;
  actions: AgentAction[];
  isTaskComplete: boolean;
  /** Present when isTaskComplete is true, or when the agent needs to report data. */
  summary?: string;
  /** Set when the agent cannot continue without the user (captcha, OTP, payment). */
  needsUser?: string;
}

/* --------------------------------- Vault --------------------------------- */

export interface VaultDocument {
  id: string;
  name: string;
  mimeType: string;
  /** Path inside the app sandbox (FileSystem.documentDirectory + 'vault/'). */
  uri: string;
  sizeBytes: number;
  /** Extracted plain text, fed to the LLM. */
  extractedText: string;
  extractionOk: boolean;
  kind: 'resume' | 'cover_letter' | 'certificate' | 'other';
  isPrimaryResume: boolean;
  addedAt: number;
}

export interface WorkHistoryEntry {
  id: string;
  company: string;
  role: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

export interface ProjectEntry {
  id: string;
  name: string;
  url?: string;
  stack?: string;
  description?: string;
}

export interface UserProfile {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  headline: string;
  summary: string;
  githubUrl: string;
  linkedinUrl: string;
  portfolioUrl: string;
  otherLinks: string[];
  skills: string[];
  yearsExperience: string;
  currentCTC: string;
  expectedCTC: string;
  noticePeriod: string;
  workAuthorization: string;
  requiresSponsorship: boolean;
  willingToRelocate: boolean;
  preferredRoles: string[];
  preferredLocations: string[];
  remoteOnly: boolean;
}

export interface KnowledgeVault {
  profile: UserProfile;
  workHistory: WorkHistoryEntry[];
  projects: ProjectEntry[];
  documents: VaultDocument[];
  /** Free-form notes the agent may use to answer arbitrary application questions. */
  notes: string;
  updatedAt: number;
}

/* ---------------------------------- Jobs --------------------------------- */

export type JobStatus = 'new' | 'applying' | 'applied' | 'skipped' | 'failed';

export interface JobMatch {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  source: string;
  postedAt?: string;
  snippet?: string;
  /** 0-100, produced by the LLM against the vault. */
  matchScore: number;
  matchReason: string;
  status: JobStatus;
  foundAt: number;
  appliedAt?: number;
  failureReason?: string;
}

/* --------------------------------- Agent --------------------------------- */

export type AgentPhase =
  | 'idle'
  | 'thinking'
  | 'reading_page'
  | 'acting'
  | 'uploading'
  | 'waiting_user'
  | 'done'
  | 'error';

export interface AgentStatus {
  phase: AgentPhase;
  message: string;
  step: number;
  maxSteps: number;
  provider?: string;
  task?: string;
}

export interface AgentRunLogEntry {
  step: number;
  thought: string;
  actions: AgentAction[];
  url: string;
  provider: string;
  at: number;
}

export interface AgentRunResult {
  ok: boolean;
  summary: string;
  steps: number;
  log: AgentRunLogEntry[];
}

/* ---------------------------------- LLM ---------------------------------- */

export type ProviderId = 'gemini' | 'groq' | 'openrouter';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  text: string;
  provider: ProviderId;
  model: string;
}

export interface ProviderHealth {
  id: ProviderId;
  available: boolean;
  cooldownUntil: number;
  lastError?: string;
  successes: number;
  failures: number;
}

/* -------------------------------- Settings ------------------------------- */

/** A job feed the user added themselves. */
export interface CustomJobSource {
  id: string;
  label: string;
  /**
   * `rss` is fetched and parsed headlessly during the nightly sweep.
   * `browser` cannot be fetched (Cloudflare, login walls), so it yields a
   * search link the in-app agent opens with a real browser session.
   */
  kind: 'rss' | 'browser';
  /** May contain {query}, substituted with each of your search queries. */
  url: string;
}

export interface AppSettings {
  geminiKey: string;
  groqKey: string;
  openrouterKey: string;
  /** 24h "HH:MM" for the nightly job sweep. */
  jobSweepTime: string;
  jobSweepEnabled: boolean;
  jobQueries: string[];
  /** Enabled source ids — built-in ids and custom source ids alike. */
  jobSources: string[];
  customSources: CustomJobSource[];
  minMatchScore: number;
  maxAgentSteps: number;
  autoApplyTopMatches: boolean;
  confirmBeforeSubmit: boolean;
}
