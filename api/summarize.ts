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
 * Proof-of-concept Drive downloader that:
 * 1. Hits the uc?export=download URL with a browser UA
 * 2. Follows all redirects
 * 3. If you still get HTML, parses out the confirm= token or #uc-download-link
 *    and re-fetches that link.
 */
async function fetchDrivePdf(link: string): Promise<FetchResponse> {
  // Browser-like headers
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/115.0.0.0 Safari/537.36',
    'Accept': 'application/pdf,application/octet-stream,*/*',
    // if needed, you can also send a referer:
    // 'Referer': 'https://drive.google.com'
  };

  // 1) Extract the fileId
  const idMatch =
    link.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
    link.match(/[?&]id=([A-Za-z0-9_-]+)/);
  const fileId = idMatch?.[1];
  if (!fileId) {
    // not a Drive URL, just fetch normally
    return fetch(link, { redirect: 'follow', headers });
  }

  // 2) Build the direct-download URL
  const baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

  // 3) First attempt: follow redirects
  let resp = await fetch(baseUrl, { redirect: 'follow', headers });
  let ct = (resp.headers.get('content-type') || '').toLowerCase();

  // 4) If we got HTML, parse out the confirm token or download link
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    const html = await resp.text();
    const $ = cheerio.load(html);

    // Try the #uc-download-link element first
    let dlHref = $('a#uc-download-link').attr('href');

    // Fallback: look for confirm=XYZ in a href
    if (!dlHref) {
      const m = html.match(/confirm=([0-9A-Za-z_-]+)&amp;id=/) ||
                html.match(/confirm=([0-9A-Za-z_-]+)&id=/);
      if (m) {
        dlHref = `/uc?export=download&confirm=${m[1]}&id=${fileId}`;
      }
    }

    if (dlHref) {
      // Normalize &amp; → &
      const downloadUrl =
        dlHref.startsWith('http')
          ? dlHref.replace(/&amp;/g, '&')
          : 'https://drive.google.com' + dlHref.replace(/&amp;/g, '&');

      // 5) Re-fetch the real download link
      resp = await fetch(downloadUrl, { redirect: 'follow', headers });
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
    // 1) Load the materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(`Failed to fetch materials page: ${pageResp.status}`);
    }
    const html = await pageResp.text();

    // 2) Scrape for .pdf + Drive-preview links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_i: number, el: any) => {
      const href = ($(el).attr('href') || '').trim();
      const isPdf       = /\.pdf($|\?)/i.test(href);
      const isDriveFile = /drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+/.test(href);
      if (isPdf || isDriveFile) rawLinks.push(href);
    });

    if (!rawLinks.length) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No Minutes links found.' });
    }

    // 3) Download & parse each PDF for "housing"
    let collected = '';
    for (const href of rawLinks) {
      try {
        const resp = href.includes('drive.google.com')
          ? await fetchDrivePdf(href)
          : await fetch(href, { redirect: 'follow' });

        if (!resp.ok) {
          console.warn(`Skipping ${href}: HTTP ${resp.status}`);
          continue;
        }

        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
          console.warn(`Skipping ${href}: content-type ${ct}`);
          continue;
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        const { text } = await pdfParse(buffer);

        text
          .split(/\r?\n{2,}/)
          .filter((p: string) => /housing/i.test(p))
          .forEach((p: string) => {
            collected += p.trim() + '\n\n';
          });
      } catch (err: any) {
        console.warn(`Error parsing ${href}: ${err.message}`);
      }
    }

    if (!collected.trim()) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No housing mentions found.' });
    }

    // 4) Summarize via Gemini
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

    // 5) Return the array of summaries
    return res.status(200).json({ summaries: [summary] });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
