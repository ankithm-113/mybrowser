/**
 * Personal Knowledge & Resume Vault.
 *
 * Holds structured profile data plus imported documents (copied into the app
 * sandbox so they survive the picker's temporary cache), and renders a compact
 * context block that every agent prompt embeds.
 */

import * as FileSystem from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';

import { KnowledgeVault, ProjectEntry, VaultDocument, WorkHistoryEntry } from '@/types';
import { KEYS, newId, readJson, writeJson } from './storage';
import { extractTextFromFile } from './textExtractor';

const VAULT_DIR = `${FileSystem.documentDirectory}vault/`;

export const EMPTY_VAULT: KnowledgeVault = {
  profile: {
    fullName: '',
    email: '',
    phone: '',
    location: '',
    headline: '',
    summary: '',
    githubUrl: '',
    linkedinUrl: '',
    portfolioUrl: '',
    otherLinks: [],
    skills: [],
    yearsExperience: '',
    currentCTC: '',
    expectedCTC: '',
    noticePeriod: '',
    workAuthorization: '',
    requiresSponsorship: false,
    willingToRelocate: true,
    preferredRoles: [],
    preferredLocations: [],
    remoteOnly: false,
  },
  workHistory: [],
  projects: [],
  documents: [],
  notes: '',
  updatedAt: 0,
};

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(VAULT_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(VAULT_DIR, { intermediates: true });
}

export async function loadVault(): Promise<KnowledgeVault> {
  const stored = await readJson<Partial<KnowledgeVault>>(KEYS.vault, {});
  return {
    ...EMPTY_VAULT,
    ...stored,
    profile: { ...EMPTY_VAULT.profile, ...(stored.profile ?? {}) },
    workHistory: stored.workHistory ?? [],
    projects: stored.projects ?? [],
    documents: stored.documents ?? [],
  };
}

export async function saveVault(vault: KnowledgeVault): Promise<void> {
  await writeJson(KEYS.vault, { ...vault, updatedAt: Date.now() });
}

export async function updateVault(
  mutate: (vault: KnowledgeVault) => KnowledgeVault
): Promise<KnowledgeVault> {
  const next = mutate(await loadVault());
  await saveVault(next);
  return next;
}

/* -------------------------------- documents ------------------------------- */

export interface ImportResult {
  document?: VaultDocument;
  cancelled: boolean;
  warning?: string;
}

/**
 * Opens the system picker, copies the chosen file into the sandbox, extracts
 * its text, and stores it. The first resume imported becomes the primary one.
 */
export async function importDocument(
  kind: VaultDocument['kind'] = 'resume'
): Promise<ImportResult> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
    ],
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (picked.canceled || !picked.assets?.length) return { cancelled: true };

  const asset = picked.assets[0];
  await ensureDir();

  const id = newId('doc');
  const safeName = asset.name.replace(/[^\w.\-]+/g, '_');
  const destination = `${VAULT_DIR}${id}_${safeName}`;
  await FileSystem.copyAsync({ from: asset.uri, to: destination });

  const extraction = await extractTextFromFile(
    destination,
    asset.mimeType ?? '',
    asset.name
  );

  const vault = await loadVault();
  const isFirstResume = kind === 'resume' && !vault.documents.some((d) => d.isPrimaryResume);

  const document: VaultDocument = {
    id,
    name: asset.name,
    mimeType: asset.mimeType ?? 'application/octet-stream',
    uri: destination,
    sizeBytes: asset.size ?? 0,
    extractedText: extraction.text,
    extractionOk: extraction.ok,
    kind,
    isPrimaryResume: isFirstResume,
    addedAt: Date.now(),
  };

  await saveVault({ ...vault, documents: [...vault.documents, document] });
  return { document, cancelled: false, warning: extraction.note };
}

export async function deleteDocument(id: string): Promise<void> {
  const vault = await loadVault();
  const doc = vault.documents.find((d) => d.id === id);
  if (doc) await FileSystem.deleteAsync(doc.uri, { idempotent: true });
  const remaining = vault.documents.filter((d) => d.id !== id);
  // Never leave the vault without a primary resume if a resume still exists.
  if (doc?.isPrimaryResume) {
    const nextResume = remaining.find((d) => d.kind === 'resume');
    if (nextResume) nextResume.isPrimaryResume = true;
  }
  await saveVault({ ...vault, documents: remaining });
}

export async function setPrimaryResume(id: string): Promise<void> {
  await updateVault((vault) => ({
    ...vault,
    documents: vault.documents.map((d) => ({ ...d, isPrimaryResume: d.id === id })),
  }));
}

export async function getPrimaryResume(): Promise<VaultDocument | undefined> {
  const vault = await loadVault();
  return (
    vault.documents.find((d) => d.isPrimaryResume) ??
    vault.documents.find((d) => d.kind === 'resume')
  );
}

/** Base64 payload handed to the WebView so it can build a real File object. */
export async function readDocumentBase64(doc: VaultDocument): Promise<string> {
  return FileSystem.readAsStringAsync(doc.uri, { encoding: FileSystem.EncodingType.Base64 });
}

/* ------------------------------ structured rows --------------------------- */

export function blankWorkEntry(): WorkHistoryEntry {
  return { id: newId('job'), company: '', role: '', start: '', end: '', location: '', description: '' };
}

export function blankProject(): ProjectEntry {
  return { id: newId('prj'), name: '', url: '', stack: '', description: '' };
}

/* ------------------------------- LLM context ------------------------------ */

/** Trimmed to help a turn fit inside Groq's 12k tokens-per-minute free tier. */
const RESUME_TEXT_BUDGET = 3000;

/**
 * The single source of truth the agent sees about the user. Kept terse — this
 * is prepended to every agent turn, and free-tier context windows are finite.
 */
export function buildVaultContext(vault: KnowledgeVault, options?: { includeResume?: boolean }): string {
  const p = vault.profile;
  const lines: string[] = ['## USER PROFILE'];

  const field = (label: string, value: string | boolean | string[] | undefined) => {
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) return;
    lines.push(`- ${label}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  };

  field('Full name', p.fullName);
  field('Email', p.email);
  field('Phone', p.phone);
  field('Location', p.location);
  field('Headline', p.headline);
  field('Summary', p.summary);
  field('GitHub', p.githubUrl);
  field('LinkedIn', p.linkedinUrl);
  field('Portfolio', p.portfolioUrl);
  field('Other links', p.otherLinks);
  field('Skills', p.skills);
  field('Years of experience', p.yearsExperience);
  field('Current CTC', p.currentCTC);
  field('Expected CTC', p.expectedCTC);
  field('Notice period', p.noticePeriod);
  field('Work authorization', p.workAuthorization);
  field('Needs visa sponsorship', p.requiresSponsorship ? 'yes' : 'no');
  field('Willing to relocate', p.willingToRelocate ? 'yes' : 'no');
  field('Preferred roles', p.preferredRoles);
  field('Preferred locations', p.preferredLocations);
  field('Remote only', p.remoteOnly ? 'yes' : 'no');

  if (vault.workHistory.length) {
    lines.push('', '## WORK HISTORY');
    for (const w of vault.workHistory) {
      lines.push(
        `- ${w.role} @ ${w.company} (${w.start} - ${w.end || 'present'})${
          w.location ? `, ${w.location}` : ''
        }${w.description ? `\n  ${w.description}` : ''}`
      );
    }
  }

  if (vault.projects.length) {
    lines.push('', '## PROJECTS');
    for (const pr of vault.projects) {
      lines.push(
        `- ${pr.name}${pr.url ? ` (${pr.url})` : ''}${pr.stack ? ` [${pr.stack}]` : ''}${
          pr.description ? `: ${pr.description}` : ''
        }`
      );
    }
  }

  const attachable = vault.documents.map(
    (d) => `- ${d.name} [id=${d.id}, kind=${d.kind}${d.isPrimaryResume ? ', PRIMARY RESUME' : ''}]`
  );
  if (attachable.length) {
    lines.push('', '## ATTACHABLE DOCUMENTS (use action type "upload" with documentId)');
    lines.push(...attachable);
  }

  if (options?.includeResume !== false) {
    const resume = vault.documents.find((d) => d.isPrimaryResume && d.extractedText);
    if (resume) {
      lines.push('', '## RESUME TEXT', resume.extractedText.slice(0, RESUME_TEXT_BUDGET));
    }
  }

  if (vault.notes.trim()) lines.push('', '## ADDITIONAL NOTES', vault.notes.trim());

  return lines.join('\n');
}

export function vaultCompleteness(vault: KnowledgeVault): { percent: number; missing: string[] } {
  const p = vault.profile;
  const checks: Array<[string, boolean]> = [
    ['Full name', !!p.fullName],
    ['Email', !!p.email],
    ['Phone', !!p.phone],
    ['Location', !!p.location],
    ['Skills', p.skills.length > 0],
    ['LinkedIn or portfolio', !!(p.linkedinUrl || p.portfolioUrl)],
    ['Work history', vault.workHistory.length > 0],
    ['Resume document', vault.documents.some((d) => d.kind === 'resume')],
    ['Preferred roles', p.preferredRoles.length > 0],
  ];
  const passed = checks.filter(([, ok]) => ok).length;
  return {
    percent: Math.round((passed / checks.length) * 100),
    missing: checks.filter(([, ok]) => !ok).map(([label]) => label),
  };
}
