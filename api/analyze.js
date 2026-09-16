import { IncomingForm } from 'formidable';
import fs from 'fs';
import mammoth from 'mammoth';

// Vercel serverless functions need raw body access for multipart parsing
export const config = {
  api: {
    bodyParser: false,
  },
};

const MODEL = 'claude-sonnet-5';
const MAX_FILE_BYTES = 4 * 1024 * 1024; // keep comfortably under Vercel's request body limit

// --- Simple in-memory rate limiting -----------------------------------
// Lives only for as long as this serverless instance stays warm, so it's not
// a hard global guarantee under heavy scale-out — but it's enough to stop a
// single bot or a bad TikTok bot spike from running up API costs at launch.
// For guaranteed limits under real scale, swap this for Vercel KV / Upstash.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const requestLog = new Map(); // ip -> array of timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);

  // Keep the map from growing forever on a long-lived warm instance
  if (requestLog.size > 5000) {
    requestLog.clear();
  }

  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const ANALYSIS_PROMPT = `You are helping a homeowner understand a residential building contract before they sign it.
You are not their lawyer and this is not legal advice — you are surfacing things worth asking about.

Read the contract text/document provided and respond with ONLY a single JSON object (no markdown
fences, no commentary before or after) matching exactly this shape:

{
  "summary": "one or two plain-English sentences on the overall shape of this contract",
  "keyRisks": [
    { "title": "short label", "description": "plain-English explanation of the risk, 1-2 sentences", "question": "a specific question to ask the builder" }
  ],
  "costConcerns": [
    { "title": "short label", "description": "plain-English explanation, 1-2 sentences", "question": "a specific question to ask the builder" }
  ],
  "timeRisks": [
    { "title": "short label", "description": "plain-English explanation, 1-2 sentences", "question": "a specific question to ask the builder" }
  ],
  "otherNotes": [
    { "title": "short label", "description": "plain-English explanation, 1-2 sentences", "question": "a specific question to ask the builder, or empty string if none" }
  ]
}

Guidelines:
- Base every point on something actually present (or notably absent) in the document. Do not invent clauses.
- Include 2-5 items per category where the contract gives you material to work with. If a category has nothing worth flagging, return an empty array for it rather than padding it.
- Keep each description to 1-2 short sentences, plain English, no legal jargon.
- Focus on: variation/change-order pricing, provisional sums and allowances, delay/penalty (liquidated damages) clauses, payment schedules, termination clauses, material substitution rights, warranty/defects terms, and anything unusually one-sided.
- Never fabricate figures, dates, or clause numbers that are not in the document.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({
      error: 'Server is not configured with an ANTHROPIC_API_KEY. Add it in your Vercel project settings.',
    });
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

    let messageContent;

    if (ext === 'pdf') {
      const base64 = buffer.toString('base64');
      messageContent = [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        { type: 'text', text: ANALYSIS_PROMPT },
      ];
    } else if (ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      const text = (result.value || '').trim();

      if (text.length < 20) {
        res.status(400).json({ error: 'Could not read any text from that Word document.' });
        return;
      }

      messageContent = [
        { type: 'text', text: `${ANALYSIS_PROMPT}\n\n--- CONTRACT TEXT START ---\n${text.slice(0, 120000)}\n--- CONTRACT TEXT END ---` },
      ];
    } else if (ext === 'doc') {
      res.status(400).json({
        error: 'Older .doc files are not supported. Please save the document as .docx or .pdf and try again.',
      });
      return;
    } else {
      res.status(400).json({ error: 'Please upload a PDF or Word (.docx) file.' });
      return;
    }

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      res.status(502).json({ error: 'The analysis service returned an error. Please try again shortly.' });
      return;
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find((block) => block.type === 'text');
    const raw = textBlock ? textBlock.text : '';

    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse model output as JSON:', raw);
      res.status(502).json({ error: 'Received an unexpected response while analysing the contract. Please try again.' });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error(err);
    if (err && err.code === 1009) {
      // formidable maxFileSize exceeded
      res.status(413).json({ error: 'That file is too large. Please upload a file under 4MB.' });
      return;
    }
    res.status(500).json({ error: 'Something went wrong while analysing your contract. Please try again.' });
  }
}
