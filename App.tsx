
import React, { useState, useEffect, useCallback } from 'react';
import { MeetingSummary } from './types';
import { fetchMeetingSummaries } from './services/meetingService';
import Header from './components/Header';
import SummaryCard from './components/SummaryCard';
import LoadingSpinner from './components/LoadingSpinner';
import ErrorDisplay from './components/ErrorDisplay';

const App: React.FC = () => {
  const [summaries, setSummaries] = useState<MeetingSummary[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const processMeetings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const fetchedSummaries = await fetchMeetingSummaries();
      
      if (!fetchedSummaries || fetchedSummaries.length === 0) {
        // This case is handled by the render logic, just set empty array
        setSummaries([]);
      } else {
        // The API now returns data pre-sorted and pre-summarized
        setSummaries(fetchedSummaries);
      }

    } catch (e) {
      console.error("Failed to process meetings:", e);
      const errorMessage = e instanceof Error ? e.message : "An unknown error occurred.";
      setError(`Failed to fetch or process meeting summaries. Please try again. Details: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    processMeetings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = () => {
    setSummaries([]);
    processMeetings();
  };
  
  const renderContent = () => {
    if (isLoading && summaries.length === 0) {
      return (
        <div>
            <p className="text-center text-gray-600 dark:text-gray-400 my-4">Fetching and analyzing minutes from all recent city public meetings... this may take a moment.</p>
            <LoadingSpinner />
        </div>
      );
    }
    
    if (error) {
      return <ErrorDisplay message={error} />;
    }

    if (!isLoading && summaries.length === 0) {
      return (
        <div className="text-center py-10 px-4 bg-white dark:bg-gray-800 rounded-lg shadow-md">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No Recent Housing Summaries Found</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">No housing-related topics were found in the latest meeting minutes, or there was an issue fetching the data.</p>
        </div>
      );
    }

    return (
      <div className="grid gap-6 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
        {summaries.map((summaryData) => (
          <SummaryCard key={summaryData.date} summaryData={summaryData} />
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 font-sans">
      <Header onRefresh={handleRefresh} isLoading={isLoading} />
      <main className="container mx-auto p-4 sm:p-6 lg:p-8">
        {renderContent()}
      </main>
      <footer className="text-center py-4 px-4 text-xs text-gray-500 dark:text-gray-400">
        <p>This app fetches and analyzes live data. Summaries may take a moment to generate.</p>
        <p>In a production environment, cron jobs on Vercel would handle scheduled checks.</p>
      </footer>
    </div>
  );
};

export default App;