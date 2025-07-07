// This provides a basic module declaration for pdfjs-dist to satisfy TypeScript
// when using the legacy build, which is suitable for Node.js environments.
declare module 'pdfjs-dist/legacy/build/pdf.mjs';
declare module 'pdf-parse';
declare module 'cheerio';
// 3. Shape of your environment
declare namespace NodeJS {
  interface ProcessEnv {
    /** Your Google Gemini API key */
    GEMINI_API_KEY: string;