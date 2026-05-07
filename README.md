# AIMS EHR Platform — Ambient Scribe

Local AI-powered medical scribe with ambient listening, SOAP note generation, two-agent clinical/billing review, patient intake, scheduling, RAG medical knowledge search, **multi-agent EHR generation**, **specialty-specific prompt templates**, and **admin-controllable AI behavior**.

```
🏥 AIMS EHR — http://localhost:3003
⚙️ Admin Panel — http://localhost:3003 → Admin Panel tab
📦 GitHub — https://github.com/Pablodd1/aims-ambient-scribe
```

## Architecture

```
Frontend:  Single-page HTML/JS (no framework) — 6 pages
Backend:   Express.js (server.js, ~1,050 lines)
Database:  Supabase (postgresql + pgvector)
AI Models: Ollama (local GPU) — llama3.1:8b + qwen2.5-medical + bge-m3
Email:     Brevo REST API (BREVO_API_KEY env var)
Sessions:  In-memory (4hr TTL, heartbeat every 2min)

Multi-Agent Pipeline:
  Agent 1 (Scribe + Coder) → EHR JSON + ICD-10 + CPT codes
  Agent 2 (Auditor, async)  → Red flag detection + compliance audit
  Agent 3 (Educator)        → Patient summary at 8th-grade level
```

## Multi-Agent Architecture

```
┌─────────────────────────────────────────────────────────┐
│  POST /api/scribe/generate                              │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ AGENT 1     │  │ AGENT 2      │  │ AGENT 3        │ │
│  │ Scribe+     │  │ Auditor      │  │ Educator       │ │
│  │ Coder       │  │ (async)      │  │                │ │
│  │             │  │              │  │                │ │
│  │ llama3.1:8b │  │ qwen2.5-     │  │ llama3.1:8b    │ │
│  │             │  │ medical      │  │                │ │
│  │ → EHR JSON  │  │ → Red flags  │  │ → Patient      │ │
│  │ → ICD-10    │  │ → Compliance │  │   Summary      │ │
│  │ → CPT codes │  │ → Logged     │  │   (8th grade)  │ │
│  └─────────────┘  └──────────────┘  └────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Specialty Prompt Templates

| Template | Specialties | Key Features |
|----------|-------------|--------------|
| **default** | Primary Care, General | Full SOAP, OLDCARTS, ICD-10/CPT |
| **chiro-pip** | Chiropractic, PIP, Auto Accident | EMC Statement, ROM testing, -AT modifier |
| **psychiatry** | Psychiatry, Behavioral Health | PHQ-9/GAD-7, MSE, Risk Assessment |
| **primary-care** | Family Medicine, IM, Preventive | USPSTF screening, ASCVD risk, medication reconciliation |
| **orthopedics** | Orthopedics, Sports Medicine | Laterality, special tests, imaging correlation |

All templates are admin-editable via the Admin Panel UI. Changes take effect immediately.

## Competitive Advantages

| Feature | AIMS | Nabla | DeepScribe | Suki | Freed | Abridge |
|---------|------|-------|------------|------|-------|---------|
| **Admin-editable prompts** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Multi-agent (scribe+coder+auditor)** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Florida PIP / EMC Statement** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Specialty-specific templates** | ✅ | ✅ | ✅ | Partial | ❌ | ❌ |
| **Patient summary (8th-grade)** | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Real-time red flag audit** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **ICD-10 + CPT with rationale** | ✅ | Limited | Separate | ❌ | ❌ | ❌ |
| **Runs 100% local (Ollama)** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **No per-visit pricing** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

## Admin Panel

Accessible via the ⚙️ Admin Panel tab in the sidebar.

### Prompt Template Editor
- Create, edit, version, and toggle prompt templates
- Full system prompt editing with variable support
- Note template editing (shown to doctor as starting point)
- Specialties mapping (auto-routing)

### Provider Status Dashboard
- 🤖 LLM: Ollama connection status
- 📧 Brevo: Email configured status
- 🎙 Deepgram: Transcription ready (slot)
- 📱 Twilio: SMS ready (slot)

### Red Flag Audit Log
- Real-time feed of all audit findings
- Severity-coded: 🔴 critical, 🟡 warning, 🟢 info
- Patient + timestamp attribution
- Persistent across sessions

### System Health Monitor
- Server status + DB connectivity
- Loaded Ollama models
- Quick health check

## Quick Start

```bash
# 1. Start Ollama (must be running)
ollama serve

# 2. Pull required models
ollama pull llama3.1:8b
ollama pull qwen2.5-medical:latest
ollama pull bge-m3:latest

# 3. Pre-run Whisper (downloads model, ~150MB)
python3 -c "import whisper; whisper.load_model('tiny')"

# 4. Start AIMS
cd /home/jasme/ambient-scribe
node server.js

# 5. Open browser
# http://localhost:3003
```

## AI Models

| Model | Role | Load Time | Notes |
|-------|------|-----------|-------|
| `llama3.1:8b` | SOAP generation, billing review, intake extraction | ~9s | Primary workhorse |
| `qwen2.5-medical:latest` | Clinical review, smart assistant | ~38s | Medical domain |
| `bge-m3:latest` | RAG embeddings (1024-dim) | ~0.2s | Semantic search |
| `whisper tiny` | Audio transcription | ~5s first run | Voice → text |

All models use `keep_alive: '2h'` to prevent VRAM unloading between requests.

## API Endpoints

### Dashboard
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/dashboard` | Stats (patients, today's appointments, notes) + today's schedule |

### Patients
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/patients` | List/search patients (`?search=`) |
| `POST` | `/api/patients` | Register patient (first_name, last_name, dob, phone, email) |
| `GET` | `/api/patients/:id/history` | Visit count + last 3 visits with dates/reasons |

### Appointments
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/appointments` | Upcoming appointments (from today) |
| `POST` | `/api/appointments` | Schedule appointment |
| `PATCH` | `/api/appointments/:id` | Update date/time or status |
| `DELETE` | `/api/appointments/:id` | Delete appointment |
| `GET` | `/api/schedule` | 7-day calendar view (`?week=YYYY-MM-DD`) |

### Consult Room (Scribe)
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/scribe/start` | Initialize session (patient, consult type) |
| `POST` | `/api/scribe/listen` | Feed live transcript text |
| `POST` | `/api/scribe/paste` | Paste clinical text → SOAP update |
| `POST` | `/api/scribe/upload` | Upload audio file → transcribe → SOAP update |
| `POST` | `/api/scribe/edit` | Manual SOAP section edit |
| `GET` | `/api/scribe/soap` | Get current SOAP state |
| `GET` | `/api/scribe/template` | Get SOAP template by consult type |
| `POST` | `/api/scribe/finalize` | Lock SOAP, ready for signature |
| `POST` | `/api/scribe/sign` | Sign note (doctor name + license) |
| `GET` | `/api/scribe/download` | Download signed HTML note |
| `POST` | `/api/scribe/heartbeat` | Keep session alive |

### Two-Agent Review
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/review/clinical` | Clinical quality audit (qwen2.5-medical) |
| `POST` | `/api/review/billing` | Billing/coding audit (llama3.1) + ICD-10/CPT lookup |
| `POST` | `/api/review/redflags` | Documentation red flags (vitals, allergies, follow-up) |

### RAG Search
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/rag/search` | Semantic search via bge-m3 embeddings → pgvector |

### Smart Assistant
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/chat/query` | Ask clinical questions with patient context |

### Patient Intake
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/intake/questions` | 10 OLDCARTS intake questions |
| `POST` | `/api/intake/submit` | Submit typed answers → SOAP |
| `POST` | `/api/intake/create-link` | Generate shareable intake link |
| `GET` | `/api/intake/link/:token` | Get intake link status/answers |
| `POST` | `/api/intake/voice-submit` | Voice intake → AI extraction |

### Audit & Email
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/audit/tomorrow` | Tomorrow's appointments with patient names, times, reasons |
| `POST` | `/api/audit/email` | Send tomorrow's schedule via Brevo email |

### Multi-Agent EHR
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/scribe/generate` | Run full multi-agent pipeline: EHR JSON + codes + audit + patient summary |

### Admin Panel
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/prompts` | List all prompt templates |
| `GET` | `/api/admin/prompts/:id` | Get prompt template detail |
| `POST` | `/api/admin/prompts` | Create/update prompt template |
| `PATCH` | `/api/admin/prompts/:id/toggle` | Toggle template active/inactive |
| `GET` | `/api/admin/prompts/active/:specialty` | Get active prompt for specialty |
| `GET` | `/api/admin/providers` | Provider configuration status |
| `GET` | `/api/admin/redflags` | Red flag audit log |

### Health
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Server health + Ollama models + DB status |

## Consult Types

1. **Initial Consultation** — Full OLDCARTS HPI, complete ROS, PMH, comprehensive exam
2. **Follow-Up** — Interval history, treatment response, focused exam
3. **Physical Exam** — Annual physical, cancer screenings, vaccines, ASCVD risk
4. **Urgent Care** — Focused history, red flags, treat-and-release

## Session Management

- TTL: 4 hours from last access
- Heartbeat: Frontend pings `/api/scribe/heartbeat` every 2 minutes
- Cleanup: Abandoned sessions purged every 15 minutes
- **Warning:** Sessions are in-memory — server restart loses all active consults. Patient data, appointments, and medical notes persist in Supabase.

## Database

- **Provider:** Supabase PostgreSQL (vodhhauwowkalvaxzqyv)
- **Pooler:** `aws-1-us-west-2.pooler.supabase.com:6543`
- **Extensions:** pgvector 0.8.0 (1024-dim bge-m3 embeddings)
- **Tables:** patients, appointments, medical_notes, medical_knowledge_chunks, icd10_codes, cpt_codes

## Automation

### Midnight Audit Cron
Sends daily email at midnight with all of tomorrow's appointments:
- Patient names, appointment times, visit reasons
- Recipient: jasmelacosta@gmail.com
- Provider: Brevo transactional email

To set up:
```bash
hermes cron create --schedule "0 0 * * *" --name "AIMS Midnight Audit" \
  --prompt "Call GET http://localhost:3003/api/audit/tomorrow, then POST /api/audit/email to send the results."
```

## Deployment

### Local (demo/test)
```bash
node server.js  # → http://localhost:3003
```

### Vercel (production)
The Vercel deployment lives in a separate repo: `Pablodd1/NEW-AIMS-UPGRADED`
- Stack: Express + React + PostgreSQL + esbuild bundle
- URL: `https://newaimsupgraded.vercel.app` / `https://aimedicalscriber.com`
- Auto-deploys from GitHub pushes

## UI Pages

| Page | Features |
|------|----------|
| **Dashboard** | Stats cards, today's appointments, quick actions |
| **Schedule** | 7-day calendar, drag-and-drop date changes, inline time editing, patient search |
| **Patients** | Card grid with search, visit count + last 3 visits per patient |
| **Patient Intake** | 10 OLDCARTS questions, voice answers, shareable link |
| **Consult Room** | 4-field SOAP editor, mic/paste/upload, dual-agent review, RAG search, sign+download |

## Known Quirks

1. Ollama models unload from VRAM — `keep_alive: '2h'` on all API calls mitigates this
2. Whisper first run downloads the `tiny` model (~150MB) — pre-run once
3. Sessions are in-memory — server restart loses active consults
4. Drag-and-drop only changes dates, not times (time editing is inline popover)
5. Email sending requires Brevo API key and server IP not being restricted
6. Supabase password has `@` — must be URL-encoded (`%40`) in connection strings
7. DB column: `created_by` not `gender` on patients table

## File Structure

```
ambient-scribe/
├── server.js           # Express backend (~600 lines)
├── package.json        # Dependencies
├── public/
│   ├── index.html      # Full SPA frontend (~400 lines)
│   └── patient-intake.html  # Shareable patient intake page
├── uploads/            # Temporary audio uploads
└── README.md           # This file
```
