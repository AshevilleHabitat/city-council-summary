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
 * Fetches a Google Drive PDF, following redirects & confirm‐tokens,
 * and even scraping the “download” link out of the HTML if needed.
 */
async function fetchDrivePdf(url: string): Promise<FetchResponse> {
  // 1) Extract the file ID from /d/<id>/ or ?id=<id>
  const idMatch =
    url.match(/\/d\/([A-Za-z0-9_-]+)\//) ||
    url.match(/[?&]id=([A-Za-z0-9_-]+)/);
  const fileId = idMatch?.[1];
  if (!fileId) {
    // Not a Drive link we understand → fetch normally
    return fetch(url);
  }

  const base = 'https://drive.google.com/uc?export=download';
  let pdfUrl = `${base}&id=${fileId}`;
  
  // 2) First attempt: straightforward download (auto‐follows redirects)
  let resp = await fetch(pdfUrl, { redirect: 'follow' });
  let ct = (resp.headers.get('content-type') || '').toLowerCase();

  // 3) If we didn't get a PDF, the body is HTML (either confirm page or preview)
  if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
    const html = await resp.text();

    // 3a) Look for a confirm token in the HTML
    const tokenMatch = html.match(/confirm=([0-9A-Za-z_]+)&amp;id=/) 
                    || html.match(/confirm=([0-9A-Za-z_]+)&id=/);
    if (tokenMatch) {
      // Rebuild the download URL with the confirm token
      pdfUrl = `${base}&confirm=${tokenMatch[1]}&id=${fileId}`;
      resp = await fetch(pdfUrl, { redirect: 'follow' });
      ct = (resp.headers.get('content-type') || '').toLowerCase();
    }

    // 3b) If we still don’t have a PDF, scrape for the actual download link
    if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
      // Find something like: href="/uc?export=download&amp;confirm=XYZ&id=FILEID"
      const linkMatch = html.match(/href="(\/uc\?export=download(&amp;|&)[^"]+)"/);
      if (linkMatch) {
        // Unescape &amp; → &
        const downloadPath = linkMatch[1].replace(/&amp;/g, '&');
        resp = await fetch(`https://drive.google.com${downloadPath}`, { redirect: 'follow' });
      }
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
    // 1) Fetch the materials page
    const pageResp = await fetch(MATERIALS_URL);
    if (!pageResp.ok) {
      throw new Error(`Failed to fetch materials page: ${pageResp.status}`);
    }
    const html = await pageResp.text();

    // 2) Scrape PDF & Drive-preview links
    const $ = cheerio.load(html);
    const rawLinks: string[] = [];
    $('a[href]').each((_i: number, el: any) => {
      const href = ($(el).attr('href') || '').trim();
      const isPdf = /\.pdf($|\?)/i.test(href);
      const isDriveFile =
        /drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+/.test(href) ||
        (/drive\.google\.com\/.*[?&]id=[A-Za-z0-9_-]+/.test(href) &&
         !/\/folders\//.test(href));
      if (isPdf || isDriveFile) {
        rawLinks.push(href);
      }
    });

    if (!rawLinks.length) {
      return res
        .status(200)
        .json({ summaries: [], message: 'No Minutes links found.' });
    }

    // 3) Download & parse PDFs, extract "housing"
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

        const contentType = (resp.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
          console.warn(`Skipping ${link}: content-type ${contentType}`);
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

    // 5) Return summaries array
    return res.status(200).json({ summaries: [summary] });
  } catch (err: any) {
    console.error('🚨 handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
