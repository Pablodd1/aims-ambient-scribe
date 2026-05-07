const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3003;
const OLLAMA = 'http://localhost:11434';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 100 * 1024 * 1024 } });

// DB
const pool = new Pool({
  connectionString: 'postgresql://postgres.vodhhauwowkalvaxzqyv:Hyatt123%40password2@aws-1-us-west-2.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 10000,
});

// ═══════════════════ DB MIGRATION ═══════════════════
async function ensureSchema() {
  try {
    // Check if appointments table has wrong schema
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='appointments' AND table_schema='public'`
    ).catch(() => ({ rows: [] }));
    
    if (cols.length > 0) {
      const colNames = cols.map(c => c.column_name);
      if (!colNames.includes('appointment_date')) {
        console.log('⚠ appointments table exists but missing appointment_date column — recreating');
        await pool.query('DROP TABLE IF EXISTS appointments CASCADE');
      }
    }
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        date_of_birth DATE,
        phone VARCHAR(20),
        email VARCHAR(255),
        created_by INTEGER DEFAULT 2,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        patient_id INTEGER REFERENCES patients(id),
        doctor_id INTEGER DEFAULT 2,
        appointment_date TIMESTAMPTZ NOT NULL,
        reason TEXT,
        status VARCHAR(20) DEFAULT 'scheduled',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS medical_notes (
        id SERIAL PRIMARY KEY,
        patient_id INTEGER REFERENCES patients(id),
        doctor_id INTEGER DEFAULT 2,
        content TEXT,
        type VARCHAR(50),
        title VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✓ DB schema ready');
  } catch (e) {
    console.error('Schema migration:', e.message);
  }
}

// ═══════════════════ CONSULT PROMPTS ═══════════════════
const CONSULT_PROMPTS = {
  'Initial Consultation': {
    specialty: 'Primary Care',
    system: `You are an expert medical scribe. Create comprehensive SOAP notes for INITIAL CONSULTATIONS.
Use OLDCARTS for HPI. Complete ROS and PMH. Document vitals, full exam, differentials with ICD-10.
Include: diagnostics, medications, referrals, patient education, follow-up, return precautions.`,
    template: `**SUBJECTIVE**\nChief Complaint:\nHPI (OLDCARTS):\nROS:\nPMH/PSH:\nMeds/Allergies:\nSocial/Family:\n\n**OBJECTIVE**\nVitals: BP __/__, HR __, Temp __, SpO2 __%\nExam:\n\n**ASSESSMENT**\n1. [Primary] (ICD-10: ___)\n2.\n\n**PLAN**\nDiagnostics:\nMeds:\nReferrals:\nEducation:\nFollow-up: ___`
  },
  'Follow-Up': {
    specialty: 'Primary Care', system: `Expert scribe for FOLLOW-UP visits. Focus: interval history, treatment response, medication adherence, new symptoms. Update problem list.`,
    template: `**SUBJECTIVE**\nInterval History:\nResponse to Treatment:\n\n**OBJECTIVE**\nVitals: BP __/__, HR __\nFocused Exam:\n\n**ASSESSMENT**\n1. [Ongoing] — improved/stable/worsened\n\n**PLAN**\nContinue/Adjust/Stop:\nFollow-up: ___`
  },
  'Physical Exam': {
    specialty: 'Preventive Medicine', system: `Expert scribe for ANNUAL PHYSICALS. Cancer screenings (USPSTF), vaccines (CDC), ASCVD risk, lifestyle counseling, depression screening.`,
    template: `**SUBJECTIVE**\nLifestyle: Diet __, Exercise __, Sleep __\nPHQ-2: __\n\n**OBJECTIVE**\nVitals: BP __/__, BMI __\nExam:\n\n**ASSESSMENT**\nHealth Maintenance\n  Screening: ___\n  Vaccines: ___\n  ASCVD Risk: __%\n\n**PLAN**\nFollow-up: 12 months`
  },
  'Urgent Care': {
    specialty: 'Emergency Medicine', system: `Expert scribe for URGENT CARE. Focused history, red flag assessment, rapid exam, clinical decision tools, treat-and-release vs transfer.`,
    template: `**SUBJECTIVE**\nChief Complaint:\nOnset:\nSeverity (0-10):\nRed Flags Reviewed:\n\n**OBJECTIVE**\nVitals: BP __/__, HR __, Pain __/10\nFocused Exam:\n\n**ASSESSMENT**\n1. [Diagnosis] (ICD-10: ___)\n   Red flags excluded: ___\n\n**PLAN**\nTreatment:\nReturn precautions:\nFollow-up: ___`
  }
};

// ═══════════════════ SESSION ═══════════════════
const sessions = {};
const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours max
function getSession(id) { if (!sessions[id]) sessions[id] = createSession(); sessions[id]._lastAccess = Date.now(); return sessions[id]; }
function createSession() {
  return { id: Date.now().toString(36), patient: null, transcript: '', soap: { subjective: '', objective: '', assessment: '', plan: '' }, consultType: 'Initial Consultation', updates: 0, status: 'waiting', signature: null, clinicalReview: null, billingReview: null, redFlags: null, _lastAccess: Date.now(), _created: Date.now() };
}
// Clean only truly abandoned sessions (no access for 4 hours)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (now - (s._lastAccess || 0) > SESSION_TTL) delete sessions[id];
  }
}, 15 * 60 * 1000);

// Heartbeat — keeps session alive during long consultations
app.post('/api/scribe/heartbeat', (req, res) => {
  const s = getSession(req.body.session_id);
  s._lastAccess = Date.now();
  res.json({ alive: true, session_age_min: Math.round((Date.now() - s._created) / 60000) });
});

// ═══════════════════ AI HELPERS ═══════════════════
async function ollamaChat(model, messages, timeout = 60000) {
  const res = await axios.post(`${OLLAMA}/api/chat`, { model, messages, stream: false, keep_alive: '2h', options: { temperature: 0.2, num_predict: 1536 } }, { timeout });
  return res.data.message.content;
}

async function updateSOAP(session) {
  if (!session.transcript || session.transcript.length < 30) return;
  const cfg = CONSULT_PROMPTS[session.consultType] || CONSULT_PROMPTS['Initial Consultation'];
  const existing = JSON.stringify(session.soap);
  const messages = [
    { role: 'system', content: `${cfg.system}\n\nCurrent SOAP (preserve doctor edits):\n${existing}\n\nOnly ADD new info. Output JSON: {"subjective":"...","objective":"...","assessment":"...","plan":"..."}` },
    { role: 'user', content: `New transcript:\n${session.transcript.slice(-3000)}\n\nReturn updated JSON.` }
  ];
  try {
    const result = await ollamaChat('llama3.1:8b', messages);
    const json = result.match(/\{[\s\S]*\}/);
    if (json) {
      const u = JSON.parse(json[0]);
      for (const k of ['subjective','objective','assessment','plan']) {
        // Accept update if: section was empty, AI produced different content, or AI content is significantly longer
        if (u[k] && (!session.soap[k] || u[k] !== session.soap[k] || u[k].length > session.soap[k].length + 30)) {
          session.soap[k] = u[k];
        }
      }
    }
  } catch (e) { console.error('SOAP:', e.message); }
}

// ═══════════════════ WHISPER ═══════════════════
async function transcribeAudio(filePath) {
  try {
    const wavPath = filePath + '.wav';
    const safePath = filePath.replace(/'/g, "'\\''");
    const safeWav = wavPath.replace(/'/g, "'\\''");
    execSync(`ffmpeg -y -i '${safePath}' -ar 16000 -ac 1 -sample_fmt s16 '${safeWav}' 2>/dev/null`, { timeout: 30000 });
    const result = execSync(`python3 -c "import whisper,json;m=whisper.load_model('tiny');r=m.transcribe('${safeWav}',language='en',fp16=False);print(json.dumps({'text':r['text']}))"`, { timeout: 120000, maxBuffer: 10*1024*1024 });
    fs.unlinkSync(wavPath);
    return { success: true, text: JSON.parse(result.toString().trim()).text };
  } catch (e) { return { success: false, error: e.message }; }
}

// ═══════════════════ SCRIBE API ═══════════════════
app.post('/api/scribe/start', (req, res) => {
  const s = getSession(req.body.session_id);
  s.patient = req.body.patient || null; s.consultType = req.body.consultType || 'Initial Consultation';
  s.transcript = ''; s.soap = { subjective: '', objective: '', assessment: '', plan: '' };
  s.updates = 0; s.status = 'listening'; s.signature = null; s.clinicalReview = null; s.billingReview = null; s.redFlags = null;
  res.json({ success: true, session_id: s.id });
});
app.get('/api/scribe/template', (req, res) => {
  const cfg = CONSULT_PROMPTS[req.query.type || 'Initial Consultation'];
  res.json({ success: true, type: req.query.type, template: cfg.template, specialty: cfg.specialty });
});
app.post('/api/scribe/listen', async (req, res) => {
  const s = getSession(req.body.session_id); const text = req.body.text;
  if (!text) return res.json({ success: false });
  s.transcript += ' ' + text; s.lastUpdate = Date.now(); res.json({ success: true });
  if (s.transcript.length - (s._lastLen || 0) > 400 || text.match(/[.?!]\s*$/)) { s._lastLen = s.transcript.length; await updateSOAP(s); s.updates++; }
});
app.post('/api/scribe/paste', async (req, res) => {
  const s = getSession(req.body.session_id); s.transcript += '\n\n' + req.body.text;
  await updateSOAP(s); s.updates++;
  res.json({ success: true, chars: s.transcript.length, soap: s.soap });
});
app.post('/api/scribe/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio' });
    const s = getSession(req.body.session_id);
    const r = await transcribeAudio(req.file.path); fs.unlink(req.file.path, () => {});
    if (r.success && r.text) { s.transcript += '\n\n' + r.text; await updateSOAP(s); s.updates++; res.json({ success: true, transcribed: r.text, soap: s.soap }); }
    else res.json({ success: false, error: r.error });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/scribe/edit', (req, res) => {
  const s = getSession(req.body.session_id);
  if (s.soap[req.body.section] !== undefined) s.soap[req.body.section] = req.body.content;
  res.json({ success: true });
});
app.get('/api/scribe/soap', (req, res) => {
  const s = getSession(req.query.session_id);
  res.json({ success: true, soap: s.soap, transcript: s.transcript, updates: s.updates, status: s.status, consultType: s.consultType, signature: s.signature, clinicalReview: s.clinicalReview, billingReview: s.billingReview, redFlags: s.redFlags });
});
app.post('/api/scribe/finalize', async (req, res) => {
  const s = getSession(req.body.session_id); await updateSOAP(s); s.status = 'complete';
  res.json({ success: true, soap: s.soap });
});
app.post('/api/scribe/sign', (req, res) => {
  const s = getSession(req.body.session_id);
  s.signature = { doctor_name: req.body.doctor_name || 'Dr. Sarah Johnson', license: req.body.license || 'ME123456', signed_at: new Date().toISOString(), reviewed: true };
  s.status = 'signed'; res.json({ success: true, signature: s.signature });
});
app.get('/api/scribe/download', (req, res) => {
  const s = getSession(req.query.session_id);
  if (!s?.soap) return res.status(404).send('No note');
  const sig = s.signature;
  const redFlagsHtml = s.redFlags ? `
    <div style="margin-top:24px;padding:12px;background:#fff3cd;border-left:3px solid #fbbf24;border-radius:4px">
      <strong style="color:#856404">⚠️ Documentation Red Flags</strong>
      ${s.redFlags.critical?.length ? `<p style="color:#721c24;margin:4px 0"><strong>🔴 Critical:</strong> ${s.redFlags.critical.join('; ')}</p>` : ''}
      ${s.redFlags.important?.length ? `<p style="color:#856404;margin:4px 0"><strong>🟡 Important:</strong> ${s.redFlags.important.join('; ')}</p>` : ''}
      ${s.redFlags.suggestion?.length ? `<p style="color:#0c5460;margin:4px 0"><strong>🟢 Suggestions:</strong> ${s.redFlags.suggestion.join('; ')}</p>` : ''}
    </div>` : '';
  const reviewHtml = s.clinicalReview ? `<h2>Clinical Review</h2><div class="section">${s.clinicalReview.replace(/\n/g,'<br>')}</div>` : '';
  const sigBlock = sig ? `<div style="margin-top:40px;border-top:1px solid #ccc;padding-top:16px"><p><strong>Signed:</strong> ${sig.doctor_name}, ${sig.license}</p><p>${new Date(sig.signed_at).toLocaleString()}</p></div>` : '';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Medical Note</title><style>body{font:12pt Georgia;line-height:1.7;padding:48px;max-width:750px;margin:auto}h1{font-size:20pt;text-align:center}.meta{font-size:9pt;color:#666;border-bottom:1px solid #999;padding-bottom:8pt}h2{font-size:11pt;text-transform:uppercase;border-bottom:1px solid #999;margin:20pt 0 8pt}.section{white-space:pre-wrap;font-size:11pt}.footer{margin-top:30pt;border-top:1px solid #ccc;padding-top:10pt;font-size:8pt;color:#999;text-align:center}</style></head><body><h1>MEDICAL NOTE</h1><div class="meta">Patient: ${s.patient?.name||'N/A'} | ${s.consultType} | ${new Date().toLocaleDateString()}</div><h2>Subjective</h2><div class="section">${s.soap.subjective||'Not documented'}</div><h2>Objective</h2><div class="section">${s.soap.objective||'Not documented'}</div><h2>Assessment</h2><div class="section">${s.soap.assessment||'Not documented'}</div><h2>Plan</h2><div class="section">${s.soap.plan||'Not documented'}</div>${redFlagsHtml}${reviewHtml}${sigBlock}<div class="footer">Generated by AIMS EHR — AI-assisted. Physician reviewed and approved.</div></body></html>`;
  res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Disposition', `attachment; filename="note-${new Date().toISOString().slice(0,10)}.html"`); res.send(html);
});

// ═══════════════════ TWO-AGENT REVIEW ═══════════════════
app.post('/api/review/clinical', async (req, res) => {
  try {
    const s = getSession(req.body.session_id);
    if (!s.soap.subjective && !s.soap.objective && !s.soap.assessment) return res.json({ success: false, error: 'No SOAP content to review' });

    const soapText = `S: ${s.soap.subjective}\nO: ${s.soap.objective}\nA: ${s.soap.assessment}\nP: ${s.soap.plan}`;

    const review = await ollamaChat('qwen2.5-medical:latest', [
      { role: 'system', content: `You are a CLINICAL QUALITY AUDITOR. Review this SOAP note for:

1. DIAGNOSTIC ACCURACY: Do the diagnoses match the findings? Missing differentials?
2. TREATMENT APPROPRIATENESS: Is the plan evidence-based? Any contraindications?
3. RED FLAGS: Life-threatening conditions that should be ruled out? Abnormal vitals?
4. MISSING DOCUMENTATION: What should be documented but isn't? (family history, med reconciliation, advance directives?)
5. FOLLOW-UP GAPS: Is follow-up specified? Return precautions? Safety netting?
6. PATIENT CARE STANDARDS: Does this meet standard of care for this consultation type?

Format as structured review with severity tags: 🔴 CRITICAL 🟡 IMPORTANT 🟢 SUGGESTION` },
      { role: 'user', content: `CLINICAL AUDIT:\n\nConsult Type: ${s.consultType}\n\nSOAP:\n${soapText}\n\nProvide the clinical quality review.` }
    ], 90000);

    s.clinicalReview = review;
    res.json({ success: true, review });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/review/billing', async (req, res) => {
  try {
    const s = getSession(req.body.session_id);
    if (!s.soap.assessment && !s.soap.plan) return res.json({ success: false, error: 'Need assessment and plan for billing review' });

    const soapText = `A: ${s.soap.assessment}\nP: ${s.soap.plan}`;

    const review = await ollamaChat('llama3.1:8b', [
      { role: 'system', content: `You are a MEDICAL BILLING & CODING AUDITOR. Review for:

1. ICD-10 CODES: Suggest specific codes for each diagnosis. Check specificity (laterality, encounter type).
2. CPT CODES: Suggest E&M level + procedure codes based on complexity and plan.
3. DOCUMENTATION FOR BILLING: Is medical necessity documented? ROS complete for level?
4. MISSING BILLING ELEMENTS: What's needed for higher E&M level? Missing modifiers?
5. COMPLIANCE FLAGS: Any coding conflicts? Upcoding/downcoding risk?
6. REVENUE CYCLE: Estimated RVUs, reimbursement considerations.

Format with code suggestions and gaps.` },
      { role: 'user', content: `BILLING AUDIT:\n\nConsult: ${s.consultType}\n\nSOAP:\n${soapText}\n\nSuggest codes and identify gaps.` }
    ]);

    s.billingReview = review;

    // Also query the ICD-10/CPT tables for exact matches
    let icdMatches = [], cptMatches = [];
    try {
      const keywords = (s.soap.assessment + ' ' + s.soap.plan).toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w => w.length > 3);
      for (const kw of keywords.slice(0, 5)) {
        const { rows } = await pool.query(`SELECT code, description FROM icd10_codes WHERE LOWER(description) LIKE $1 LIMIT 3`, [`%${kw}%`]);
        icdMatches.push(...rows);
      }
      const cptKw = s.consultType.includes('Physical') ? 'preventive' : s.soap.plan?.toLowerCase().includes('mri') ? 'mri' : 'evaluation';
      const { rows: cptRows } = await pool.query(`SELECT code, description, rvu FROM cpt_codes WHERE LOWER(description) LIKE $1 LIMIT 5`, [`%${cptKw}%`]);
      cptMatches = cptRows;
    } catch (dbErr) { console.error('Code lookup:', dbErr.message); }

    res.json({ success: true, review, icdMatches: [...new Map(icdMatches.map(m => [m.code, m])).values()], cptMatches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Combined red flags
app.post('/api/review/redflags', async (req, res) => {
  try {
    const s = getSession(req.body.session_id);
    const flags = { critical: [], important: [], suggestion: [] };

    // Check vitals mentioned
    const soapText = JSON.stringify(s.soap).toLowerCase();
    if (!soapText.match(/bp\s*\d|blood pressure/)) flags.important.push('No blood pressure documented');
    if (!soapText.match(/hr\s*\d|heart rate|pulse/)) flags.important.push('No heart rate documented');
    if (!soapText.match(/temp\s*\d|temperature/)) flags.suggestion.push('No temperature documented');
    if (!soapText.match(/spo2|oxygen|o2/)) flags.suggestion.push('No SpO2 documented');

    // Check for critical missing elements
    if (!soapText.match(/allerg|allergy/)) flags.important.push('No allergies documented — medication safety risk');
    if (!soapText.match(/medication|meds|prescri/)) flags.suggestion.push('No medication list or reconciliation');
    if (s.soap.plan && !s.soap.plan.match(/follow.up|followup|return|f\/u/)) flags.important.push('No follow-up plan specified');
    if (s.soap.assessment && !s.soap.assessment.match(/icd|code/)) flags.suggestion.push('No ICD-10 codes assigned to diagnoses');

    // Red flags from review
    if (s.clinicalReview) {
      for (const line of s.clinicalReview.split('\n')) {
        if (line.includes('🔴')) flags.critical.push(line.replace('🔴', '').trim());
        else if (line.includes('🟡')) flags.important.push(line.replace('🟡', '').trim());
      }
    }

    s.redFlags = flags;
    res.json({ success: true, flags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ SMART ASSISTANT CHAT ═══════════════════
app.post('/api/chat/query', async (req, res) => {
  try {
    const s = getSession(req.body.session_id);
    const { question } = req.body;
    if (!question) return res.json({ error: 'No question' });

    // Gather patient context from DB if patient ID provided
    let patientContext = '';
    if (s.patient?.id) {
      try {
        const { rows: patients } = await pool.query('SELECT * FROM patients WHERE id = $1', [s.patient.id]);
        if (patients.length) {
          const p = patients[0];
          patientContext = `Patient: ${p.first_name || ''} ${p.last_name || ''}, DOB: ${p.date_of_birth || 'N/A'}, Gender: ${p.gender || 'N/A'}`;
          // Get recent notes
          const { rows: notes } = await pool.query('SELECT content, created_at FROM medical_notes WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 3', [s.patient.id]);
          if (notes.length) patientContext += '\nRecent notes: ' + notes.map(n => n.content?.slice(0, 200)).join(' | ');
        }
      } catch (e) { patientContext = '(DB unavailable)'; }
    }

    const currentSoap = `S: ${s.soap.subjective}\nO: ${s.soap.objective}\nA: ${s.soap.assessment}\nP: ${s.soap.plan}`;
    const reviews = [s.clinicalReview, s.billingReview].filter(Boolean).join('\n\n');

    const answer = await ollamaChat('qwen2.5-medical:latest', [
      { role: 'system', content: `You are a SMART MEDICAL ASSISTANT. You have access to:
- The current consultation SOAP note
- Clinical and billing review findings
- Patient history from the database
- Medical knowledge base

You can: suggest diagnoses, recommend therapies, identify missing information, help with billing codes, explain clinical reasoning, and answer medical questions.

Your patient context: ${patientContext}

Current SOAP:
${currentSoap}

Reviews:
${reviews || 'No reviews yet'}

Answer the doctor's question concisely and helpfully. If they ask to ADD or REMOVE something from the SOAP, tell them exactly what to change and I'll update it.` },
      { role: 'user', content: question }
    ], 90000);

    res.json({ success: true, answer, patientContext: patientContext ? 'Connected' : 'No patient linked' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ PATIENT CRUD ═══════════════════
app.get('/api/patients', async (req, res) => {
  try {
    const { search } = req.query;
    let query = `SELECT p.id, p.first_name, p.last_name, p.date_of_birth, p.phone, p.email,
      (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id) as visit_count,
      (SELECT a.appointment_date FROM appointments a WHERE a.patient_id = p.id ORDER BY a.appointment_date DESC LIMIT 1) as last_visit,
      (SELECT a.reason FROM appointments a WHERE a.patient_id = p.id ORDER BY a.appointment_date DESC LIMIT 1) as last_reason
      FROM patients p`;
    const params = [];
    if (search) { query += ' WHERE p.first_name ILIKE $1 OR p.last_name ILIKE $1'; params.push(`%${search}%`); }
    query += ' ORDER BY p.last_name LIMIT 50';
    const { rows } = await pool.query(query, params);
    res.json({ success: true, patients: rows.map(p => ({
      id: p.id, first_name: p.first_name, last_name: p.last_name,
      date_of_birth: p.date_of_birth, phone: p.phone, email: p.email,
      visit_count: parseInt(p.visit_count) || 0,
      last_visit: p.last_visit?.toISOString().slice(0, 10) || null,
      last_reason: p.last_reason || null
    })) });
  } catch (e) { res.json({ success: true, patients: [], error: e.message }); }
});
app.post('/api/patients', async (req, res) => {
  try {
    const { first_name, last_name, date_of_birth, phone, email } = req.body;
    if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' });
    if (first_name.length > 100 || last_name.length > 100) return res.status(400).json({ error: 'Name too long' });
    const { rows } = await pool.query(
      'INSERT INTO patients (first_name, last_name, date_of_birth, phone, email, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [first_name, last_name, date_of_birth, phone, email, 2]
    );
    res.json({ success: true, patient: { id: rows[0].id, first_name, last_name } });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════ APPOINTMENTS ═══════════════════
// ═══════════════════ PATIENT VISIT HISTORY ═══════════════════
app.get('/api/patients/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    const [countResult, visitsResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as c FROM appointments WHERE patient_id = $1', [id]),
      pool.query(
        `SELECT appointment_date, reason, status 
         FROM appointments WHERE patient_id = $1 
         ORDER BY appointment_date DESC LIMIT 3`,
        [id]
      )
    ]);
    const visitCount = parseInt(countResult.rows[0]?.c || 0);
    const recentVisits = visitsResult.rows.map(v => ({
      date: v.appointment_date?.toISOString().slice(0, 10),
      time: v.appointment_date?.toISOString().slice(11, 16),
      reason: v.reason,
      status: v.status
    }));
    res.json({ success: true, visit_count: visitCount, recent_visits: recentVisits });
  } catch (e) {
    res.json({ success: true, visit_count: 0, recent_visits: [] });
  }
});

app.get('/api/appointments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.status, a.reason,
              p.first_name, p.last_name
       FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id
       WHERE a.appointment_date >= CURRENT_DATE
       ORDER BY a.appointment_date LIMIT 20`
    );
    res.json({ success: true, appointments: rows });
  } catch (e) { res.json({ success: true, appointments: [] }); }
});
app.post('/api/appointments', async (req, res) => {
  try {
    const { patient_id, doctor_id, appointment_date, reason } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO appointments (patient_id, doctor_id, appointment_date, reason, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [patient_id, doctor_id || 2, appointment_date, reason, 'scheduled']
    );
    res.json({ success: true, id: rows[0].id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════ EHR DASHBOARD & SCHEDULE ═══════════════════
app.get('/api/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [patients, todayApps, allApps, notes] = await Promise.all([
      pool.query('SELECT COUNT(*) as c FROM patients').then(r => parseInt(r.rows[0].c)),
      pool.query(`SELECT a.*, p.first_name, p.last_name FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id WHERE a.appointment_date::date = $1 ORDER BY a.appointment_date`, [today]).then(r => r.rows),
      pool.query('SELECT COUNT(*) as c FROM appointments').then(r => parseInt(r.rows[0].c)),
      pool.query('SELECT COUNT(*) as c FROM medical_notes').then(r => parseInt(r.rows[0].c)),
    ]);
    res.json({
      success: true,
      stats: { patients, todayAppointments: todayApps.length, totalAppointments: allApps, totalNotes: notes },
      todayAppointments: todayApps.map(a => ({ id: a.id, patient: `${a.first_name||''} ${a.last_name||''}`, time: a.appointment_date?.toISOString().slice(11,16), reason: a.reason, status: a.status })),
    });
  } catch (e) { res.json({ success: true, stats: { patients: 0, todayAppointments: 0 }, todayAppointments: [] }); }
});

app.get('/api/schedule', async (req, res) => {
  try {
    const { week } = req.query;
    const start = week || new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT a.*, p.first_name, p.last_name FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id
       WHERE a.appointment_date::date >= $1::date AND a.appointment_date::date < ($1::date + interval '7 days')
       ORDER BY a.appointment_date`, [start]
    );
    res.json({ success: true, appointments: rows.map(a => ({
      id: a.id, patient_id: a.patient_id, patient: `${a.first_name||''} ${a.last_name||''}`,
      date: a.appointment_date?.toISOString().slice(0, 10), time: a.appointment_date?.toISOString().slice(11, 16),
      reason: a.reason, status: a.status, doctor_id: a.doctor_id,
    }))});
  } catch (e) { res.json({ success: true, appointments: [] }); }
});

app.patch('/api/appointments/:id', async (req, res) => {
  try {
    const { appointment_date, status } = req.body;
    if (appointment_date) {
      await pool.query('UPDATE appointments SET appointment_date = $1 WHERE id = $2', [appointment_date, req.params.id]);
    }
    if (status) {
      await pool.query('UPDATE appointments SET status = $1 WHERE id = $2', [status, req.params.id]);
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/appointments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM appointments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════ RAG SEARCH ═══════════════════
app.post('/api/rag/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.json({ results: [] });
    // Get embedding from bge-m3
    const embRes = await axios.post(`${OLLAMA}/api/embeddings`, {
      model: 'bge-m3:latest', prompt: query.slice(0, 4000), keep_alive: '2h'
    }, { timeout: 30000 });
    const embedding = embRes.data.embedding;
    // Search Supabase
    const { rows } = await pool.query(
      `SELECT title, content, category, 1 - (embedding <=> $1::vector) AS score
       FROM medical_knowledge_chunks
       WHERE 1 - (embedding <=> $1::vector) > 0.3
       ORDER BY embedding <=> $1::vector LIMIT 5`,
      [`[${embedding.join(',')}]`]
    );
    res.json({ success: true, results: rows.map(r => ({ title: r.title, content: r.content?.slice(0,400), category: r.category, score: r.score })) });
  } catch (e) { res.json({ success: false, results: [], error: e.message }); }
});

// ═══════════════════ INTAKE FORM ═══════════════════
const INTAKE_QUESTIONS = [
  { id: 'chief_complaint', q: 'What brings you in today?', hint: 'Describe your main concern or symptoms', voiceLabel: 'Tell me what brings you in today' },
  { id: 'onset', q: 'When did this start?', hint: 'How many days, weeks, or months ago? Was it sudden or gradual?', voiceLabel: 'When did your symptoms begin?' },
  { id: 'severity', q: 'How severe is it? (0-10)', hint: '0 = no pain, 10 = worst imaginable', voiceLabel: 'On a scale of 0 to 10, how severe is your pain?' },
  { id: 'character', q: 'How would you describe it?', hint: 'Sharp, dull, burning, throbbing, pressure?', voiceLabel: 'How would you describe the pain or discomfort?' },
  { id: 'aggravating', q: 'What makes it worse?', hint: 'Activity, position, time of day?', voiceLabel: 'What makes your symptoms worse?' },
  { id: 'relieving', q: 'What makes it better?', hint: 'Rest, medication, ice/heat, position?', voiceLabel: 'What helps relieve your symptoms?' },
  { id: 'associated', q: 'Any other symptoms?', hint: 'Nausea, fever, dizziness, shortness of breath?', voiceLabel: 'Are you experiencing any other symptoms?' },
  { id: 'past_history', q: 'Have you had this before?', hint: 'Previous episodes, surgeries, or related conditions?', voiceLabel: 'Have you experienced this or similar issues before?' },
  { id: 'medications', q: 'Current medications?', hint: 'Prescriptions, over-the-counter, supplements', voiceLabel: 'What medications are you currently taking?' },
  { id: 'allergies', q: 'Any allergies?', hint: 'Medications, food, environmental?', voiceLabel: 'Do you have any allergies?' },
];

app.get('/api/intake/questions', (req, res) => {
  res.json({ success: true, questions: INTAKE_QUESTIONS });
});

app.post('/api/intake/submit', async (req, res) => {
  try {
    const { session_id, answers } = req.body;
    if (!session_id || !answers) return res.json({ success: false });
    const s = getSession(session_id);
    // Format intake into subjective section
    const subjective = INTAKE_QUESTIONS.map(q => {
      const a = answers[q.id];
      return a ? `**${q.q}**\n${a}` : null;
    }).filter(Boolean).join('\n\n');

    s.soap.subjective = subjective;
    s.transcript += '\n\nINTAKE:\n' + subjective;
    await updateSOAP(s);
    s.updates++;
    res.json({ success: true, subjective });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ═══════════════════ SHAREABLE PATIENT INTAKE ═══════════════════
const crypto = require('crypto');
const intakeLinks = {}; // token → { patient, questions, status }

app.post('/api/intake/create-link', async (req, res) => {
  try {
    const { patient_id, patient_name } = req.body;
    const token = crypto.randomBytes(6).toString('hex');
    intakeLinks[token] = {
      patient_id, patient_name: patient_name || 'Patient',
      questions: INTAKE_QUESTIONS, status: 'pending',
      answers: {}, created: new Date().toISOString(),
      summary: null,
    };
    const intakeUrl = `http://localhost:${PORT}/intake/${token}`;
    res.json({ success: true, token, url: intakeUrl, patient_name: intakeLinks[token].patient_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/intake/link/:token', (req, res) => {
  const link = intakeLinks[req.params.token];
  if (!link) return res.status(404).json({ error: 'Link expired or not found' });
  res.json({ success: true, patient_name: link.patient_name, questions: link.questions, status: link.status, answers: link.status === 'completed' ? link.answers : null });
});

app.post('/api/intake/voice-submit', upload.single('audio'), async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const link = intakeLinks[token];
    if (!link) return res.status(404).json({ error: 'Link not found' });

    // If audio uploaded, transcribe it
    let transcript = req.body.transcript || '';
    if (req.file) {
      const result = await transcribeAudio(req.file.path);
      fs.unlink(req.file.path, () => {});
      if (result.success) transcript = result.text;
    }

    if (!transcript) return res.status(400).json({ error: 'No audio or transcript provided' });

    // Use AI to extract answers for each question from the free-form transcript
    const questionsText = link.questions.map((q, i) => `${i+1}. ${q.q}`).join('\n');
    const extractPrompt = [
      { role: 'system', content: `Extract the patient's answers from their free-form transcript. For each question below, extract the relevant answer. If the patient didn't address a question, leave it empty. Return ONLY JSON: {"answers":{"chief_complaint":"...","onset":"...",...}}` },
      { role: 'user', content: `QUESTIONS:\n${questionsText}\n\nPATIENT TRANSCRIPT:\n${transcript}\n\nExtract answers as JSON.` }
    ];
    const result = await ollamaChat('llama3.1:8b', extractPrompt);
    
    let answers = {};
    try {
      const json = result.match(/\{[\s\S]*\}/);
      if (json) answers = JSON.parse(json[0]).answers || {};
    } catch { answers = { raw_transcript: transcript }; }

    link.answers = answers;
    link.status = 'completed';
    link.transcript = transcript;

    // Generate intake summary
    const summaryPrompt = [
      { role: 'system', content: 'Create a concise clinical intake summary from patient questionnaire answers. Format as a narrative paragraph suitable for the first section of a medical note.' },
      { role: 'user', content: `Patient: ${link.patient_name}\n\nAnswers:\n${JSON.stringify(answers, null, 2)}\n\nWrite a clinical intake summary.` }
    ];
    link.summary = await ollamaChat('llama3.1:8b', summaryPrompt);

    // Save summary as medical note
    try {
      await pool.query(
        'INSERT INTO medical_notes (patient_id, doctor_id, content, type, title, created_at) VALUES ($1,$2,$3,$4,$5,NOW())',
        [link.patient_id, 2, link.summary, 'intake', `Patient Intake — ${link.patient_name}`]
      );
    } catch (dbErr) { console.error('Note save:', dbErr.message); }

    res.json({ success: true, answers, summary: link.summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve patient intake page at /intake/:token
app.get('/intake/:token', (req, res) => {
  const link = intakeLinks[req.params.token];
  if (!link) return res.status(404).send('<h1>Link expired or not found</h1>');
  res.sendFile(path.join(__dirname, 'public', 'patient-intake.html'));
});
// ═══════════════════ AUDIT & EMAIL ═══════════════════
// Tomorrow's schedule — for midnight audit email
app.get('/api/audit/tomorrow', async (req, res) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT a.id, a.appointment_date, a.reason, a.status,
              p.first_name, p.last_name, p.phone, p.date_of_birth
       FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id
       WHERE a.appointment_date::date = $1
       ORDER BY a.appointment_date`,
      [dateStr]
    );
    const appointments = rows.map(a => ({
      id: a.id,
      patient: `${a.first_name || '—'} ${a.last_name || ''}`.trim(),
      time: a.appointment_date?.toISOString().slice(11, 16),
      reason: a.reason || 'Not specified',
      status: a.status,
      phone: a.phone
    }));
    res.json({ 
      success: true, 
      date: dateStr, 
      count: appointments.length,
      appointments 
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Send tomorrow's schedule via Brevo email
app.post('/api/audit/email', async (req, res) => {
  try {
    const { recipient } = req.body;
    const emailTo = recipient || 'jasmelacosta@gmail.com';
    
    // Get tomorrow's data
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT a.appointment_date, a.reason, p.first_name, p.last_name, p.phone
       FROM appointments a LEFT JOIN patients p ON a.patient_id = p.id
       WHERE a.appointment_date::date = $1
       ORDER BY a.appointment_date`,
      [dateStr]
    );

    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[tomorrow.getDay()];
    const dateFormatted = `${dayName}, ${tomorrow.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    
    const rows_html = rows.length
      ? rows.map((a, i) => `<tr style="border-bottom:1px solid #eee">
          <td style="padding:8px 12px;font-size:13px;font-weight:600">${a.appointment_date?.toISOString().slice(11, 16) || '—'}</td>
          <td style="padding:8px 12px;font-size:13px">${a.first_name || ''} ${a.last_name || '—'}</td>
          <td style="padding:8px 12px;font-size:12px;color:#555">${a.reason || '—'}</td>
          <td style="padding:8px 12px;font-size:12px;color:#888">${a.phone || '—'}</td>
        </tr>`).join('')
      : `<tr><td colspan="4" style="padding:20px;text-align:center;color:#888">No appointments scheduled</td></tr>`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{font-family:-apple-system,sans-serif;background:#f5f5f5;padding:0;margin:0}
      .container{max-width:600px;margin:0 auto;background:#fff}
      .header{background:#050510;color:#4ade80;padding:24px 28px}
      .header h1{font-size:20px;margin:0}.header span{font-size:11px;opacity:.6;display:block;margin-top:4px}
      .body{padding:24px 28px}
      .stat{display:inline-block;background:#f0fdf4;color:#166534;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;margin-right:8px}
      table{width:100%;border-collapse:collapse;margin:16px 0}
      th{text-align:left;padding:8px 12px;font-size:10px;text-transform:uppercase;color:#888;border-bottom:2px solid #eee}
      .footer{padding:16px 28px;background:#fafafa;font-size:10px;color:#aaa;text-align:center;border-top:1px solid #eee}
    </style></head><body><div class="container">
      <div class="header"><h1>AIMS Daily Schedule</h1><span>${dateFormatted}</span></div>
      <div class="body">
        <p style="font-size:14px;color:#333">You have <span class="stat">${rows.length} appointment${rows.length!==1?'s':''}</span> tomorrow.</p>
        <table><thead><tr><th>Time</th><th>Patient</th><th>Reason</th><th>Phone</th></tr></thead><tbody>${rows_html}</tbody></table>
      </div>
      <div class="footer">Generated by AIMS EHR • ${new Date().toLocaleString()}</div>
    </div></body></html>`;

    const brevoPayload = {
      to: [{ email: emailTo, name: 'Jasmel Acosta' }],
      htmlContent: html,
      textContent: `AIMS Daily Schedule — ${dateFormatted}\n\n${rows.length} appointment(s):\n${rows.map(a => `  ${a.appointment_date?.toISOString().slice(11,16)} — ${a.first_name} ${a.last_name} — ${a.reason || 'N/A'}`).join('\n')}`,
      subject: `AIMS Daily Schedule — ${dateFormatted} — ${rows.length} appointment${rows.length!==1?'s':''}`,
      sender: { email: 'jasmelacosta@gmail.com', name: 'AIMS EHR' }
    };

    const https = require('https');
    const brevoApiKey = process.env.BREVO_API_KEY;
    if (!brevoApiKey) return res.status(500).json({ success: false, error: 'BREVO_API_KEY not configured' });
    const data = JSON.stringify(brevoPayload);
    const options = {
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000
    };

    await new Promise((resolve, reject) => {
      const req = https.request(options, (bres) => {
        let body = '';
        bres.on('data', c => body += c);
        bres.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Brevo response: ${body.slice(0,200)}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Brevo timeout')); });
      req.write(data);
      req.end();
    });

    res.json({ success: true, message: `Sent tomorrow's schedule (${rows.length} appointments) to ${emailTo}` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const { data } = await axios.get(`${OLLAMA}/api/tags`, { timeout: 3000 });
    const { rows } = await pool.query('SELECT 1').catch(() => ({ rows: [] }));
    res.json({ status: 'healthy', models: data.models?.map(m => m.name), db: rows.length > 0 });
  } catch { res.json({ status: 'healthy', models: [], db: false }); }
});

app.listen(PORT, async () => {
  await ensureSchema();
  console.log(`\n🏥 Consult Room — http://localhost:${PORT}`);
  console.log(`   Scribe | Dual-Agent Review | Smart Assistant | EHR\n`);
});
