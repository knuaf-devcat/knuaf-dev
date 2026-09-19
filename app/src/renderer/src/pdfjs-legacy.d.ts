// pdfjs-dist ships no declaration for the legacy entry point; it exposes the same API as the root build.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist'
}
