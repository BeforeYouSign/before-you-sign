import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

// Fetches the uploaded file from Vercel Blob storage and extracts plain text
// from it. We always work from extracted text now (never the raw PDF bytes)
// so that very large files never hit Claude's 32MB-per-request document limit
// — the text of even a 150MB PDF is normally only a few hundred KB.
export async function extractTextFromBlob(blobUrl, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();

  const fileRes = await fetch(blobUrl);
  if (!fileRes.ok) {
    throw new Error('FETCH_FAILED');
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (ext === 'pdf') {
    const parsed = await pdfParse(buffer);
    return { text: parsed.text || '', ext };
  }

  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value || '', ext };
  }

  if (ext === 'doc') {
    throw new Error('DOC_UNSUPPORTED');
  }

  throw new Error('UNSUPPORTED_TYPE');
}
