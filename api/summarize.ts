// Vercel deploys files in the /api directory as serverless functions.
// This function will be accessible at the `/api/summarize` endpoint.

import '@napi-rs/canvas'; // Explicitly import to ensure it's bundled by Vercel for pdfjs-dist
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MeetingSummary } from '../types';

// Ensure the API_KEY is available in the serverless environment
if (!process.env.API_KEY) {
  throw new Error("API_KEY environment variable is not set.");
}

// For serverless environments like Vercel, we must disable worker threads in pdfjs-dist.
GlobalWorkerOptions.disableWorker = true;

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const apiBaseUrl = 'https://asheville.civicclerk.com';

/**
 * Fetches meeting links by calling the official CivicClerk JSON API,
 * which is more robust than scraping HTML.
 */
async function getMeetingLinks(): Promise<{ date: string, url: string }[]> {
  const links: { date: string, url: string }[] = [];
  const today = new Date();
  const daysToScan = 90; // Scan the last 3 months for meetings
  const fetchPromises: Promise<void>[] = [];

  for (let i = 0; i < daysToScan; i++) {
    const dateToScan = new Date(today);
    dateToScan.setDate(today.getDate() - i);
    
    const year = dateToScan.getFullYear();
    const month = String(dateToScan.getMonth() + 1).padStart(2, '0');
    const day = String(dateToScan.getDate()).padStart(2, '0');
    const formattedDate = `${year}-${month}-${day}`;
    
    const apiUrl = `${apiBaseUrl}/web/api/Meetings?date=${formattedDate}`;
    
    const promise = fetch(apiUrl)
      .then(res => {
        if (!res.ok) {
          // This is expected for days without meetings.
          return null;
        }
        // The API returns an HTML page for dates with no meetings, which causes a JSON parse error.
        // We must check the content-type to ensure we only process JSON responses.
        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            return null; // Not JSON, so skip it.
        }
        return res.json();
      })
      .then(meetingsData => {
        if (Array.isArray(meetingsData)) {
          for (const meeting of meetingsData) {
            // Correctly filter for the specific meeting name from the API data
            if (meeting.BodyName === 'City Council Regular Meeting') {
              const minutesLink = meeting.Links.find((l: any) => l.FileTypeName === 'Minutes' && l.Url);
              if (minutesLink) {
                links.push({
                  date: formattedDate,
                  url: `${apiBaseUrl}${minutesLink.Url}`
                });
              }
            }
          }
        }
      })
      .catch(e => {
        // Log actual errors for debugging, but don't stop the whole process
        console.error(`Error fetching or processing data for ${formattedDate}:`, e);
      });
      
    fetchPromises.push(promise);
  }

  await Promise.all(fetchPromises);
  
  // Sort by date descending and take the most recent 5 for processing.
  links.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const finalLinks = links.slice(0, 5);

  return finalLinks;
}

async function getPdfText(url: string): Promise<string> {
    try {
        const response = await fetch(url, { redirect: 'follow' });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch PDF from ${url}: ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const pdfData = new Uint8Array(arrayBuffer);

        const doc = await getDocument({ data: pdfData }).promise;

        let fullText = '';
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item: any) => ('str' in item ? item.str : '')).join(' ');
            fullText += pageText + '\n';
        }
        return fullText;
        
    } catch(error) {
        console.error(`Error parsing PDF from ${url}:`, error);
        return "";
    }
}

async function summarizeHousingTopics(minutesText: string): Promise<string> {
    const prompt = `
    You are an expert assistant specialized in analyzing municipal government documents.
    Your task is to review the following text from the Asheville City Council meeting minutes and extract a concise summary of any discussions, debates, or decisions related to housing, affordable housing, homelessness, zoning for residential areas, or property development for residential purposes.

    If the minutes contain information on these topics, please provide a clear, neutral summary of 1-3 sentences.
    If the minutes do not contain any mention of these topics, your entire response must be exactly: "No housing topics found."

    Here are the minutes:
    ---
    ${minutesText.substring(0, 15000)} 
    ---
  `;

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-04-17",
      contents: prompt,
    });
    
    const summary = (response.text ?? '').trim();
    return summary;
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    return `Error: Could not generate summary.`;
  }
}


export default async function handler(
  _req: VercelRequest,
  res: VercelResponse
) {
  try {
    const meetingLinks = await getMeetingLinks();
    
    if (meetingLinks.length === 0) {
      return res.status(200).json([]);
    }

    const summaryPromises = meetingLinks.map(async (link) => {
        const minutesText = await getPdfText(link.url);
        if (!minutesText) {
          return null;
        }

        const summaryText = await summarizeHousingTopics(minutesText);
        
        if (summaryText.toLowerCase().trim() !== "no housing topics found." && !summaryText.startsWith("Error:")) {
            return {
                date: link.date,
                summary: summaryText,
                originalUrl: link.url,
            };
        }
        return null;
    });

    const results = await Promise.all(summaryPromises);
    const validSummaries = results.filter((s): s is MeetingSummary => s !== null);
    
    validSummaries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); // Cache for 1 hour
    return res.status(200).json(validSummaries);

  } catch (error) {
    console.error('Unhandled error in API route:', error);
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
    return res.status(500).json({ error: 'Failed to process meeting summaries.', details: errorMessage });
  }
}