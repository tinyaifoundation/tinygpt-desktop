# Projects, files, attachments and outputs

Create a Project to organize related conversations, provide Project instructions and optionally select a folder. A selected folder grants scoped access for supported file tools. Relative tool paths refer to that folder, or to the conversation's managed Generated files folder when no Project folder is selected. A folder grant does not authorize every possible write or command; General tool permissions still apply.

## Give the assistant a document

Use the composer attachment controls to select files or available saved sources, then ask a specific question about them. File processing must finish before content is usable. Text/code, supported documents, PDFs and images have different extraction paths and limits. Inspect any processing error rather than assuming an unreadable file was indexed. Image interpretation depends on available image tools/model support; omitted visual details are unknown. A model's visual observation can be wrong, especially for small text.

Supported document extraction includes text-layer PDFs, Word DOCX, PowerPoint PPTX, Excel XLSX and ODT. PDF pages without readable text can use local OCR within processing limits; partial OCR failures produce a notice, and unreadable text must not be treated as successfully extracted. Spreadsheet extraction includes worksheet/cell content, and slide extraction preserves slide labels. Complex formatting, drawings and visual layout may need separate inspection. Consult the original when extraction is partial.

Image and scanned-page OCR uses the bundled local English Tesseract engine. Repeated column whitespace can produce separate reading regions with original-image coordinates and confidence estimates. Multi-column recovery uses at most four targeted regions, a bounded pixel budget, and stops starting retries after its time budget. It preserves baseline text when numeric readings conflict or a retry fails, and flags uncertainty rather than silently correcting prices or counts. Region grouping is geometric, not proof of which semantic label owns a feature. No automatic cloud or vision-model request is added by OCR.

For uncertain image OCR, read_source returns the saved image reference and guidance to use view_image with a focused question. Visual inspection depends on model/tool access and may still be wrong; unresolved values must remain uncertain. A ready processing status is not an accuracy guarantee. Existing saved OCR is retained until the file is retried or uploaded again; updating the app does not silently reprocess all attachments.

Saved sources and extracted passages support cited retrieval within the applicable conversation/Project. An attachment to one conversation is not blanket access to unrelated personal chats or other Projects. Project folder indexing is managed separately in Personalization; newly granted Project folders are indexed automatically unless an existing setting has paused or disabled indexing.

## Find generated files

Successful file writes appear as file cards and in the Library. Open the Library to inspect outputs and available previews, and use the file's available save/export controls. Do not treat an answer saying 'saved' as sufficient if no successful file action occurred. A preview is not a complete verification of a document's contents.

Work can show changes, command results and guarded Undo. Inspect changes before undoing: later modifications can prevent a safe reversal. Deleting a chat, forgetting an index and deleting an original disk file are distinct operations. Forgetting indexed evidence does not remove the original file.
