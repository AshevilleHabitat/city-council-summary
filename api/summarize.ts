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
  // 1) Service‐Account ENV guard & auth setup
  const b64 = process.env.GSA_KEY_B64;
  if (!b64) {
    console.error('⚠️ Missing GSA_KEY_B64');
    return res.status(500).json({ error: 'GSA_KEY_B64 not set' });
  }

  let drive;
  try {
    const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    drive = google.drive({ version: 'v3', auth });
  } catch (e: any) {
    console.error('⚠️ Invalid GSA_KEY_B64 JSON:', e);
    return res.status(500).json({ error: 'Invalid GSA_KEY_B64' });
  }

  // 2) Gemini & optional public‐key guards
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  }
  const publicKey = process.env.DRIVE_API_KEY; // optional fallback

  try {
    // 3) Fetch and scrape the materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) throw new Error(`Materials fetch ${pageResp.status}`);
    const $ = cheerio.load(await pageResp.text());

    const rawLinks: string[] = [];
    $('a[href]').each((_i: number, el: any) => {
      const href = ($(el).attr('href') || '').trim();
      const isPdf   = /\.pdf($|\?)/i.test(href);
      const isDrive = /drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+/.test(href);
      if (isPdf || isDrive) rawLinks.push(href);
    });

    if (!rawLinks.length) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No Minutes found.' });
    }

    // 4) Download & extract “housing” text from each PDF
    let collected = '';
    for (const href of rawLinks) {
      try {
        let buffer: Buffer;

        if (href.includes('drive.google.com')) {
          // extract fileId
          const m =
            href.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
            href.match(/[?&]id=([A-Za-z0-9_-]+)/);
          if (!m) throw new Error('Bad Drive URL');
          const fileId = m[1];

          // #1: try Service Account download
          try {
            const ab = await drive.files
              .get(
                { fileId, alt: 'media', supportsAllDrives: true },
                { responseType: 'arraybuffer' }
              )
              .then(r => r.data as ArrayBuffer);
            buffer = Buffer.from(new Uint8Array(ab));
          } catch (svcErr: any) {
            // #2: fallback to public‐files API key
            if (!publicKey) throw svcErr;
            console.warn(`ServiceAccount failed (${svcErr.code}); falling back`);
            const pubUrl = `https://www.googleapis.com/drive/v3/files/${fileId}` +
              `?alt=media&key=${publicKey}`;
            const r2 = await fetch(pubUrl, { redirect: 'follow' });
            if (!r2.ok) throw new Error(`Public fetch ${r2.status}`);
            const ab2 = await r2.arrayBuffer();
            buffer = Buffer.from(new Uint8Array(ab2));
          }
        } else {
          // direct PDF link
          const r = await fetch(href, { redirect: 'follow' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const ab = await r.arrayBuffer();
          buffer = Buffer.from(new Uint8Array(ab));
        }

        // parse PDF text
        const { text } = await pdfParse(buffer);
        text
          .split(/\r?\n{2,}/)
          .filter((p: string) => /housing/i.test(p))
          .forEach((p: string) => {
            collected += p.trim() + '\n\n';
          });
      } catch (dlErr: any) {
        console.warn(`Skipping ${href}: ${dlErr.message}`);
      }
    }

    if (!collected.trim()) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No housing found.' });
    }

    // 5) Summarize via Gemini
    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: { text: `Summarize housing content:\n\n${collected}` },
        temperature: 0.2,
      }),
    });
    const data = (await geminiResp.json()) as {
      candidates?: { output: string }[];
    };
    const summary = data.candidates?.[0]?.output ?? 'No summary returned.';

    return res.status(200).json({ summaries: [summary] });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
