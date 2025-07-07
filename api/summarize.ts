// api/summarize.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';

const MATERIALS_URL =
  'https://www.ashevillenc.gov/government/city-council-meeting-materials/';
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText';

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
) {
  // 0) Ensure API key
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY in env.' });
  }

  try {
    // 1) Fetch the materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(
        `Failed to fetch materials page: ${pageResp.status} ${pageResp.statusText}`
      );
    }
    const html = await pageResp.text();

    // 2) Scrape only direct PDF & Google Drive preview links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_, a) => {
      const href = ($(a).attr('href') || '').trim();
      const isPdfLink = /\.pdf($|\?)/i.test(href);
      const isDriveLink = /drive\.google\.com\/.*(\/d\/|[?&]id=)/i.test(href);
      if (isPdfLink || isDriveLink) {
        rawLinks.push(href);
      }
    });

    if (!rawLinks.length) {
      return res
        .status(200)
        .json({ summary: '', message: 'No Minutes links found.' });
    }

    // 3) Normalize to direct-download PDF URLs
    const pdfUrls = rawLinks.map(link => {
      const driveMatch =
        link.match(/\/d\/([A-Za-z0-9_-]+)\//) || link.match(/[?&]id=([A-Za-z0-9_-]+)/);
      if (link.includes('drive.google.com') && driveMatch) {
        return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
      }
      return link.startsWith('http')
        ? link
        : new URL(link, MATERIALS_URL).toString();
    });

    // 4) Download & parse each PDF, filtering by PDF content-type & extracting "housing" paragraphs
    let collected = '';
    for (const url of pdfUrls) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          console.warn(`Skipping ${url}: HTTP ${resp.status} ${resp.statusText}`);
          continue;
        }
        const contentType = resp.headers.get('content-type') || '';
        if (!/pdf/i.test(contentType)) {
          console.warn(`Skipping ${url}: content-type is ${contentType}`);
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        const { text } = await pdfParse(buffer);
        text
          .split(/\r?\n{2,}/)
          .filter(p => /housing/i.test(p))
          .forEach(p => {
            collected += p.trim() + '\n\n';
          });
      } catch (err: any) {
        console.warn(`Error parsing ${url}: ${err.message}`);
      }
    }

    if (!collected.trim()) {
      return res
        .status(200)
        .json({ summary: '', message: 'No housing mentions found.' });
    }

    // 5) Send collected text to Gemini for summarization
    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: { text: `Summarize the following for its housing content:\n\n${collected}` },
        temperature: 0.2,
      }),
    });
    const geminiData = (await geminiResp.json()) as { candidates?: { output: string }[] };
    const summary = geminiData.candidates?.[0]?.output || 'No summary returned by Gemini.';

    return res.status(200).json({ summary });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
