import { del } from '@vercel/blob';
import { extractTextFromBlob } from '../lib/extractText.js';

const MODEL = 'claude-sonnet-5';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
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

const ANALYSIS_PROMPT = `You are helping a homeowner understand a residential building contract before they sign it.
You are not their lawyer and this is not legal advice — you are surfacing things worth asking about.

Read the contract text provided and respond with ONLY a single JSON object (no markdown
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

  const { blobUrl, filename } = req.body || {};
  if (!blobUrl || !filename) {
    res.status(400).json({ error: 'No file reference was provided.' });
    return;
  }

  try {
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

    const messageContent = [
      {
        type: 'text',
        text: `${ANALYSIS_PROMPT}\n\n--- CONTRACT TEXT START ---\n${text.slice(0, 350000)}\n--- CONTRACT TEXT END ---`,
      },
    ];

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
      res.status(502).json({ error: 'The review service returned an error. Please try again shortly.' });
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
      res.status(502).json({ error: 'Received an unexpected response while reviewing the contract. Please try again.' });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while reviewing your contract. Please try again.' });
  } finally {
    // Clean up the stored file now that we're done with it, successful or not.
    try {
      await del(blobUrl);
    } catch (delErr) {
      console.error('Failed to delete blob after processing:', delErr);
    }
  }
}
