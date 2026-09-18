-- Undo 0027. The OCR queue goes, and with it the text read off scanned pages.
delete from drive_file_extractions where kind = 'ocr';
drop table if exists file_ocr;
