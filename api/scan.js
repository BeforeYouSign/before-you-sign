import { extractTextFromBlob } from '../lib/extractText.js';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
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

// Plain keyword/pattern matching only — this never touches the paid review
// engine and costs nothing to run. It exists to show the visitor that
// specific, real sections of their own document are worth a closer look,
// before they unlock the full plain-English breakdown.
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
    const { blobUrl, filename } = req.body || {};
    if (!blobUrl || !filename) {
      res.status(400).json({ error: 'No file reference was provided.' });
      return;
    }

    let text;
    try {
      const result = await extractTextFromBlob(blobUrl, filename);
      text = result.text;
    } catch (err) {
      if (err.message === 'DOC_UNSUPPORTED') {
        res.status(400).json({ error: 'Older .doc files are not supported. Please save as .docx or PDF and try again.' });
        return;
      }
      if (err.message === 'UNSUPPORTED_TYPE') {
        res.status(400).json({ error: 'Please upload a PDF or Word (.docx) file.' });
        return;
      }
      throw err;
    }

    if (!text || text.trim().length < 20) {
      res.status(400).json({
        error: "We couldn't read any text from that file. If it's a scanned or photographed document, a text-based (digital) version works best.",
      });
      return;
    }

    const flagged = runScan(text);
    res.status(200).json({ flagged, documentLength: text.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while scanning your contract. Please try again.' });
  }
}
