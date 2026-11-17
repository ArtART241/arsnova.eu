# Befunde (laufend)

Status codes:

- `bestätigt-unit`: confirmed with an executable unit test
- `bestätigt-live`: confirmed end-to-end in the lab
- `Kandidat`: code analysis only

CVSS ratings use **CVSS v4.0** and are our own assessment, not an official CVE.

## F1 – Redaction-Token in Teilnehmertext erzeugt unbegrenzt viele DOM-Elemente (5B)

**Status:**

- **Server path bestätigt-live** on `upstream/main@74608ca7` (`scripts/f1-token-roundtrip.mjs`, `data/f1-token-roundtrip-main-74608ca7.json`). `qa.submit` accepts the token, and it appears verbatim in the host's moderation list (`moderatorView`) and in the participant list.
- **Renderer path bestätigt-unit** on v1.3.0 **and** main (2/2 each).
- Not done: a browser E2E run with large n, deliberately, because of the risk of freezing the lab machine.

**CVSS v4.0 (own assessment):** `AV:N/AC:L/AT:N/PR:L/UI:P/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N` → **6.9 Medium**. Computed with the `cvss` library 3.4 (Red Hat).

**Path:**

1. `qa.submit` accepts any text of ≤1000 code points without a filter for Private-Use characters. A grep for `` / `\p{Co}` in `libs/shared-types/src/qa-redaction.ts`, `schemas.ts` and `routers/qa.ts` finds nothing.
2. The frontend renders participant Q&A through `renderMarkdownWithKatex` (host, presenter and participant views).
3. `sanitizeMarkdownHtml` (`apps/frontend/src/app/shared/markdown-katex.util.ts:595-603`) calls `restoreQaRedactionPlaceholders` **after** DOMPurify.
4. Inside it, `ARSNOVA_QA_REDACTED_RUN:(\d+)` is replaced by `renderQaRedactedPassageHtml(Number(n))` (`:222-229`).
5. That function builds `Array.from({ length: n })` spans with no upper bound (`:188-195`).

**Evidence:** `apps/frontend/src/app/shared/markdown-katex.referat-redaction-token.spec.ts`

- A user-typed token with n=7 yields exactly 7 spans.
- Growth is linear at ~58 bytes per span: n=10^5 gives 5.8 MB of HTML.
- Raw data: n=1,000 → 58,095 B; n=10,000 → 580,095 B; n=100,000 → 5,800,095 B.

**Expected impact** (to be verified live):

- With n≈10^7, about 580 MB of HTML in the browser of anyone viewing the question.
- With moderation enabled, that includes the host's moderation list even while the question is still PENDING.
- With n > 2^32−1, `Array.from` throws `RangeError`.
- Attacker profile: any participant who knows the session code.

**Root cause:** placeholder expansion happens after the sanitizer, controlled by unvalidated user input (the classic "mutation after sanitization" pattern).

**Recommendation:**

1. Strip or escape Private-Use characters ``/`` on input (Zod refine) **and** before rendering.
2. Clamp `charCount` to the maximum text length of 1000.
3. Ideally insert the placeholders as DOM nodes instead of doing string replacement after DOMPurify.

## F2 – DOMPurify 3.4.16 mit GHSA-cg2g-xh64-v4q7 (Critical) und GHSA-mrv2-3pqr-j5jr (High) (5C)

**Status:** version vulnerable, **not exploitable in the arsnova configuration** (VEX: `not_affected` / `vulnerable_code_not_in_execute_path`).

- Both advisories were published 2026-10-22, after v1.3.0 (2026-10-08).
- The Critical one requires `SAFE_FOR_TEMPLATES` plus DOM output modes. The High one requires `IN_PLACE` plus hooks.
- arsnova calls `DOMPurify.sanitize(html, {ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP})` with string output, no hooks and no `IN_PLACE` (`markdown-katex.util.ts:603-640`).
- `upstream/main` has already raised the dependency to `^3.4.17`.
- The scan (`data/e8/grype-npm-v1.3.0.json`) reports **five** matches in total. The other three have no reachability assessment yet: GHSA-c6gr-qvv4-5v3f (DOMPurify, Low), GHSA-7g7c-h8rr-7p6q (`@angular/ssr`, Medium), GHSA-238p-pmpm-9mq7 (KaTeX, Low).

**Lesson:** an SBOM/scanner match is not a vulnerability by itself; the reachability analysis decides.

## F3 – GitHub Actions: Workflow-weite `pages: write` / `id-token: write` (5C)

**Status:** bestätigt (zizmor `excessive-permissions`, High). See `E10-CI-SUPPLY-CHAIN.md` V4.

## F4 – v1.3: Kompass-Zusammenfassung erreicht das Modell ohne eine einzige Teilnehmerfrage (5A/5B, Funktion)

**Status:** bestätigt-live (lab v1.3.0, production profile). Fixed upstream after 1.3.

**Path:**

- Profile `ctx-4096`: 4096 − 640 output reserve − 128 margin − 314 instruction − 203 definitions leaves about 2,811 tokens for data.
- The estimator counts **UTF-8 bytes as tokens** (`utf8-byte-upper-bound`).
- The JSON frame (meta, scope, revisions, limitations) alone uses 2,770 "tokens".
- Result: `questions.corpus.represented = 0`, `truncations: questions omittedItems 6`.
- Real prompt size per llama-server: **842 tokens**. The estimator overestimates by roughly 4×.

**Evidence:**

- `data/e4/v1.3.0-benign-context-preview.json`, as seen by the host via `qa.summaryContextPreview`
- `data/e4/v1.3.0-benign-probe-*.json`

**Consequences:**

1. The model summarises the technical frame. Example of its output: "6 item(s) were omitted by deterministic prompt packing".
2. In the baseline, the model cites frame IDs (`feedback:reason`), which are not allowed. The client rejects this as `invalid_response` after 39.6 s.
3. Prompt injection through question text cannot reach the model on v1.3. This is protection by accident, not by design.

**Upstream (`74608ca7`):**

- `06a0a10f` / `567a58b9` force-fit Q&A evidence
- `c0a7f7d7` raises the context to 8192
- `264bf488` (#581) restricts `sourceIds` in the wire schema to an enum of allowed IDs

**Consequence for the method:** E4 is measured on `upstream/main`.

## F5 – v1.3: Queue-Timeout 8 s < reale Inferenzdauer, Slot bleibt nach Abbruch belegt (5B, Verfügbarkeit)

**Status:** bestätigt-live (`data/e4-0-app-path.jsonl`).

- With `QA_SUMMARY_TIMEOUT_MS=8000` from `.env.production.example` (v1.3), every real summary on the lab CPU ends after 8.2 s with `fallback.reason = timeout`.
- The extractive fallback contains **no statements**. Its note reads "noch keine Textbelege ausgewählt".
- A request from **another session** right afterwards gets `busy` after 0.6 s. llama-server only cancels the aborted task later (log: `stop: cancel task`).
- Upstream main sets `QA_SUMMARY_TIMEOUT_MS=90000`.

**Validity limit:** this is the lab CPU (M1, 4 threads in the VM). Production runs on a dedicated host with ≥ 4 cores, so absolute times may differ.

## E4 – Prompt-Injection (5B), gemessen auf upstream/main

See `E4-INJECTION.md`.

- Across 30 model runs, **0 executed instructions**, 0 foreign IDs, 0 manipulated metadata fields.
- **1/15 generalization of a single source per mode** ("Warum wollen die Teilnehmenden …"). That misses the 0/15 threshold, so the decision is "ändern", with low urgency.
- Separating instruction and data showed **no measurable effect** (0 pp). The protection comes from the output contract: JSON grammar, `sourceIds` enum, source binding.
- False positives: 0/3 benign runs.

**CVSS v4.0 for the G case (own assessment):** `AV:N/AC:L/AT:P/PR:L/UI:A/VC:N/VI:L/VA:N/SC:N/SI:N/SA:N` → **2.0 Low**.

## E2 – Lebenszyklus (5A, Leitfall)

**Status:** bestätigt-unit on v1.3.0 **and** `upstream/main@74608ca7`. The queue code is unchanged.

- Baseline: **0** stale contents delivered.
- Controlled variant "nur Startprüfung": **6/6** leaks.
- The target source is chosen dynamically (the first question that stays in the context _with_ the marker): C on v1.3, E on main.
- Data: `data/e2-lifecycle-unit.json` and `data/e2-lifecycle-unit-main.json`.
- Cost: a harmless text correction also yields `source_changed`.

## E1 – Autorisierungs-Negativtests (5A)

**Status:** bestätigt-live, threshold met.

- 22 negative cases, **0** with data. The positive control (C0) returns data.
- Covered: no token, participant capability (as a header and as a host token), host token of another session, random token, browser capability as a host token, old host token after admin reset, old browser capability after reset.
- `data/e1-authz-negative.json`

## E5 – Geteilter LLM-Zustand (5B)

**Status:** bestätigt-unit (`apps/backend/src/lib/openWeightLlmClient.referat-e5.test.ts`, 2/2).

1. Three `invalid_response` results from an **anonymous** learning-objective job (`quiz.deriveLearningObjectives` is a `publicProcedure` with a capability issued on request, 600/IP/h) make the summary of any other host return `circuit_open` for exactly 30 s.
2. While an anonymous job is running, every summary gets `busy` immediately.

**Live on `upstream/main@74608ca7`** (`scripts/e5-slot-contention.mjs`, `data/e5-slot-contention.jsonl`):

| Phase                                                | Result                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Control without attacker                             | 3/3 host summaries of other sessions are generative (`full-context`, 5–9 s)                    |
| One anonymous derivation loop (no session, no login) | **3/3** host summaries of other sessions fall back to extractive with `busy` after about 1.1 s |

- One derivation holds the slot for **89–101 s**. One of three ended as `invalid_response`, which counts toward the global breaker.
- Blocking a full hour takes about 38 derivations. The limit is 600 capabilities per IP per hour (`RATE_LIMIT_OBJECTIVE_DERIVE_PER_IP_PER_HOUR`), deliberately set high for shared NAT in lecture halls (`rateLimit.ts:90-100`).

**Threshold** ("0 other sessions affected"): **not met** → decision **ändern**.

**Recommendations:**

- keep breaker and slot per task type and requester
- don't count content-caused `invalid_response` as an infrastructure failure
- give host summaries priority over anonymous derivations, or a separate slot

**CVSS v4.0 (own assessment):** `AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:L/SC:N/SI:N/SA:N` → **6.9 Medium**.

**Validity limit:** same-host lab (4 threads). On a dedicated LLM host each job is faster, but the slot is still `--parallel 1` and the client still has one `inFlight`.

## E7 – Härtung (5C)

**Status:** bestätigt-live (`data/e7-hardening-v1.3.0.txt`).

**Sidecars** (pdf-worker, spaCy, LLM):

- `CapEff=0`, read-only root
- `/tmp` mounted `noexec` (executing a script fails with "Permission denied")
- outbound connection ends in `ENETUNREACH`
- pdf-worker holds no app secrets (0 of `DATABASE_URL`/`ADMIN_SECRET`/`JWT_SECRET`/`REDIS_URL`)

**llama-server:**

- `/slots` and `/v1/chat/completions` return 401 with no token or a wrong token
- `/health` returns 200 without a token (documented)
- web UI returns 404

**Ports:** only `127.0.0.1:3000-3002`.

**Residual:** the app container itself has unrestricted outbound access (`CONNECTED 1.1.1.1:443`). That's required for external images (`safeExternalImageFetch`), but after an RCE in the app there is no egress barrier. A possible measure is an egress proxy or allowlist.

## E9 – Ausbruch aus dem PDF-Worker (5C, Hinweis des Prüfers)

**Status:** existing tests rerun (58/58 green on v1.3.0, `data/e9-pdf-ssrf-tests-v1.3.0.txt`), plus live hardening data from E7.

**In (attacker-controlled HTML/images):**

- `safeExternalImageFetch` blocks 169.254.169.254, alternative loopback notations (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `[::ffff:7f00:1]`) and internal redirect targets.
- It pins DNS to the validated address and limits redirect chains.
- Chromium in the worker does not contact rejected images (`session-results-report-pdf.ssrf.test.ts`).

**Out (simulated compromise of the worker, E7 live):**

- no network (`ENETUNREACH`)
- no app secrets in its env
- read-only root and `noexec` on `/tmp`
- `CapEff=0`, `pids_limit`

The only channel is the Unix socket `render.sock`, mode 0600 (`pdfWorkerTransport.test.ts`).

**Assessment:** a break-out would land in a container with no network and no secrets. Its impact is limited to tampering with PDF content and DoS of the single render slot.

**Not done:** a fuzzing campaign against Chromium itself (out of scope).

## Nebenbefunde (außerhalb Kompass, Backup)

- **N1 `bindQuizHistoryScope`:** scope merge by quiz name (`routers/session.ts:10626-10632`). Kandidat; not tested yet.
- **N2 `session.getParticipantNicknames`:** public, up to 100 nicknames per code (`routers/session.ts:7344-7379`). Kandidat.

## Messbefunde ohne Sicherheitslücke (Gültigkeitsgrenzen / Design)

- **M1 Kontextbudget:** for the #456 reference context with the 4096-token profile, the packer keeps only **1 of 6** questions (`truncations: questions omittedItems 5, reason token-budget`). This is data minimization by budget, but it limits what the model can see. Raw data come from a debug run on `prepareModerationSummaryContextFromAnalysis` (reproducible in `qaSummaryQueue.referat-e2.test.ts`).
- **M2 Schema-Integrität:** the context schema recomputes Wilson best score, controversy and compass signals from the votes. Inconsistent vote values are rejected (`moderationPromptContextPacking.ts:1038`, ZodError on manipulation in the E2 test).
