// api/summarize.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
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
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'Missing GEMINI_API_KEY (or API_KEY) in env.' });
  }

  try {
    // 1. Fetch the meeting materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(
        `Failed to fetch materials page: ${pageResp.status} ${pageResp.statusText}`
      );
    }
    const html = await pageResp.text();

    // 2. Scrape all 'Minutes' links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_: any, a: any) => {
      const href: string = $(a).attr('href')!.trim();
      const txt: string = ($(a).text() || '').trim();
      if (/minutes/i.test(txt) || /minutes/i.test(href)) {
        rawLinks.push(href);
      }
    });

    if (rawLinks.length === 0) {
      return res
        .status(200)
        .json({ summary: '', message: 'No Minutes links found.' });
    }

    // 3. Normalize to direct-download URLs
    const pdfUrls: string[] = rawLinks.map((link: string) => {
      const driveMatch =
        link.match(/\/d\/([a-zA-Z0-9_-]+)\//) ||
        link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (link.includes('drive.google.com') && driveMatch) {
        const fileId: string = driveMatch[1];
        return `https://drive.google.com/uc?export=download&id=${fileId}`;
      }
      return link.startsWith('http')
        ? link
        : new URL(link, MATERIALS_URL).toString();
    });

    // 4. Download + parse each PDF
    let collectedText = '';
    for (const url of pdfUrls) {
      try {
        const pdfResp = await fetch(url);
        if (!pdfResp.ok) {
          console.warn(`Skipping ${url}: ${pdfResp.statusText}`);
          continue;
        }
        const arrayBuffer: ArrayBuffer = await pdfResp.arrayBuffer();
        const { text }: { text: string } = await pdfParse(
          Buffer.from(arrayBuffer)
        );
        // 5. Filter for "housing" paragraphs
        text
          .split(/\r?\n{2,}/g)
          .filter((p: string) => /housing/i.test(p))
          .forEach((p: string) => {
            collectedText += p.trim() + '\n\n';
          });
      } catch (pdfErr: unknown) {
        console.warn(`Error parsing ${url}:`, pdfErr);
      }
    }

    if (!collectedText) {
      return res
        .status(200)
        .json({ summary: '', message: 'No housing mentions found.' });
    }

    // 6. Send to Gemini for summarization
    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: { text: `Summarize the following for its housing content:\n\n${collectedText}` },
        temperature: 0.2,
      }),
    });
    const geminiData = (await geminiResp.json()) as { candidates?: { output: string }[] };
    const summary =
      geminiData.candidates?.[0]?.output || 'No summary returned by Gemini.';

    return res.status(200).json({ summary });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}