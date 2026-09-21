# Add reliable image delivery and verify Gemma’s reading accuracy

## Summary

Enable JPG/JPEG and PNG attachments for models that advertise vision capability. Keep images available for follow-up questions and after reopening conversations. Block sending when relevant images are attached to a model without vision support.

The confirmed app defect is that image pixels never reach Gemma. Correcting this does not guarantee accurate interpretation; direct and app-based tests must establish that separately.

## Implementation

- **Model capabilities:** Add `supportsVision` to shared model metadata and show it in the model selector. Use advertised capabilities from model discovery, falling back to `/api/show` when discovery omits them. Treat unknown vision capability as unavailable, with a clear explanation.
- **Image transport:** Extend the controller’s Ollama message type with `images?: string[]`. Read stored attachments server-side and supply base64-encoded bytes through that field, following [Ollama’s vision API](https://docs.ollama.com/capabilities/vision). Never store base64 payloads in conversation messages or diagnostics.
- **Conversation continuity:** Include conversation-scoped images once on the current user message in each request. Reconstruct message-scoped images on their original user messages when assembling history. Preserve these associations across reloads and tool-loop iterations, without duplicating image payloads.
- **Attachment lifecycle:** Support both sidebar Add and composer “+”. Await pending uploads before sending. Ensure removing a pending attachment also removes its database association. Prevent pending attachments from carrying into another conversation. Reuse existing attachment files and database relationships; no destructive migration.
- **Validation and failure handling:** Validate JPG/PNG content, retain the existing 10 MB per-image limit, and preserve original resolution. Reject corrupt or unsupported image inputs explicitly. If a relevant stored image is missing or unreadable, stop the turn with a useful error rather than silently proceeding without it.
- **Model restrictions:** Enforce the vision requirement in both frontend and backend, including Enter-key submission and model switching. Keep images attached when switching models; explain why sending is blocked until a vision-capable model is selected or the images are removed.
- **Grounded responses:** Replace the unconditional “cannot see images” text with capability-aware attachment instructions. Tell vision models to describe visible evidence, mark unclear document fields as unreadable or uncertain, and avoid inventing missing values. These instructions reduce risk but are not an accuracy guarantee.
- **Visible confirmation:** Show image thumbnails and filenames for conversation and message attachments, including after reopening. Display “Vision supported” based on capability metadata; never imply that this certifies the model’s interpretation.

## Verification

- Add automated tests for capability detection, image serialization, attachment ownership, deduplication, follow-up history, reloads, pending removal, unsupported models, corrupt files, and missing stored files.
- Confirm existing text/PDF/DOCX attachment behavior and text-only chats still work. Run the full build and tests using Node 22, compatible with the installed SQLite module.
- Test the supplied license directly against local `gemma4:31b-mlx`, bypassing the app, then through each attachment control in fresh conversations. The supplied clipboard image is PNG; also test a JPEG fixture.
- Compare responses against visible license fields, including jurisdiction, address, number, dates, and class. Repeat the test and include a follow-up after reopening the conversation. Keep personal image data and extracted values out of committed fixtures and logs.
- If direct Gemma results remain inaccurate or reject image input, report that separately as a model/runtime problem. Do not declare the issue resolved merely because the app sends an `images` field.

## Defaults and Boundaries

- Image processing and inference remain local.
- Existing incorrectly answered conversations are preserved; verification starts fresh to avoid reusing their fabricated claims.
- No OCR engine, automatic image conversion, workspace-image tools, model replacement, or general context-compaction work is included.
- Completion requires verified image delivery and an honest report of observed reading accuracy and remaining limitations.

## Implementation and Verification — 2026-09-21

- Implemented vision capability discovery, base64 image delivery, persistent message-image history, previews, frontend/backend blocking for non-vision models, and grounded image instructions.
- Added a backward-compatible `attachments.pending` column to distinguish unsent message files from conversation context. Removing pending files removes their database association; historical image attachments can also be removed through the UI.
- Image validation uses Sharp to decode JPG/PNG before inference, preserving the original bytes and resolution. Limits are 10,000,000 bytes per image and 40 megapixels; unsupported formats, corrupt files, and missing stored files produce explicit errors.
- Full build passed under Node 22.23.2. All 16 controller regression tests passed, including PDF/DOCX regression checks and image-error payload redaction. Run with Node 22: `npm run build` and `npm test`.
- Two direct requests to local `gemma4:31b-mlx` correctly read the supplied license's jurisdiction, number, birth date, expiry, address, and class. Neither reproduced the reported unrelated jurisdiction/address claims.
- Browser tests against an isolated local controller passed for both attachment controls, reopening conversations and asking follow-up questions, model switching, removal of historical/pending images, corrupt/oversized upload rejection, draft preservation, and isolation between conversations. Six live model turns across the browser checks completed; no browser JavaScript errors were observed. Title generation was stubbed in the browser harness; image interpretation used the actual local model.
- The supplied clipboard PNG is 16,176,627 bytes at 4032 × 3024, so the app correctly rejects it under the existing 10 MB limit. License browser tests used a temporary JPEG copy at the same resolution and quality 98; separate synthetic JPEG and PNG images verified both formats. No automatic conversion was added to the app, and the original supplied image was unchanged.
- Temporary browser-test databases and uploaded copies were removed after testing. Personal image bytes and extracted license fields were not added to the repository or test logs.
- Restarted the normal controller on port 4173 using Node 22 and verified the live bootstrap reports Ollama ready and confirmed vision support for `gemma4:31b-mlx`.
- These checks establish correct delivery and accuracy on the tested examples, not a general guarantee of visual/OCR accuracy. Start a fresh conversation when retesting the previously misread license to avoid carrying its fabricated answers into context.
