// api/summarize.ts

import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';
import { google } from 'googleapis';

const MATERIALS_URL =
  'https://www.ashevillenc.gov/government/city-council-meeting-materials/';
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText';

/**
 * === Service Account Authentication ===
 * Read your base64-encoded JSON key from the GSA_KEY_B64 env var,
 * parse it, and give readonly Drive scope.
 */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(
    Buffer.from(process.env.GSA_KEY_B64!, 'base64').toString('utf8')
  ),
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

/**
 * Fetches a Drive file’s raw bytes via the authenticated Drive API.
 */
async function fetchDriveFile(fileId: string): Promise<Buffer> {
  const resp = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(resp.data as ArrayBuffer);
}

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
) {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY in env.' });
  }

  try {
    // 1) Fetch the Asheville Council materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(`Failed to fetch materials page: ${pageResp.status}`);
    }
    const html = await pageResp.text();

    // 2) Scrape out any .pdf links or Drive preview links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_i: number, el: any) => {
      const href = ($(el).attr('href') || '').trim();
      const isPdf       = /\.pdf($|\?)/i.test(href);
      const isDriveFile = /drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+/.test(href);
      if (isPdf || isDriveFile) {
        rawLinks.push(href);
      }
    });

    if (!rawLinks.length) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No Minutes links found.' });
    }

    // 3) Download & parse each PDF, extracting “housing” paragraphs
    let collected = '';
    for (const href of rawLinks) {
      try {
        let buffer: Buffer;

        if (href.includes('drive.google.com')) {
          // extract fileId from either /d/<id>/ or ?id=<id>
          const m =
            href.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
            href.match(/[?&]id=([A-Za-z0-9_-]+)/);
          if (!m) {
            console.warn('Could not parse Drive fileId from', href);
            continue;
          }
          const fileId = m[1];
          buffer = await fetchDriveFile(fileId);
        } else {
          // direct PDF link – just fetch it
          const r = await fetch(href, { redirect: 'follow' });
          if (!r.ok) {
            console.warn(`Skipping ${href}: HTTP ${r.status}`);
            continue;
          }
          const arrayBuffer = await r.arrayBuffer();
          buffer = Buffer.from(arrayBuffer);
        }

        // parse the PDF text
        const { text } = await pdfParse(buffer);

        // collect any paragraphs mentioning “housing”
        text
          .split(/\r?\n{2,}/)
          .filter((p: string) => /housing/i.test(p))
          .forEach((p: string) => {
            collected += p.trim() + '\n\n';
          });
      } catch (err: any) {
        console.warn(`Error processing ${href}: ${err.message}`);
      }
    }

    if (!collected.trim()) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No housing mentions found.' });
    }

    // 4) Send the collected housing text to Gemini for summarization
    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: { text: `Summarize the following for its housing content:\n\n${collected}` },
        temperature: 0.2,
      }),
    });
    const data = (await geminiResp.json()) as { candidates?: { output: string }[] };
    const summary = data.candidates?.[0]?.output || 'No summary returned.';

    // 5) Return a uniform array of summaries
    return res.status(200).json({ summaries: [summary] });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
