# Before You Sign

A homeowner uploads a building contract (PDF or Word, up to 150MB), gets a **free instant
scan** that flags specific clause categories worth a closer look, then can **unlock a full,
plain-English review** with explanations and questions to ask their builder.

Internally this uses the Claude API to generate the full review. None of the
customer-facing copy mentions this — by design, per Christian's direction — so keep it
that way in any future copy changes: no "AI" wording anywhere a visitor sees. The one
honest disclosure line ("automated document-review technology... not a licensed
conveyancer, lawyer, or building professional") lives in the footer and should stay,
since it protects the business as much as the visitor.

## How large files are handled


Two platform limits matter here:

- Vercel's serverless functions have a hard ~4.5MB limit on data sent directly in a
  request — not something adjustable in config.
- The Claude API itself caps a raw PDF upload at 32MB per request, regardless of platform.

To support files up to 150MB, the architecture changed:

1. The browser uploads the file **directly to Vercel Blob storage** (`api/blob-upload.js`
   just issues a secure, short-lived upload token — the file itself never passes through
   our server), bypassing the 4.5MB wall entirely.
2. The server then extracts the **text** from that file (`pdf-parse` for PDFs, `mammoth`
   for `.docx`) and sends only that text to Claude — never the raw file. Even a 150MB PDF
   usually yields only a few hundred KB of text, well under any size limit.
3. The uploaded file is deleted from storage once the full review finishes.

**The one real limitation this doesn't solve:** a scanned or photographed document with
no selectable text layer has nothing to extract, no matter how it's uploaded. That needs
OCR, which isn't built here. Most digitally-produced contracts (typed, exported to PDF)
are fine; a phone-photo scan of a paper contract may not be.

## Setup: create a Vercel Blob store (new, required)

Large uploads won't work until this is done:

1. In your Vercel project, go to the **Storage** tab → **Create Database** → **Blob**
2. Connect it to this project — Vercel automatically adds a `BLOB_READ_WRITE_TOKEN`
   environment variable, no manual copying needed
3. Redeploy if the store was created after your last deploy

## How the flow works

1. Visitor uploads a file → it goes straight to Blob storage from the browser
2. `api/scan.js` fetches it, extracts text, and runs a fast **keyword/pattern match** (no
   Claude call, no cost) — returning just the *category labels* that matched (e.g.
   "Variation & change-order pricing"). This is the free hook.
3. Visitor sees those labels locked, plus a paywall panel and the pricing section
4. Clicking **"Unlock Full Review"** currently calls `api/analyze.js` directly — there is
   **no payment step wired in yet**. See "Adding Stripe" below before launching for real.

## Pricing (displayed, not yet enforced)

The site now shows the real pricing structure:

- **Single Review** — $24.95 (one contract)
- **3 Review Pack** — $39.95 (up to three reviews, same project)
- **Supporting Documents** — +$3.50 each

This is currently **display only**. The interactive purchase logic — choosing a tier,
tracking a 3-pack's remaining credits, attaching supporting documents to a review, and
emailing the result — all needs real payment and a small database to track
purchases/credits. That's a meaningfully bigger build than the current single-document
placeholder flow, and is best done together with the Stripe integration below. Say the
word when you're ready and I'll scope and build it.

## Project structure

```
before-you-sign/
├── index.html              ← frontend: upload, free scan, paywall, pricing, full review
├── api/
│   ├── blob-upload.js        ← issues secure tokens for direct browser-to-storage uploads
│   ├── scan.js                ← free keyword pre-scan (no API cost)
│   └── analyze.js             ← full review — calls the Claude API
├── lib/
│   └── extractText.js         ← shared PDF/docx text extraction from a blob URL
├── package.json
├── vercel.json
├── .env.example
└── .gitignore
```

## 1. Get an Anthropic API key

1. Go to https://console.anthropic.com/settings/keys
2. Create an API key, and add billing/credits to the account
3. Keep it somewhere safe — you'll paste it into Vercel, not into the code

## 2. Push this to GitHub

```bash
cd before-you-sign
git init
git add .
git commit -m "Redesign: branding, large files, pricing"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 3. Deploy on Vercel

1. Go to https://vercel.com/new and import the GitHub repo
2. Vercel auto-detects the `api/` folder as serverless functions and serves
   `index.html` as a static file — no build step needed
3. Project Settings → Environment Variables → add `ANTHROPIC_API_KEY` (Production,
   Preview, and Development)
4. Set up the Blob store (see above) — its token is added automatically
5. Deploy

## Adding Stripe (before real launch)

Right now "Unlock Full Review" is a placeholder — it runs the full review with no
payment check. Before you run paid ads:

1. Create a Stripe account and Products/Prices matching the real pricing (Single Review,
   3 Review Pack, Supporting Document add-on)
2. Add a Stripe Checkout flow: a new `api/create-checkout.js` function that creates a
   session for the chosen tier and returns its URL; the frontend redirects there instead
   of calling `/api/analyze` directly
3. Add a webhook (`api/stripe-webhook.js`) that verifies payment, then either runs the
   review server-side and emails the result, or issues a short-lived token the frontend
   uses to call `/api/analyze` once
4. For the 3 Review Pack: track purchased/remaining credits somewhere (Vercel Postgres or
   KV both work) keyed to the buyer's email, so they can return and use their remaining
   reviews later
5. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as environment variables in Vercel

I can build this out fully whenever you're ready.

## Rate limiting

`api/scan.js` (10 requests/minute/IP) and `api/analyze.js` (5 requests/minute/IP) have
in-memory per-IP rate limiting to blunt bot traffic or a cost spike. This lives only in a
single warm serverless instance's memory — a soft limit, not a hard guarantee, under real
scale-out. For a strict global limit at serious ad volume, swap it for Vercel KV or
Upstash Redis.

## Local development

```bash
npm install
npm install -g vercel
vercel dev
```

Create a `.env` file (copy `.env.example`) with your real API key before running locally.
Blob uploads need `BLOB_READ_WRITE_TOKEN` too — `vercel env pull .env.development.local`
after creating the store will fetch it automatically.

## Notes and limitations

- **File size:** up to 150MB, uploaded directly to Blob storage (client- and
  server-validated).
- **File types:** PDF and `.docx` only. Both are always converted to plain text before
  any processing — see "How large files are handled" above, including the scanned-PDF
  caveat.
- **Model:** `api/analyze.js` calls `claude-sonnet-5`. Change the `MODEL` constant there
  to switch models.
- **Cost:** the free scan costs nothing (no Claude call). Every unlocked full review
  makes one Claude API call — keep an eye on usage in the Anthropic console, and finish
  the Stripe integration above before this goes out in ads, or you'll be paying for
  reviews nobody paid for.
- **Storage:** uploaded files are deleted from Blob storage once the full review
  finishes. If a visitor scans but never unlocks, that file can linger — consider adding
  a lifecycle/expiration rule in the Blob store dashboard, or a scheduled cleanup
  function, once you're past the testing phase.
