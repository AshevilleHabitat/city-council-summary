
import React from 'react';
import { MeetingSummary } from '../types';

interface SummaryCardProps {
  summaryData: MeetingSummary;
}

const SummaryCard: React.FC<SummaryCardProps> = ({ summaryData }) => {
  const formattedDate = new Date(summaryData.date + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="bg-white dark:bg-gray-800 shadow-lg rounded-xl overflow-hidden transform hover:scale-[1.02] transition-transform duration-300 ease-in-out">
      <div className="p-6">
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="font-bold text-xl text-gray-900 dark:text-white">{formattedDate}</h3>
          <a
            href={summaryData.originalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-blue-500 hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
            title="View original minutes PDF"
          >
            Source PDF
          </a>
        </div>
        <p className="text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
          {summaryData.summary}
        </p>
      </div>
    </div>
  );
};

export default SummaryCard;
