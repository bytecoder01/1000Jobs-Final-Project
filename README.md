# 🕵️ Stealth Agent — Autonomous Lever ATS Auto-Applier

An autonomous headless micro-agent that navigates and completes live job applications on Lever-hosted job boards. Wrapped in a local REST API (Express), it handles bot detection evasion, PDF resume upload, LLM-powered custom question answering across all field types, and structured step-by-step execution logging.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Design Choices](#design-choices)
4. [Prerequisites](#prerequisites)
5. [Installation](#installation)
6. [Configuration (.env)](#configuration-env)
7. [Running the Server](#running-the-server)
8. [API Reference](#api-reference)
9. [Full applicantData Reference](#full-applicantdata-reference)
10. [Example Requests](#example-requests)
11. [How It Works — Step by Step](#how-it-works--step-by-step)
12. [Logging & Debugging](#logging--debugging)
13. [Screenshots](#screenshots)
14. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
POST /apply
    │
    ▼
server.js              ← Express REST API · input validation · structured JSON responses
    │
    ▼
agent.js               ← Main orchestrator · parallel LLM + form-fill workflow
    │
    ├── browser.js          ← Playwright + Stealth plugin · randomised fingerprint
    ├── formFiller.js       ← Navigation · standard fields · resume upload
    │                          custom question collection · answer injection
    ├── mouseHelper.js      ← Bézier curve mouse movement · human-like typing
    ├── pdfTextExtractor.js ← PDF → plain text (pdf-parse)
    ├── cvParser.js         ← Regex extraction: email · phone · LinkedIn · GitHub
    ├── llmHandler.js       ← Gemini API · JSON-structured answers · PDF attachment
    └── logger.js           ← Winston · console + error.log + combined.log
```

### Parallel Workflow

The key performance optimization: once custom questions are collected from the DOM, the LLM call is **fired immediately** (non-blocking). Standard field filling and resume upload happen **in parallel** while Gemini processes the questions. The agent awaits LLM results only at the moment it needs to inject them — typically saving 5–15 seconds per application.

```
Time →
 ├── collect_custom_questions  (fast DOM scan)
 ├──── LLM request ─────────────────────────────────────────► await answers
 ├──────── fill_standard_fields + upload_resume ─────────────────────────┤
 │                                                                        ▼
 └──────────────────────────────────────────────────── fill_custom_questions
```

---

## Project Structure

```
stealth-agent/
├── src/
│   ├── agent.js              # Orchestrator — runs all steps, returns result object
│   ├── browser.js            # Chrome launch + full stealth configuration
│   ├── cvParser.js           # Regex-based contact info extraction from CV text
│   ├── formFiller.js         # Form navigation, field filling, resume upload,
│   │                         #   custom question collection & answer injection
│   ├── llmHandler.js         # Google Gemini integration, JSON answer parsing
│   ├── logger.js             # Winston setup (console + file transports)
│   ├── mouseHelper.js        # Bézier mouse simulation, character-by-character typing
│   ├── pdfTextExtractor.js   # PDF text extraction (pdf-parse)
│   └── server.js             # Express API server — POST /apply endpoint
│
├── sample-cv/
│   └── resume.pdf            # Sample PDF resume for testing
│
├── screenshots/              # Auto-created — agent saves screenshots here
├── logs/                     # Auto-created — error.log + combined.log
├── .env                      # API keys and runtime config 
├── package.json
└── README.md
```

---

## Design Choices

### 1. Bot Detection Evasion (Multi-Layer)

Modern ATS platforms fingerprint browsers at multiple levels. The agent combats this with a layered approach:

**Browser layer (`browser.js`)**
- `playwright-extra` + `puppeteer-extra-plugin-stealth` masks Playwright's internal identifiers globally at launch
- Random user agent selected from a pool of 4 real Chrome strings on every session
- Randomised viewport dimensions (1280–1400 × 800–880) to avoid fixed-size signatures
- `addInitScript` injected before every page load spoofs:
  - `navigator.webdriver = false`
  - `navigator.plugins` populated with real Chrome PDF plugin names
  - `navigator.languages = ['en-US', 'en']`
  - CDP artifacts (`cdc_*` window keys) deleted
  - `permissions.query` overridden to report real notification state
  - `window.chrome` ensured to exist with realistic `runtime`, `loadTimes`, `csi` properties
- Route interceptor strips the `x-playwright` header from all outgoing requests
- Timezone fixed to `America/New_York`, locale `en-US`

**Mouse & keyboard layer (`mouseHelper.js`)**
- All cursor movement uses **cubic Bézier curves** with randomised control points — not straight-line teleportation
- 18–35 interpolated steps per movement with 4–16 ms per-step timing, eased with `easeInOutCubic`
- Human hover pause (60–140 ms) before each click, variable press duration (40–90 ms), post-click settle (80–120 ms)
- Typing is **character-by-character** with:
  - Base delay: 40–75 ms per key
  - Word-boundary pauses: ~15% chance of 160–360 ms after a space
  - "Thinking" pauses: ~4% chance of 350–950 ms mid-word
  - Typo simulation: ~3% chance of typing an adjacent character then backspacing

**Form layer (`formFiller.js`)**
- **Honeypot detection**: before filling any element the agent checks bounding box (zero-size = skip), screen position (off-screen = skip), and computed CSS (`display: none`, `visibility: hidden`, `opacity: 0`, absolutely-positioned off-screen = skip). Honeypots are silently skipped without logging a suspicious access.
- Fields are scrolled into view with a random pause (200–500 ms) before interaction
- Random inter-field delays (300–700 ms) pace interactions naturally

### 2. Smart Navigation with Fallback

`navigateToApplyPage` tries the direct `{jobUrl}/apply` URL first (fastest path). If the standard form inputs aren't detected, it falls back to loading the job posting page and clicking the Apply button using multiple selector strategies: `.postings-btn`, `a[href*="/apply"]`, and text-based `button:has-text("Apply")` selectors. CAPTCHA frames (`recaptcha`, `hcaptcha`) are detected and logged as a warning so the operator can intervene if needed.

### 3. LLM Integration — All 5 Question Types

`collectCustomQuestions` scans the DOM for all custom field types: **textareas, text inputs, `<select>` dropdowns, checkbox groups, and radio button groups**. Standard Lever fields are excluded via a `STANDARD_FIELD_NAMES` set. Each question gets a stable ID (`q1`, `q2`, …) and its label is resolved via a cascade: Lever's `.application-label` structure → `<label for>` → `aria-label` / `aria-labelledby` → placeholder fallback.

All questions are sent to **Google Gemini** in one API call. The resume PDF is attached as an inline base64 document so Gemini tailors answers to the candidate's actual experience. Gemini returns strict JSON (`{ "q1": "answer", "q3": ["opt1", "opt2"] }`). A `safeParseJSON` function with regex-based JSON extraction handles any malformed outputs gracefully.

Answer injection logic per field type:
- **Textarea / text input**: typed character-by-character via `mouseHelper`; inputs truncated to 120 chars
- **Select dropdown**: exact text match first, fuzzy `includes`-based fallback, then `dispatchEvent('change')` to trigger React/Vue reactivity
- **Single checkbox**: checked if LLM answers `"YES"`
- **Multi-checkbox**: each option matched against LLM's answer array with fuzzy matching
- **Radio buttons**: exact match, then includes-based fallback

### 4. CV Auto-Enrichment

If a `resumePath` is supplied and `applicantData` is missing contact fields, the agent:
1. Extracts full text from the PDF via `pdf-parse`
2. Runs regex extraction for email, phone, LinkedIn URL, and GitHub URL
3. Populates **only the missing fields** — existing values are never overwritten

This means passing `{ "name": "Jane Doe" }` is sufficient — the agent will populate email, phone, LinkedIn, and GitHub directly from the resume PDF.

### 5. Safety-First Submission

`submitApplication` defaults to `false`. The agent always stops at "ready to submit", saves a full-page screenshot, and returns a structured result — giving the operator a chance to review before anything is sent. Pass `"submitApplication": true` to go live. The submit click uses the same human Bézier movement as all other interactions.

### 6. Structured Execution Log in Every Response

Every response includes an `execution_log` array: each step name, status (`success` / `error` / `warning`), timestamp, and relevant metadata. This makes failure diagnosis deterministic without needing to read log files — you can see exactly which step failed and why from the API response alone.

---

## Prerequisites

- **Node.js** v18 or later — verify with `node --version`
- **npm** v9 or later — verify with `npm --version`
- **Google Gemini API Key** — [Get one free at Google AI Studio](https://aistudio.google.com/app/apikey)

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-username/stealth-agent.git
cd stealth-agent

# 2. Install all Node.js dependencies
npm install

# 3. Download the Playwright Chromium browser binary
npx playwright install chromium
```

No Docker, no Python, no system-level dependencies beyond Node.js.

---

## Configuration (.env)

Create a `.env` file in the **project root** — the same directory as `package.json`:

```env
# ── Required ────────────────────────────────────────────────────────────────────
# Google Gemini API key for answering custom screening questions
GOOGLE_API_KEY=your_gemini_api_key_here

# ── Optional ────────────────────────────────────────────────────────────────────
# Set to "true" to run Chrome without a visible window (production)
# Leave as "false" to watch the browser in real time (debugging)
HEADLESS=false

# Residential proxy to bypass aggressive bot-detection (format: http://user:pass@host:port)
# PROXY_URL=http://user:pass@proxy-host:port

# Winston log verbosity: debug | info | warn | error  (default: info)
LOG_LEVEL=info

# API server port (default: 3000)
PORT=3000
```

---

## Running the Server

```bash
node src/server.js
```

Expected output:

```
[SERVER] Stealth Agent API running on http://localhost:3000
[SERVER] Available endpoints:
[SERVER]   • GET  /health  - Health check
[SERVER]   • POST /apply   - Submit job application
```

The server stays running and handles repeated requests. Restart only when you change `.env` or source files.

---

## API Reference

### `POST /apply`

Triggers the agent for a single Lever job posting.

#### Request Body (JSON)

| Field | Type | Required | Description |
|---|---|---|---|
| `jobUrl` | `string` | ✅ | Full Lever job URL — must start with `http` |
| `applicantData` | `object` | ✅ | Applicant profile — see full reference below |
| `resumePath` | `string` | ⬜ | **Absolute** path to the PDF resume on this machine |
| `cvText` | `string` | ⬜ | Raw CV text (alternative to `resumePath` for contact field auto-parsing) |
| `submitApplication` | `boolean` | ⬜ | `true` to click Submit. Defaults to `false` |

#### Response — Success `200`

```json
{
  "success": true,
  "requestId": "a1b2c3",
  "status": "ready_to_submit",
  "applicant": "Jane Doe",
  "job_url": "https://jobs.lever.co/...",
  "fields_filled": {
    "name": true,
    "email": true,
    "phone": true,
    "linkedin": true,
    "github": true,
    "resume": true,
    "customQuestions": 3
  },
  "screenshots": {
    "filled": "/abs/path/screenshots/form_filled_1716640000000.png",
    "ready_to_submit": "/abs/path/screenshots/ready_to_submit_1716640000000.png",
    "post_submit": null
  },
  "duration_ms": 22450,
  "execution_log": [
    { "step": "validation",              "status": "success",  "timestamp": "..." },
    { "step": "attach_resume",           "status": "success",  "timestamp": "...", "size": 204800 },
    { "step": "parse_cv",                "status": "success",  "timestamp": "...", "email": "jane@example.com" },
    { "step": "browser_launch",          "status": "success",  "timestamp": "..." },
    { "step": "navigate",                "status": "success",  "timestamp": "..." },
    { "step": "collect_custom_questions","status": "success",  "timestamp": "...", "count": 3 },
    { "step": "start_llm_request",       "status": "success",  "timestamp": "...", "questionsCount": 3 },
    { "step": "fill_standard_fields",    "status": "success",  "timestamp": "..." },
    { "step": "wait_llm_results",        "status": "success",  "timestamp": "...", "answersCount": 3 },
    { "step": "fill_custom_questions",   "status": "success",  "timestamp": "...", "count": 3 },
    { "step": "locate_submit",           "status": "success",  "timestamp": "..." },
    { "step": "screenshot_ready_to_submit", "status": "success", "timestamp": "..." }
  ],
  "timestamp": "2025-05-01T10:00:00.000Z"
}
```

**Possible `status` values:** `ready_to_submit` · `submitted` · `submit_uncertain`

#### Response — Failure `400` / `500`

```json
{
  "success": false,
  "requestId": "a1b2c3",
  "status": "resume_not_found",
  "error": "Resume file not found: /path/to/resume.pdf",
  "duration_ms": 45,
  "execution_log": [...],
  "timestamp": "2025-05-01T10:00:00.000Z"
}
```

**Possible failure `status` values:** `validation_failed` · `resume_not_found` · `resume_read_failed` · `failed`

---

## Full `applicantData` Reference

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | ✅ **Required.** Full name |
| `email` | `string` | Auto-parsed from CV if omitted |
| `phone` | `string` | Auto-parsed from CV if omitted |
| `linkedin` | `string` | Profile URL — auto-parsed from CV if omitted |
| `github` | `string` | Profile URL — auto-parsed from CV if omitted |
| `currentCompany` | `string` | Current employer (fills the "org" field) |
| `currentCompanyUrl` | `string` | Company website URL |
| `currentLocation` | `string` | City/region — supports Lever's location autocomplete |
| `opportunityLocation` | `string` | Opportunity location dropdown — matched to closest option |
| `currentTitle` | `string` | Job title — used as LLM context for custom question answering |
| `twitter` | `string` | Twitter/X profile URL |
| `website` | `string` | Personal website or portfolio URL |
| `portfolio` | `string` | Portfolio URL (maps to `urls[Portfolio]`) |
| `otherWebsite` | `string` | Other URL (maps to `urls[Other]`) |
| `coverLetter` | `string` | Injected into the comments/cover letter textarea |
| `pronouns` | `string \| string[]` | Pronoun checkbox — e.g. `"They/them"` or `["She/her"]` |
| `additionalInfo` | `string` | Background context given to the LLM for custom question answering |

---

## Example Requests

### cURL — Minimal (contact info auto-parsed from resume)

```bash
curl -X POST http://localhost:3000/apply \
  -H "Content-Type: application/json" \
  -d '{
    "jobUrl": "https://jobs.lever.co/benchsci/77b9c4b2-af7f-479a-8f29-820618219388",
    "applicantData": {
      "name": "Jane Doe"
    },
    "resumePath": "/absolute/path/to/stealth-agent/sample-cv/resume.pdf",
    "submitApplication": false
  }'
```

### cURL — Full payload

```bash
curl -X POST http://localhost:3000/apply \
  -H "Content-Type: application/json" \
  -d '{
    "jobUrl": "https://jobs.lever.co/fullscript/c63d8b0e-1107-4514-90ad-c47d8059eecd",
    "applicantData": {
      "name": "Jane Doe"
    },
    "resumePath": "/absolute/path/to/stealth-agent/sample-cv/resume.pdf",
    "submitApplication": false
  }'
```

### Postman / Thunder Client

1. Method: **POST**
2. URL: `http://localhost:3000/apply`
3. Body → **raw** → **JSON** → paste any payload above
4. Send

---

## How It Works — Step by Step

| # | Module | What happens |
|---|---|---|
| 1 | `server.js` | Validates `jobUrl` (must start with `http`) and `applicantData.name` |
| 2 | `server.js` | If `cvText` provided, enriches `applicantData` from it before proceeding |
| 3 | `agent.js` | Resolves `resumePath` to absolute path, reads file bytes, encodes as base64 |
| 4 | `pdfTextExtractor.js` | Extracts full plain text from PDF via `pdf-parse` |
| 5 | `cvParser.js` | Regex-extracts email, phone, LinkedIn, GitHub from CV text; fills only missing fields |
| 6 | `browser.js` | Launches Chromium with stealth plugin, random UA, and spoofed navigator properties |
| 7 | `formFiller.js` | Navigates to `{jobUrl}/apply`; falls back to clicking the Apply button if no form is detected at the direct URL |
| 8 | `formFiller.js` | Checks for CAPTCHA frames and logs a warning if detected |
| 9 | `formFiller.js` | Scans all custom question fields (textareas, inputs, selects, checkboxes, radios) — fast DOM-only scan, no LLM call yet |
| 10 | `llmHandler.js` | **Fires LLM request immediately (non-blocking)** — sends all questions + resume PDF to Gemini |
| 11 | `formFiller.js` | **In parallel with step 10**: fills standard fields with human-like typing and uploads the PDF resume |
| 12 | `agent.js` | Awaits Gemini response, then injects answers into each custom question field |
| 13 | `agent.js` | Scrolls form naturally (mid-page pause, then scroll to bottom) to simulate human review |
| 14 | `agent.js` | Saves `form_filled` screenshot |
| 15 | `formFiller.js` | Locates submit button by selector, scrolls it into view |
| 16 | `agent.js` | Saves `ready_to_submit` screenshot — **primary deliverable** |
| 17 | `formFiller.js` | *(Only if `submitApplication: true`)* Clicks Submit with human mouse movement, waits for success confirmation via page selectors or URL change |
| 18 | `server.js` | Returns structured JSON: `success`, `status`, `fields_filled`, `screenshots`, `duration_ms`, `execution_log` |

---

## Logging & Debugging

Winston writes to three destinations simultaneously:

| Destination | Path | Levels captured |
|---|---|---|
| Console (coloured) | stdout | All (respects `LOG_LEVEL`) |
| Error log file | `logs/error.log` | `error` only |
| Combined log file | `logs/combined.log` | All levels |

Log format: `[HH:MM:SS.mmm] [LEVEL] Message  » { metadata }` with full stack traces on errors.

**To get full debug output:**

```bash
LOG_LEVEL=debug node src/server.js
```

The `execution_log` array in every API response gives a step-by-step trace with timestamps and metadata — the fastest way to diagnose what failed and why without needing to open a log file.

---

## Screenshots

All screenshots are saved as full-page PNGs in `stealth-agent/screenshots/`:

| Filename pattern | When taken |
|---|---|
| `form_filled_<timestamp>.png` | After all standard + custom fields are filled |
| `ready_to_submit_<timestamp>.png` | Submit button visible and located — key deliverable |
| `post_submit_<timestamp>.png` | After clicking Submit (only when `submitApplication: true`) |
| `error_<timestamp>.png` | On any fatal error, automatically captured for debugging |

---

## Troubleshooting

**`GOOGLE_API_KEY is not set`**
Ensure `.env` exists in the project root (same folder as `package.json`) and contains a valid key with Gemini API access.

**`Resume file not found`**
Use an **absolute path** — relative paths are rejected. Example: `/Users/you/stealth-agent/sample-cv/resume.pdf`

**`Could not find the application form or Apply button`**
Set `HEADLESS=false` to watch Chrome in real time. Some Lever postings need extra JS load time or have unusual Apply button selectors.

**Browser crashes on launch / `browserType.launch` error**
Run `npx playwright install chromium` to ensure the browser binary is present.

**Fields not being filled / form appears blank**
A CAPTCHA or bot wall may be blocking interaction. Set `HEADLESS=false` to observe the session live. Adding a residential proxy via `PROXY_URL` in `.env` often resolves persistent bot detection.

**LLM call returns empty or no answers**
Verify the `GOOGLE_API_KEY` is valid and active. The agent degrades gracefully — standard fields are still filled and the response still returns `success: true` even if the LLM step fails.

**Port already in use**
Set `PORT=3001` (or any free port) in `.env` and restart.

**Some fields show as `undefined` in `fields_filled`**
Not all Lever forms include every standard field. The agent skips fields it cannot find on the page — this is expected behaviour, not an error.
