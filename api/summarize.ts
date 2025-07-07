// api/summarize.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch, { Response as FetchResponse } from 'node-fetch';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';

const MATERIALS_URL =
  'https://www.ashevillenc.gov/government/city-council-meeting-materials/';
const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generateText';

/**
 * Fetches a Google Drive PDF, handling redirect and confirm tokens.
 */
async function fetchDrivePdf(url: string): Promise<FetchResponse> {
  // Extract the file ID
  const idMatch =
    url.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
    url.match(/[?&]id=([A-Za-z0-9_-]+)/);
  const fileId = idMatch ? idMatch[1] : null;
  if (!fileId) {
    return fetch(url) as Promise<FetchResponse>;
  }

  const base = 'https://drive.google.com/uc?export=download';
  // Initial request without auto-follow
  let resp: FetchResponse = await fetch(`${base}&id=${fileId}`, { redirect: 'manual' });

  // Follow HTTP redirects (e.g., 303) to the actual download URL
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get('location');
    if (location) {
      resp = await fetch(location) as FetchResponse;
    }
  }

  // Handle Google Drive confirm token for large files
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    const body = await resp.text();
    const tokenMatch = body.match(/confirm=([0-9A-Za-z_]+)&/);
    if (tokenMatch) {
      resp = await fetch(
        `${base}&confirm=${tokenMatch[1]}&id=${fileId}`
      ) as FetchResponse;
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
    // 1) Fetch materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(`Fetch failed: ${pageResp.status}`);
    }
    const html = await pageResp.text();

    // 2) Scrape PDF & Drive preview links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_i: number, el: any) => {
      const href = ($(el).attr('href') || '').trim();
      const isPdf   = /\.pdf($|\?)/i.test(href);
      const isDrive = /drive\.google\.com\//i.test(href);
      if (isPdf || isDrive) rawLinks.push(href);
    });

    if (!rawLinks.length) {
      return res.status(200).json({ summary: '', message: 'No Minutes links found.' });
    }

    // 3) Normalize URLs (Drive handled in fetch)
    const pdfUrls = rawLinks.map(link => link);

    // 4) Download & parse, extracting "housing"
    let collected = '';
    for (const link of pdfUrls) {
      try {
        const resp = link.includes('drive.google.com')
          ? await fetchDrivePdf(link)
          : await fetch(link);
        if (!resp.ok) {
          console.warn(`Skipping ${link}: HTTP ${resp.status}`);
          continue;
        }
        const contentType = (resp.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
          console.warn(`Skipping ${link}: content-type ${contentType}`);
          continue;
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        const { text } = await pdfParse(buffer);
        text.split(/\r?\n{2,}/)
            .filter((p: string) => /housing/i.test(p))
            .forEach((p: string) => {
              collected += p.trim() + '\n\n';
            });
      } catch (err: any) {
        console.warn(`Error parsing ${link}: ${err.message}`);
      }
    }

    if (!collected.trim()) {
      return res.status(200).json({ summary: '', message: 'No housing mentions found.' });
    }

    // 5) Summarize with Gemini
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

    return res.status(200).json({ summary });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
