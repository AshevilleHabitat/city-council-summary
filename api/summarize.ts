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
 * Fetches meeting links by calling the official CivicClerk JSON API.
 * This is more robust than scraping HTML.
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
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) return null;
        return res.json();
      })
      .then(meetingsData => {
        if (Array.isArray(meetingsData)) {
          for (const meeting of meetingsData) {
            const minutesLink = meeting.Links.find((l: any) => l.FileTypeName.toLowerCase().includes('minutes') && l.Url);
            if (minutesLink) {
              links.push({
                date: formattedDate,
                url: `${apiBaseUrl}${minutesLink.Url}`
              });
            }
          }
        }
      })
      .catch(e => {
        console.error(`Error fetching or processing data for ${formattedDate}:`, e);
      });
      
    fetchPromises.push(promise);
  }

  await Promise.all(fetchPromises);
  
  links.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  // No longer slicing to a limit, process all found meetings in the date range.
  return links;
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
            fullText += pageText + '\n\n'; // Add double newline for paragraph separation
        }
        return fullText;
        
    } catch(error) {
        console.error(`Error parsing PDF from ${url}:`, error);
        return "";
    }
}

/**
 * Intelligently extracts relevant excerpts from the minutes and sends only that to the AI.
 * This avoids truncation issues and provides better context to the model.
 */
async function summarizeHousingTopics(minutesText: string): Promise<string> {
  if (!minutesText || minutesText.trim().length === 0) {
    return "No housing topics found.";
  }
  
  const keywords = [
      'housing', 'affordable housing', 'homelessness', 'homeless', 'zoning', 'rezoning',
      'development', 'land use', 'gentrification', 'shelter', 'rent', 'property',
      'CDBG', 'HOME', 'apartment', 'condominium', 'multi-family', 'residential'
  ];

  const paragraphs = minutesText.split(/\n\s*\n/); // Split by one or more empty lines
  const relevantExcerpts: string[] = [];
  const MAX_EXCERPT_LENGTH = 35000; // Limit total excerpt length
  let currentLength = 0;

  for (const para of paragraphs) {
    const lowerPara = para.toLowerCase();
    if (keywords.some(keyword => lowerPara.includes(keyword))) {
      if (currentLength + para.length > MAX_EXCERPT_LENGTH) {
        break; // Stop if we're over the length budget
      }
      relevantExcerpts.push(para);
      currentLength += para.length;
    }
  }

  if (relevantExcerpts.length === 0) {
    return "No housing topics found.";
  }

  const excerptsText = relevantExcerpts.join("\n---\n");

  const prompt = `
    You are an expert assistant specialized in analyzing municipal government documents.
    Your task is to review the following excerpts from the Asheville City Council meeting minutes and extract a concise summary of any discussions, debates, or decisions related to housing.

    If the excerpts contain information on these topics, please provide a clear, neutral summary of 1-3 sentences.
    If the excerpts do not contain any mention of these topics, your entire response must be exactly: "No housing topics found."

    Here are the relevant excerpts:
    ---
    ${excerptsText}
    ---
  `;

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-04-17",
      contents: prompt,
    });
    
    const summary = (response.text ?? '').trim();
    return summary || "Could not generate summary from excerpts.";
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
          return null; // Skip if PDF text could not be extracted
        }

        const summaryText = await summarizeHousingTopics(minutesText);
        
        if (summaryText.startsWith("Error:")) {
            return null;
        }

        return {
            date: link.date,
            summary: summaryText,
            originalUrl: link.url,
        };
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
