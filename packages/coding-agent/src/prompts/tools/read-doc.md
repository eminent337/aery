Reads ANY file type as plain text — on-device, no vision model needed.

<instruction>
- Use for images, scanned PDFs, photos of documents, and office files when you
  need their CONTENT, not a metadata note.
- `path` is the file to read (images: png/jpg/tiff/bmp/pnm; pdf: text or scanned;
  docx/xlsx/pptx/rtf/epub; plain text).
- For PDFs, optionally pass `pages` (e.g. "3" or "3-7") to limit work on big files.
- `lang` overrides OCR language ("eng", "afr", ...).
- Prefer this over `read` for images and scanned documents: `read` on an image
  returns an image block a visionless model cannot see, and scanned PDFs come
  back empty from text converters.
- For photos/non-text images (no readable text) a vision model (`inspect_image`)
  is still required — read_doc returns an actionable error then.
</instruction>

<examples>
# Scanned PDF (no text layer)
`{"path":"contracts/lease.pdf"}` → read_doc [pdf-scan-ocr]: 4210 chars …

# Specific pages of a big PDF
`{"path":"report.pdf","pages":"3-7"}`

# Screenshot with text
`{"path":"screenshots/error.png"}` → read_doc [ocr]: the error text
</examples>

<output>
- One text block: `read_doc [<mode>]: <N> chars` header + extracted text.
- Modes: `ocr` (image), `pdftotext` (native text layer), `pdf-scan-ocr`
  (rasterized + OCR, per-page markers), `markit` (office docs), `text`.
</output>

<critical>
- Text is capped at 8000 chars per call (truncation noted in the header).
- Scanned-PDF OCR caps at 20 pages per call — use `pages` for bigger docs.
- Requires on-device tesseract (and poppler for PDFs); errors are actionable.
</critical>
