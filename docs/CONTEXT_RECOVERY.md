# Context and response recovery

Both apps share the existing Ollama service. No model files or global service settings are changed by this feature.

## Ollama Local Workspace

New conversations use automatic context management. Existing conversations expose **Upgrade context handling**; **Retry last response** regenerates the most recent question without duplicating it or deleting earlier answers.

Every request specifies context and output allowances. Responses begin with an 8,192-token allowance, including model reasoning. A confirmed length stop gets one retry at 16,384, with input resized first. Incomplete attempts remain identifiable. Empty replies, streamed errors, and missing completion markers are failures rather than successful blank messages.

The request view can use larger locally calibrated windows, cached section summaries, and original attachment passages. Originals and the transcript remain unchanged. All sections participate in whole-document summaries. Models with tools can search and read original attachment sections. Summary generation has its own bounded 2,048/4,096-token retry. Summaries can omit details; completing a response does not establish factual accuracy.

Metadata, derived summaries, request attempts, and restart state are stored additively. Startup marks interrupted work as interrupted; reconnecting restores saved progress. Images are retained, with conservative context accounting; oversized protected input fails explicitly.

## Debate Lab

New debates default to **Complete configured turns — automatic budgets**. The configured turn count remains authoritative (12 means six per party). Request reservations grow the corresponding token budget, retaining previous actual/uncertain usage. Legacy 15-minute limits apply only to fixed mode. Completion mode retains bounded attempts, auxiliary actions, search, and Judge inspection passes.

Each response gets at most two length-related generation attempts; summaries also have two bounded attempts. Each pending argument permits at most four auxiliary actions. A session-wide bounded attempt allowance covers arguments, summaries, source processing, and judgment. Individual inference attempts have a ten-minute deadline; streams have a three-minute inactivity deadline. Memory below 4 GiB causes a recoverable stop. Models are never replaced automatically.

Old debates keep their policy. **Upgrade and Resume** records previous settings and a hash of completed arguments, adopts the new policy, and resumes the pending work. Completed verdicts cannot be upgraded. Information requests, surrender, Stop & Judge, cancellation, unavailable models, and invalid structured output retain their explicit meanings; 12-turn completion is a tested target, not an unconditional guarantee.

## Calibration and validation tools

- `scripts/calibrate-context.mts`: sequential text capacity probes and model/runtime keyed profiles in an isolated database.
- `scripts/verify-cancellation.mts`: explicit mid-stream cancellation and residency checks before profile registration.
- `scripts/verify-context-live.mts`: isolated original-portfolio recovery, follow-up, and forced-summary checks.
- `scripts/verify-grounded-followup.mts`: source-grounded follow-up on the isolated conversation.

Use Node 22 (the existing native SQLite dependency was built for it). Profiles apply only to the matching model digest and runtime. The default fallback for an uncalibrated model is a conservative 16K window (or smaller advertised maximum), with byte-based input estimation. Larger tiers require calibration. Text calibration does not prove arbitrary image workloads or factual accuracy.

Live verification results and rollout status are recorded in [CONTEXT_VERIFICATION.md](CONTEXT_VERIFICATION.md).
