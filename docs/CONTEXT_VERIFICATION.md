# Context recovery verification — 22 September 2026

## Diagnosis

The interrupted UI conversation reached the runtime's 32,768-token context: recorded input/output counts were 32,291/477 and then 32,570/198. A 171,863-character attachment was repeatedly included without reserving answer space. Debate Lab's per-request settings did not establish a global context limit in Ollama. Models still have finite context and memory requirements; this update manages those limits rather than pretending to remove them.

## Implemented and active

Ollama UI uses automatic request sizing, response reserves, complete-document summary coverage, cached summaries, original-passage retrieval, bounded length retries, visible progress, recoverable failures and explicit upgrades for old conversations. Debate Lab gives priority to completing the configured turns, automatically adjusts token budgets, allows more time and retains bounded request/action/memory safeguards. Existing saved work retains its policy until explicitly upgraded.

The UI controller was restarted successfully, and Debate Lab was started on its normal port 8787. Both health endpoints returned HTTP 200; Debate Lab defaults confirmed automatic completion policy, 12 turns and the existing role assignments. Verified production data after restart: all 10 conversations, 74 messages and 7 attachment records matched the pre-rollout backup. Four model/runtime-specific profiles were registered in both apps. No model files or global Ollama settings were changed.

## Automated and browser checks

- Ollama UI: 30 tests passed; complete production build passed.
- Debate Lab: 55 tests passed; frontend production build passed. Tests include a 12-turn run, one bounded length retry, failure after retry exhaustion, legacy upgrade/resume preservation and bounded auxiliary actions.
- Browser checks: upgrade persisted after reload, original question remained, retry control was available, no JavaScript errors, and a 390px mobile viewport had no horizontal overflow. Final production browser checks confirmed the existing affected conversation exposes Upgrade and Retry, and a new Debate Lab draft defaults to completion mode; no saved work was submitted or modified.

## Live UI checks

Performed on an isolated copy of the affected conversation; the original stored messages were unchanged.

| Check | Result | Time |
|---|---|---:|
| Recover the affected long-attachment request | Complete answer | 64 s |
| Follow-up question | Complete answer | 69 s |
| Force 32K context to exercise summary and passage retrieval | Complete answer; all 29 source sections covered | 751 s |
| Source-grounded follow-up | Complete; preserved uncertainty about competition and buyer demand | Recorded in local artifact |

The first large-document summary took about 12.5 minutes. Progress is displayed and successful summaries are cached. Summaries can lose detail; tools can inspect original passages. Successful generation is not proof of factual accuracy: an early test answer introduced unsupported claims, so grounding instructions were tightened and a subsequent follow-up correctly retained the source's uncertainties.

## Model capacity and cancellation probes

These are sample-based local probes, not guarantees for every prompt or concurrent workload.

| Model | Largest passing configured window | Larger tier rejected by memory safeguard |
|---|---:|---:|
| gpt-oss:20b | 131,072 | None tested above model limit |
| qwen3:30b-a3b-thinking-2507-q4_K_M | 65,536 | 131,072 |
| qwen3:30b-a3b-instruct-2507-q4_K_M | 65,536 | 131,072 |
| gemma4:31b-mlx | 32,768 | 65,536 |

All four passed midstream cancellation and model-residency clearance checks. Uncalibrated models use a conservative 16K fallback (or smaller advertised limit). Calibration is invalidated by a model digest or runtime identity change. Text probes do not validate arbitrary image workloads.

## Live Debate Lab checks

| Scenario | Result | Time |
|---|---|---:|
| No source, configured models | 12 turns (6 per side) and saved judgment | 456 s |
| Copy of the original failed seven-turn session | Upgraded and resumed to 12 turns plus judgment; all seven original arguments unchanged | 294 s |
| Evidence-backed debate | First attempt stopped safely below 4 GiB memory headroom during source processing; checkpoint resume completed 12 turns (6 per side) and judgment | 423 s on resume |

Both production saved sessions matched the pre-rollout database backup exactly. The actual saved user session was not altered by the isolated recovery test. The evidence-backed resume retained the same models and safeguards; measured minimum available memory during its sampled checks was 4.82 GiB. Test preview servers were closed before that retry. These results do not establish guaranteed completion under all memory conditions.

## Recovery controls

- Existing Ollama UI conversation: **Upgrade context handling**, then **Retry last response**.
- Existing failed Debate Lab session: **Upgrade and Resume**.
- New conversations and debates use the automatic policy by default. Twelve debate turns means six arguments per party, followed by judgment.

Saved messages and completed arguments are preserved. A bounded retry may still fail because of memory pressure, timeout, invalid model output or unavailable service. Concurrent inference from another app can still compete for the same Ollama service; the validation runs were sequential.

## Evidence and backups

Detailed local results and verification scripts are in `.verification/context-policy/` (excluded from Git because they may contain private source or conversation content).

Database backups:

- `~/Library/Application Support/Ollama Local Workspace/before-context-policy-20260922-221846.sqlite`
- `/Users/suvojitdutta/Documents/Rest/apps/apps/debate-lab/debate_lab/.data/before-context-policy-20260922-221846.sqlite`

Debate Lab source backups are in that project's `.data/code-backups/`. Deployment does not automatically upgrade or rerun saved user sessions.
