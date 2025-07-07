// api/summarize.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch, { Response as FetchResponse } from 'node-fetch';
import * as cheerio from 'cheerio';
import type { Element } from 'cheerio';
import pdfParse from 'pdf-parse';

const MATERIALS_URL =
  'https://www.ashevillenc.gov/government/city-council-meeting-materials/';
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText';

/**
 * Fetches a Google Drive PDF, handling the confirm token for large files.
 */
async function fetchDrivePdf(url: string): Promise<FetchResponse> {
  // Extract file ID
  const idMatch =
    url.match(/\/d\/([A-Za-z0-9_-]+)\//) || url.match(/[?&]id=([A-Za-z0-9_-]+)/);
  const fileId = idMatch ? idMatch[1] : null;
  if (!fileId) {
    return fetch(url) as Promise<FetchResponse>;
  }

  const base = 'https://drive.google.com/uc?export=download';
  let resp: FetchResponse = await fetch(`${base}&id=${fileId}`, { redirect: 'manual' });
  const ct = (resp.headers.get('content-type') || '').toLowerCase();

  // If HTML, extract confirm token and re-fetch
  if (ct.includes('text/html')) {
    const body = await resp.text();
    const tokenMatch = body.match(/confirm=([0-9A-Za-z_]+)&/);
    if (tokenMatch) {
      const token = tokenMatch[1];
      resp = await fetch(`${base}&confirm=${token}&id=${fileId}`) as FetchResponse;
    }
  }
  return resp;
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
    // Fetch materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) throw new Error(`Fetch failed: ${pageResp.status}`);
    const html = await pageResp.text();

    // Scrape PDF & Drive links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_: any, a: Element) => {
      const href = ($(a).attr('href') || '').trim();
      const isPdf = /\.pdf($|\?)/i.test(href);
      const isDrive = /drive\.google\.com\//i.test(href);
      if (isPdf || isDrive) rawLinks.push(href);
    });

    if (!rawLinks.length) {
      return res.status(200).json({ summary: '', message: 'No Minutes links found.' });
    }

    // Normalize URLs
    const pdfUrls = rawLinks.map(link => link);

    // Download & parse
    let collected = '';
    for (const url of pdfUrls) {
      try {
        const resp = url.includes('drive.google.com')
          ? await fetchDrivePdf(url)
          : (await fetch(url));
        if (!resp.ok) {
          console.warn(`Skip ${url}: HTTP ${resp.status}`);
          continue;
        }
        const contentType = (resp.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
          console.warn(`Skip ${url}: content-type ${contentType}`);
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        const { text } = await pdfParse(buffer);
        text.split(/\r?\n{2,}/).filter((p: string) => /housing/i.test(p)).forEach((p: string) => {
          collected += p.trim() + '\n\n';
        });
      } catch (err: any) {
        console.warn(`Parse error ${url}: ${err.message}`);
      }
    }

    if (!collected.trim()) {
      return res.status(200).json({ summary: '', message: 'No housing mentions found.' });
    }

    // Summarize with Gemini
    const geminiResp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: { text: `Summarize housing content:\n\n${collected}` }, temperature: 0.2 }),
    });
    const data = (await geminiResp.json()) as { candidates?: { output: string }[] };
    const summary = data.candidates?.[0]?.output || 'No summary returned.';

    return res.status(200).json({ summary });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
