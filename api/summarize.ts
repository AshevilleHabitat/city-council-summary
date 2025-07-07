// api/summarize.ts

import { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { promises as fs } from 'fs';
import path from 'path';
import { createRequire } from 'module';

const MATERIALS_URL =
  'https://www.ashevillenc.gov/government/city-council-meeting-materials/';
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText';

export default async function handler(
  _req: VercelRequest,        // underscore silences the “never read” warning
  res: VercelResponse
) {
  // 0) API key check
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'Missing GEMINI_API_KEY (or API_KEY) in env.' });
  }

  try {
    // 1) Create a `require` function inside ESM
    const require = createRequire(import.meta.url);

    // 2) Locate pdf-parse in node_modules
    const pdfParseIndex = require.resolve('pdf-parse');
    const pdfParseDir   = path.dirname(pdfParseIndex);
    const dummyDir      = path.join(pdfParseDir, 'test', 'data');
    const dummyPath     = path.join(dummyDir, '05-versions-space.pdf');

    // 3) Write a minimal PDF before pdf-parse ever loads
    await fs.mkdir(dummyDir,    { recursive: true });
    await fs.writeFile(
      dummyPath,
      '%PDF-1.1\n%âãÏÓ\n',       // minimal PDF header
      'binary'
    );

    // 4) Dynamically import pdf-parse (now that dummy file exists)
    const pdfParseModule = await import('pdf-parse');
    const pdfParse = (pdfParseModule.default ?? pdfParseModule) as (
      data: Buffer
    ) => Promise<{ text: string }>;

    // 5) Fetch the City Council materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(
        `Failed to fetch materials page: ${pageResp.status} ${pageResp.statusText}`
      );
    }
    const html = await pageResp.text();

    // 6) Scrape for any <a> whose text or href contains “minutes”
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_: any, a: any) => {
      const href = ($(a).attr('href') || '').trim();
      const txt  = ($(a).text()     || '').trim();
      if (/minutes/i.test(href) || /minutes/i.test(txt)) {
        rawLinks.push(href);
      }
    });

    if (rawLinks.length === 0) {
      return res
        .status(200)
        .json({ summary: '', message: 'No Minutes links found.' });
    }

    // 7) Normalize to direct-download URLs (incl. Google Drive)
    const pdfUrls = rawLinks.map(link => {
      const driveMatch =
        link.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
        link.match(/[?&]id=([A-Za-z0-9_-]+)/);
      if (link.includes('drive.google.com') && driveMatch) {
        return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
      }
      return link.startsWith('http')
        ? link
        : new URL(link, MATERIALS_URL).toString();
    });

    // 8) Download & parse each PDF, collecting “housing” paragraphs
    let collectedText = '';
    for (const url of pdfUrls) {
      try {
        const pdfResp = await fetch(url);
        if (!pdfResp.ok) {
          console.warn(`Skipping ${url}: ${pdfResp.status} ${pdfResp.statusText}`);
          continue;
        }
        const arrayBuffer = await pdfResp.arrayBuffer();
        const { text } = await pdfParse(Buffer.from(arrayBuffer));
        text
          .split(/\r?\n{2,}/g)
          .filter(p => /housing/i.test(p))
          .forEach(p => {
            collectedText += p.trim() + '\n\n';
          });
      } catch (pdfErr) {
        console.warn(`Error parsing ${url}:`, pdfErr);
      }
    }

    if (!collectedText.trim()) {
      return res
        .status(200)
        .json({ summary: '', message: 'No housing mentions found.' });
    }

    // 9) Call Gemini for a concise summary
    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: { text: `Summarize the following for its housing content:\n\n${collectedText}` },
        temperature: 0.2,
      }),
    });
    const geminiData = (await geminiResp.json()) as {
      candidates?: { output: string }[];
    };
    const summary =
      geminiData.candidates?.[0]?.output || 'No summary returned by Gemini.';

    return res.status(200).json({ summary });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message || err });
  }
}
