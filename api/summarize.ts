// api/summarize.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const MATERIALS_URL =
  'https://www.ashevillenc.gov/government/city-council-meeting-materials/';
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // 0. API key check
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'Missing GEMINI_API_KEY (or API_KEY) in env.' });
  }

  try {
    // 1) Inject dummy PDF so pdf-parse won’t crash on startup
    const pdfParseIndex = require.resolve('pdf-parse');
    const pdfParseDir = path.dirname(pdfParseIndex);
    const dummyDir = path.join(pdfParseDir, 'test', 'data');
    const dummyPath = path.join(dummyDir, '05-versions-space.pdf');

    await fs.promises.mkdir(dummyDir, { recursive: true });
    await fs.promises.writeFile(
      dummyPath,
      '%PDF-1.1\n%âãÏÓ\n',   // minimal PDF header
      'binary'
    );

    // 2) Now require pdf-parse (won’t throw ENOENT anymore)
    const pdfParse = require('pdf-parse') as (
      data: Buffer
    ) => Promise<{ text: string }>;

    // 3) Fetch the City Council materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(
        `Failed to fetch materials page: ${pageResp.status} ${pageResp.statusText}`
      );
    }
    const html = await pageResp.text();

    // 4) Scrape for any link with “minutes” in its text or URL
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_, a) => {
      const href = ($(a).attr('href') || '').trim();
      const txt = ($(a).text() || '').trim();
      if (/minutes/i.test(txt) || /minutes/i.test(href)) {
        rawLinks.push(href);
      }
    });

    if (rawLinks.length === 0) {
      return res
        .status(200)
        .json({ summary: '', message: 'No Minutes links found.' });
    }

    // 5) Normalize to direct-download URLs (handles Google Drive too)
    const pdfUrls = rawLinks.map(link => {
      const driveMatch =
        link.match(/\/d\/([a-zA-Z0-9_-]+)\//) ||
        link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (link.includes('drive.google.com') && driveMatch) {
        const fileId = driveMatch[1];
        return `https://drive.google.com/uc?export=download&id=${fileId}`;
      }
      return link.startsWith('http')
        ? link
        : new URL(link, MATERIALS_URL).toString();
    });

    // 6) Download & parse each PDF, collecting “housing” paragraphs
    let collectedText = '';
    for (const url of pdfUrls) {
      try {
        const pdfResp = await fetch(url);
        if (!pdfResp.ok) {
          console.warn(`Skipping ${url}: ${pdfResp.statusText}`);
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

    // 7) Send to Gemini for a concise housing-focused summary
    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: {
          text: `Summarize the following for its housing content:\n\n${collectedText}`,
        },
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
