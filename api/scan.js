import { IncomingForm } from 'formidable';
import fs from 'fs';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

export const config = {
  api: {
    bodyParser: false,
  },
};

const MAX_FILE_BYTES = 4 * 1024 * 1024;

// --- Shared in-memory rate limiting (mirrors api/analyze.js) -----------
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10; // scan is cheap, allow more than the full review
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  if (requestLog.size > 5000) requestLog.clear();
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// --- What the free pass looks for ---------------------------------------
// Plain keyword/pattern matching only — this never touches the paid review
// engine. It exists purely to show the visitor that specific, real sections
// of their own document are worth a closer look, before they unlock the
// full plain-English breakdown.
const CLAUSE_RULES = [
  { id: 'variation', label: 'Variation & change-order pricing', patterns: [/variation/i, /change order/i, /additional works?/i] },
  { id: 'provisional', label: 'Provisional sums & allowances', patterns: [/provisional sum/i, /\bPC item/i, /prime cost/i, /\ballowance/i] },
  { id: 'delay', label: 'Delay & liquidated damages', patterns: [/liquidated damages/i, /extension of time/i, /\bdelay/i] },
  { id: 'termination', label: 'Termination rights', patterns: [/terminat(e|ion|ing)/i] },
  { id: 'substitution', label: 'Material substitution rights', patterns: [/substitut(e|ion|ing)/i] },
  { id: 'payment', label: 'Payment schedule & deposits', patterns: [/progress payment/i, /payment schedule/i, /\bdeposit/i] },
  { id: 'defects', label: 'Defects & warranty period', patterns: [/defects liability/i, /\bwarrant(y|ies)/i] },
];

function runScan(text) {
  const flagged = [];
  for (const rule of CLAUSE_RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      flagged.push({ id: rule.id, label: rule.label });
    }
  }
  return flagged;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    return;
  }

  try {
    const form = new IncomingForm({ maxFileSize: MAX_FILE_BYTES });
    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const fileField = files.contract;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;

    if (!file) {
      res.status(400).json({ error: 'No file was uploaded.' });
      return;
    }

    const filename = file.originalFilename || file.newFilename || '';
    const ext = filename.split('.').pop().toLowerCase();
    const buffer = fs.readFileSync(file.filepath);

    let text = '';

    if (ext === 'pdf') {
      const parsed = await pdfParse(buffer);
      text = parsed.text || '';
    } else if (ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || '';
    } else if (ext === 'doc') {
      res.status(400).json({
        error: 'Older .doc files are not supported. Please save the document as .docx or .pdf and try again.',
      });
      return;
    } else {
      res.status(400).json({ error: 'Please upload a PDF or Word (.docx) file.' });
      return;
    }

    if (text.trim().length < 20) {
      res.status(400).json({ error: 'Could not read any text from that file.' });
      return;
    }

    const flagged = runScan(text);
    res.status(200).json({ flagged, documentLength: text.length });
  } catch (err) {
    console.error(err);
    if (err && err.code === 1009) {
      res.status(413).json({ error: 'That file is too large. Please upload a file under 4MB.' });
      return;
    }
    res.status(500).json({ error: 'Something went wrong while scanning your contract. Please try again.' });
  }
}
