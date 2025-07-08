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

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
) {
  // 1) Service-Account ENV Guard & Auth Setup
  const b64 = process.env.GSA_KEY_B64;
  if (!b64) {
    console.error('⚠️ GSA_KEY_B64 is not set');
    return res
      .status(500)
      .json({ error: 'Missing GSA_KEY_B64 environment variable' });
  }

  let drive;
  try {
    const creds = JSON.parse(
      Buffer.from(b64, 'base64').toString('utf8')
    );
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    drive = google.drive({ version: 'v3', auth });
  } catch (e: any) {
    console.error('⚠️ Failed to initialize GoogleAuth:', e);
    return res
      .status(500)
      .json({ error: 'Invalid GSA_KEY_B64 JSON' });
  }

  // 2) Gemini API key guard
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'Missing GEMINI_API_KEY in env.' });
  }

  try {
    // 3) Fetch the materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(`Failed to fetch materials page: ${pageResp.status}`);
    }
    const html = await pageResp.text();

    // 4) Scrape PDF & Drive-preview links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_i: number, el: any) => {
      const href = ($(el).attr('href') || '').trim();
      const isPdf = /\.pdf($|\?)/i.test(href);
      const isDriveFile =
        /drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+/.test(href) ||
        (/drive\.google\.com\/.*[?&]id=[A-Za-z0-9_-]+/.test(href) &&
         !/\/folders\//.test(href));
      if (isPdf || isDriveFile) {
        rawLinks.push(href);
      }
    });

    if (!rawLinks.length) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No Minutes links found.' });
    }

    // 5) Download & parse each PDF, extracting “housing”
    let collected = '';
    for (const href of rawLinks) {
      try {
        let buffer: Buffer;

        if (href.includes('drive.google.com')) {
          // extract fileId
          const m =
            href.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
            href.match(/[?&]id=([A-Za-z0-9_-]+)/);
          if (!m) {
            console.warn('Could not parse Drive fileId from', href);
            continue;
          }
          const fileId = m[1];
          // fetch raw PDF via Drive API
          const arrayBuffer = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'arraybuffer' }
          ).then(r => r.data as ArrayBuffer);
          buffer = Buffer.from(new Uint8Array(arrayBuffer));
        } else {
          // direct PDF link
          const r = await fetch(href, { redirect: 'follow' });
          if (!r.ok) {
            console.warn(`Skipping ${href}: HTTP ${r.status}`);
            continue;
          }
          const arrayBuffer = await r.arrayBuffer();
          buffer = Buffer.from(arrayBuffer);
        }

        const { text } = await pdfParse(buffer);
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

    // 6) Summarize via Gemini
    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: { text: `Summarize housing content:\n\n${collected}` },
        temperature: 0.2,
      }),
    });
    const data = (await geminiResp.json()) as { candidates?: { output: string }[] };
    const summary = data.candidates?.[0]?.output || 'No summary returned.';

    // 7) Return summaries array
    return res.status(200).json({ summaries: [summary] });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
