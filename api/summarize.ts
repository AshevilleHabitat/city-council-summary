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
 * Fetches a Google Drive PDF by:
 *  1. Hitting the uc?export=download endpoint
 *  2. If it returns HTML, scraping out the #uc-download-link href
 *     (the “download anyway” link), then re-fetching that.
 */
async function fetchDrivePdf(url: string): Promise<FetchResponse> {
  // 1) Extract fileId
  const idMatch =
    url.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
    url.match(/[?&]id=([A-Za-z0-9_-]+)/);
  const fileId = idMatch?.[1];
  if (!fileId) {
    return fetch(url);
  }

  const baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let resp = await fetch(baseUrl, { redirect: 'follow' });
  let ct = (resp.headers.get('content-type') || '').toLowerCase();

  // 2) If we got HTML instead of a PDF, parse out the real download link
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    const html = await resp.text();
    const $ = cheerio.load(html);

    // Try the “download anyway” link
    const dlPath = $('a#uc-download-link').attr('href');
    if (dlPath) {
      // href is something like "/uc?export=download&confirm=XYZ&id=FILEID"
      const downloadUrl = 'https://drive.google.com' + dlPath.replace(/&amp;/g, '&');
      resp = await fetch(downloadUrl, { redirect: 'follow' });
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
    if (!pageResp.ok) throw new Error(`Fetch failed: ${pageResp.status}`);
    const html = await pageResp.text();

    // 2) Scrape only .pdf & Drive file-preview links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_i: number, el: any) => {
      const href = ($(el).attr('href') || '').trim();
      const isPdf = /\.pdf($|\?)/i.test(href);
      const isDriveFile =
        /drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+/.test(href);
      if (isPdf || isDriveFile) rawLinks.push(href);
    });

    if (!rawLinks.length) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No Minutes links found.' });
    }

    // 3) Download & parse each PDF for “housing”
    let collected = '';
    for (const link of rawLinks) {
      try {
        const resp = link.includes('drive.google.com')
          ? await fetchDrivePdf(link)
          : await fetch(link);

        if (!resp.ok) {
          console.warn(`Skipping ${link}: HTTP ${resp.status}`);
          continue;
        }
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
          console.warn(`Skipping ${link}: content-type ${ct}`);
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
        console.warn(`Error parsing ${link}: ${err.message}`);
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

    // 5) Return an array of summaries
    return res.status(200).json({ summaries: [summary] });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
