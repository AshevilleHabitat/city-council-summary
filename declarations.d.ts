declare module 'pdfreader' {
  export class PdfReader {
    constructor(options?: any);
    parseBuffer(
      buffer: Buffer,
      callback: (err: any, item: { text?: string } | null) => void
    ): void;
  }
}
