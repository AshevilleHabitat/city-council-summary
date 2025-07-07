// api/summarize.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';    // now safe—pdf-parse is already patched
                                        
const MATERIALS_URL =
  'https://www.ashevillenc.gov/government/city-council-meeting-materials/';
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText';

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
) {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY in env.' });
  }

  try {
    // 1) Grab the materials page
    const page = await fetch(MATERIALS_URL);
    if (!page.ok) throw new Error(`Fetch failed: ${page.status}`);
    const html = await page.text();

    // 2) Scrape any <a> with “minutes” in text or href
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_, a) => {
      const href = ($(a).attr('href')||'').trim();
      const txt  = ($(a).text() ||'').trim();
      if (/minutes/i.test(href) || /minutes/i.test(txt)) {
        rawLinks.push(href);
      }
    });

    if (!rawLinks.length) {
      return res
        .status(200)
        .json({ summary: '', message: 'No Minutes links found.' });
    }

    // 3) Normalize links (handle Google Drive, relative URLs, etc.)
    const pdfUrls = rawLinks.map(link => {
      const driveMatch =
        link.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
        link.match(/[?&]id=([A-Za-z0-9_-]+)/);
      if (link.includes('drive.google.com') && driveMatch) {
        return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
      }
      return link.startsWith('http') ? link : new URL(link, MATERIALS_URL).toString();
    });

    // 4) Download & parse each PDF, collect “housing” paragraphs
    let collected = '';
    for (const url of pdfUrls) {
      const r = await fetch(url);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const { text } = await pdfParse(buf);
      text
        .split(/\r?\n{2,}/)
        .filter(p => /housing/i.test(p))
        .forEach(p => (collected += p.trim() + '\n\n'));
    }

    if (!collected.trim()) {
      return res
        .status(200)
        .json({ summary: '', message: 'No housing mentions found.' });
    }

    // 5) Send to Gemini
    const g = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: { text: `Summarize the following for its housing content:\n\n${collected}` },
        temperature: 0.2,
      }),
    });
    const { candidates } = (await g.json()) as { candidates?: { output: string }[] };
    const summary = candidates?.[0]?.output ?? 'No summary from Gemini.';

    return res.status(200).json({ summary });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
