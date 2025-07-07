
import { MeetingSummary } from '../types';

/**
 * Fetches pre-processed meeting summaries from our backend API.
 * The backend handles scraping, PDF parsing, and summarization.
 */
export const fetchMeetingSummaries = async (): Promise<MeetingSummary[]> => {
  console.log('Fetching meeting summaries from backend API...');
  
  try {
    const response = await fetch('/api/summarize');

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({ details: 'Could not parse error response.' }));
      throw new Error(`API returned status ${response.status}: ${errorBody.details || response.statusText}`);
    }

    const summaries: MeetingSummary[] = await response.json();
    return summaries;

  } catch (error) {
    console.error("Error fetching summaries from API:", error);
    // Re-throw the error to be handled by the calling component
    throw error;
  }
};
