# AI Browser Agent

An autonomous mobile web agent built with Expo + React Native. It drives a real
WebView on your phone: it reads the live DOM, decides what to do with a free-tier
LLM, and fills forms, clicks through flows, uploads your resume, and applies to
jobs on your behalf. It also runs a nightly job sweep in the background and
notifies you with the matches.

Running cost: **$0**. Every LLM provider, job feed, and speech engine used here
has a free tier or is on-device.

---

## What it does

| Module | File | What it is |
| --- | --- | --- |
| Knowledge & Resume Vault | `services/knowledgeVault.ts`, `screens/VaultScreen.tsx` | Encrypted store of your profile, work history, projects, links and documents |
| On-device text extraction | `services/textExtractor.ts` | Pure-JS PDF + DOCX parser (includes its own DEFLATE) so resumes become LLM context without a server |
| Browser engine | `components/Browser.tsx` | Full-screen WebView, address bar, back/forward, tabs, agent status overlay |
| DOM inspector | `assets/dom_reader.ts` | Injected script that tags interactive elements with `data-agent-id`, re-tags on mutations, and executes actions with real synthetic events |
| Multi-API stacking router | `services/apiManager.ts` | Gemini → Groq → OpenRouter failover with per-provider cooldowns |
| Action execution engine | `services/executor.ts` | Turns LLM JSON actions into WebView calls; resolves vault docs into real `File` objects for upload fields |
| Agentic loop | `services/agentLoop.ts` | snapshot → prompt → decide → act → repeat, for live and scheduled tasks |
| Background job finder | `services/jobScheduler.ts`, `services/jobSources.ts` | Nightly sweep across free job feeds, LLM-scored against your vault, push notification |
| Job review | `screens/JobReviewScreen.tsx` | Matched jobs with **Apply Autonomously** / **Skip** |
| Voice | `services/voice.ts` | Free native speech-to-text (no cloud STT) |

---

## Setup

```bash
# 1. install
cd ai-browser-agent
npm install

# 2. keys (optional — you can enter them in the app's Settings tab instead)
cp .env.example .env
#   then paste your keys into .env

# 3. build a dev client (required — see "Why not Expo Go" below)
npx expo prebuild
npx expo run:android      # or: npx expo run:ios
```

Get the free keys:

| Provider | Where | Free tier |
| --- | --- | --- |
| Google Gemini 2.5 Flash-Lite | <https://aistudio.google.com/apikey> | generous daily request quota |
| Groq (Llama 3.3 70B) | <https://console.groq.com/keys> | per-minute + per-day request limits |
| OpenRouter (DeepSeek / Qwen `:free`) | <https://openrouter.ai/keys> | free models, rate limited |

Configure at least one. Configure all three and the router will fail over
automatically when one returns a 429.

### Why not Expo Go

`expo-speech-recognition` and reliable background fetch need native modules that
Expo Go does not ship. The app still **runs** in Expo Go — browsing, the vault,
the agent loop and manual job sweeps all work — but the microphone button and
OS-scheduled background sweeps will not. Use a dev build for the full feature
set.

---

## Permissions

The app asks for three things, each at the moment it is first needed.

### 1. Documents / file picker

Used by the Vault tab to import your resume. `expo-document-picker` opens the
system picker, so on **Android 13+** no storage permission dialog appears at
all — the picker grants access to just the file you chose. On older Android the
`READ_EXTERNAL_STORAGE` permission declared in `app.json` is requested by the
picker itself. On iOS the prompt is driven by
`NSDocumentsFolderUsageDescription`.

Imported files are **copied into the app sandbox** (`documentDirectory/vault/`)
so they survive the picker's temporary cache, and deleted from there when you
remove the document.

### 2. Notifications (required for the nightly sweep)

Requested on first launch by `configureScheduler()`.

- **Android 13+**: the OS shows a runtime `POST_NOTIFICATIONS` prompt. If you
  decline, the nightly sweep cannot notify you — re-enable it under
  *Settings → Apps → AI Browser Agent → Notifications*.
- **Android battery optimisation**: aggressive OEM battery managers (Xiaomi,
  Oppo, Samsung, OnePlus) will suspend background fetch. If nightly sweeps stop
  firing, exempt the app under *Settings → Battery → Unrestricted*.
- **iOS**: background fetch is opportunistic — iOS decides when your app runs.
  The daily 21:00 notification always fires, and the sweep then runs when the
  app is opened or woken.

Because neither platform guarantees background execution, the scheduler uses
**two triggers**: a daily notification at your configured time, and
`expo-background-fetch`. Whichever fires first runs the sweep; the second one
sees it already ran today and skips.

### 3. Microphone + speech recognition

Requested when you first tap the 🎙 button. Android additionally needs a Google
speech service present (declared in `app.json` as
`androidSpeechServicePackages`). Everything is transcribed by the OS engine — no
audio leaves the device via this app.

---

## Using it

**General web tasks** — type or speak into the command bar on the Agent tab:

- "Find me a cheap flight from Delhi to Goa next Friday"
- "Fill this visa form using my details"
- "Order a large margherita from the nearest Domino's"

The command is planned into a concrete task plus a starting URL, then the loop
runs: it reads the page, decides, acts, and re-reads until the page confirms
success or it needs you.

**Job applications** — fill in the Vault, set your queries in Settings, then
either tap **Sweep now** on the Jobs tab or wait for the nightly run. Each match
gets **Apply Autonomously** (the agent opens the posting, finds the application
form — including ATS systems like Greenhouse, Lever, Workday, Ashby — fills it
from your vault, and attaches your resume) or **Skip**.

---

## Safety rails

These are on by default and worth understanding before you let it loose:

- **Confirm before submit** (Settings): you get a native prompt before the agent
  clicks anything that looks like a final submit, purchase, or payment.
- The system prompt forbids fabricating employers, dates, degrees, salaries or
  references. If a required field has no vault answer and the answer is
  consequential, the agent stops and asks you.
- It will never attempt a CAPTCHA, a password, or a 2FA/OTP challenge — it hands
  control back to you.
- Step limit per run (default 25) so a confused agent cannot loop indefinitely.
- Repeated-failure detection stops a run that is getting nowhere.

**Do read what it fills in before you approve a submission.** An LLM driving a
real form on your behalf will occasionally get something wrong, and a submitted
job application cannot be unsubmitted.

---

## Storage & encryption

- **API keys** → `expo-secure-store` (Android Keystore / iOS Keychain).
- **Vault, jobs, settings** → AsyncStorage, encrypted with a random 256-bit key
  that itself lives in SecureStore. A dump of AsyncStorage alone is not readable.
  The cipher is a SHA-256 keystream XOR (`services/storage.ts`) — it protects
  data at rest against casual extraction, not against an attacker who has both
  the storage dump and keychain access.
- Documents live in the app's private sandbox and are removed on delete.

Nothing is synced to a server. There is no backend.

---

## Job sources

Free JSON APIs, fetched directly: **RemoteOK**, **Arbeitnow**, **Jobicy**,
**Himalayas**. Plus **LinkedIn's** guest job-search endpoint, parsed from HTML —
this one is rate limited and its markup changes, so treat failures as normal.

**Indeed**, **Glassdoor** and **Wellfound** sit behind Cloudflare and reject
plain HTTP clients. Rather than pretend otherwise, those sources emit a search
link that opens in the in-app browser, where the agent reads them with a real
browser session. Failures in any one source never abort the sweep.

---

## Known limits

- **Scanned PDFs** produce no text — there is no on-device OCR here. The Vault
  tells you when extraction came back empty; paste the text into the notes field
  instead.
- **PDFs with subsetted font encodings** may extract garbled characters; the
  common case (text-based resumes exported from Word/Docs/LaTeX) works.
- **Background fetch is best-effort** on both platforms, by OS design.
- **Heavily client-rendered sites** occasionally need an extra step while the
  DOM settles; the loop handles this by re-reading, which costs a turn.
- **Login-walled sites** work only if you are already signed in inside the
  in-app browser — cookies persist between runs, so sign in once manually.

---

## Project layout

```
ai-browser-agent/
├── App.tsx                     navigation, notification wiring
├── app.json                    permissions, plugins, background modes
├── .env.example
├── assets/
│   └── dom_reader.ts           injected DOM inspector + action executor
├── components/
│   ├── Browser.tsx             WebView, address bar, tabs
│   ├── AgentOverlay.tsx        live agent status card
│   └── theme.ts
├── screens/
│   ├── BrowserScreen.tsx       command bar + voice + browser
│   ├── VaultScreen.tsx         profile, documents, work history, projects
│   ├── JobReviewScreen.tsx     matches with Apply / Skip
│   └── SettingsScreen.tsx      keys, provider health, sweep config
├── services/
│   ├── apiManager.ts           multi-provider LLM router with failover
│   ├── agentLoop.ts            the agentic loop + voice task planner
│   ├── executor.ts             RN ↔ WebView action bridge
│   ├── knowledgeVault.ts       vault CRUD + LLM context builder
│   ├── textExtractor.ts        PDF / DOCX / inflate
│   ├── jobScheduler.ts         background task, sweep, notifications
│   ├── jobSources.ts           free job feeds
│   ├── prompts.ts              system prompts + snapshot rendering
│   ├── storage.ts              encrypted AsyncStorage + keychain
│   ├── settings.ts
│   ├── agentBus.ts             cross-screen task dispatch
│   └── voice.ts                native speech-to-text
└── types/index.ts
```

## Commands

```bash
npm start              # Metro
npm run android        # dev build on device/emulator
npm run ios
npm run typecheck      # tsc --noEmit
```
