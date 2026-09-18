import { handleUpload } from '@vercel/blob/client';

// Vercel needs the parsed JSON body here (this is a handshake call, not a file upload —
// the actual file bytes go straight from the browser to Blob storage, never through this function).
export const config = {
  api: {
    bodyParser: true,
  },
};

const MAX_UPLOAD_BYTES = 150 * 1024 * 1024; // 150MB

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // handleUpload wants a standard fetch Request object (for reading headers,
    // including the signature on the completion webhook). Rebuild one from the
    // Node request Vercel gives us.
    const request = new Request(`https://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
    });

    const jsonResponse = await handleUpload({
      body: req.body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {
        // Nothing to do here — the browser calls /api/scan (and later
        // /api/analyze) directly with the resulting blob URL once the
        // upload finishes.
      },
    });

    res.status(200).json(jsonResponse);
  } catch (err) {
    console.error('Blob upload handshake error:', err);
    res.status(400).json({ error: err.message || 'Upload failed.' });
  }
}
