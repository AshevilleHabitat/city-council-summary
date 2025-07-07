
import React from 'react';

interface HeaderProps {
  onRefresh: () => void;
  isLoading: boolean;
}

const Header: React.FC<HeaderProps> = ({ onRefresh, isLoading }) => {
  return (
    <header className="bg-white dark:bg-gray-800 shadow-md sticky top-0 z-10">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 dark:text-white">
              Asheville City Council Housing Updates
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Your AI guide to Asheville's housing discussions.
            </p>
          </div>
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-blue-400 dark:disabled:bg-blue-800 disabled:cursor-not-allowed transition-colors"
          >
            <svg className={`w-5 h-5 mr-2 -ml-1 ${isLoading ? 'animate-spin' : ''}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5m-1.5-1.5A9 9 0 003.5 8" />
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 4v5h-5m1.5 1.5A9 9 0 014.5 16" />
            </svg>
            {isLoading ? 'Checking...' : 'Check for Updates'}
          </button>
        </div>
      </div>
    </header>
  );
};

export default Header;
