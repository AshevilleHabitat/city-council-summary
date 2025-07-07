// Vercel deploys files in the /api directory as serverless functions.
// This function will be accessible at the `/api/summarize` endpoint.

import pdf from "pdf-parse";
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import * as cheerio from 'cheerio';
import { MeetingSummary } from '../types';

// Ensure the API_KEY is available in the serverless environment
if (!process.env.API_KEY) {
  throw new Error("API_KEY environment variable is not set.");
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const councilMeetingsUrl = 'https://www.ashevillenc.gov/government/city-council-meeting-materials/';

async function getMeetingLinks(): Promise<{ date: string, url: string }[]> {
  try {
    const response = await fetch(councilMeetingsUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch meeting page: ${response.statusText}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);
    const links: { date: string, url: string }[] = [];

    // Find links within the relevant section, assuming a structure
    $('.item-link').each((_i, element) => {
      const href = $(element).attr('href');
      const text = $(element).text().trim();

      // Basic filter for links that seem to be meeting minutes
      if (href && (href.endsWith('.pdf')) && text.toLowerCase().includes('minutes')) {
        // Attempt to parse a date from the text, e.g., "07.23.24 Regular Meeting Minutes"
        const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2})/);
        if (dateMatch) {
            const [, month, day, year] = dateMatch;
            const fullYear = `20${year}`;
            const formattedDate = `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
            const fullUrl = new URL(href, councilMeetingsUrl).toString();
            links.push({ date: formattedDate, url: fullUrl });
        }
      }
    });

    // Limit to the most recent 5 for this proof-of-concept to manage execution time
    return links.slice(0, 5);
  } catch (error) {
    console.error("Error scraping meeting links:", error);
    return [];
  }
}

async function getPdfText(url: string): Promise<string> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch PDF from ${url}: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const data = await pdf(Buffer.from(arrayBuffer));
        return data.text;
    } catch(error) {
        console.error(`Error parsing PDF from ${url}:`, error);
        return ""; // Return empty string on failure
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
    
    return response.text.trim();
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    return `Error: Could not generate summary.`;
  }
}


export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  try {
    const meetingLinks = await getMeetingLinks();
    if (meetingLinks.length === 0) {
      return res.status(200).json([]);
    }

    const summaryPromises = meetingLinks.map(async (link) => {
        const minutesText = await getPdfText(link.url);
        if (!minutesText) return null;

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
