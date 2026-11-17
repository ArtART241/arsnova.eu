# Referenzmanifest – Laborinstanz Thema 5

## Release-Anker

| Item             | Value                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline         | Tag `v1.3.0` = commit `87c39334619fbcb0c5782b061da1ba0df0ba3142` (tag date 2026-10-08; release docs `docs/features/moderation-compass-onboarding-1.3.md`) |
| Delta comparison | `upstream/main` = `74608ca725d1c1d5d3dae810b3e8265611b0c21e` (2026-11-15); `v1.4.0` = `babc3a97`                                                          |
| Evidence branch  | `referat/security-evidence` (based on `v1.3.0`; adds only tests, scripts and data under `referat/`)                                                       |

## Artefakte

| Artifact                        | Reference                                                                                                          | Integrity                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| App + PDF worker image (v1.3.0) | `ghcr.io/kqc-real/arsnova.eu@sha256:feccedfb…` (CI build of commit `87c39334`)                                     | digest-pinned in `lab/.env`                                                                                                            |
| App + PDF worker image (main)   | `ghcr.io/kqc-real/arsnova.eu@sha256:4ae931e1…` (CI build of commit `74608ca7`)                                     | digest-pinned in `lab-main/.env`                                                                                                       |
| Lab LLM / spaCy (main)          | `arsnova-open-weight-llm:main-74608ca7`, `arsnova-spacy:main-74608ca7`, built locally from `docker/*` @ `74608ca7` | image IDs in `data/lab-image-digests.txt`                                                                                              |
| llama.cpp runtime               | `ghcr.io/ggml-org/llama.cpp:server-b10524@sha256:57e505f6…` (`docker/open-weight-llm/Dockerfile:2`)                | digest-pinned in the Dockerfile                                                                                                        |
| Lab LLM image                   | `arsnova-open-weight-llm:llama-b10524`, built locally from `docker/open-weight-llm` @ v1.3.0                       | like production: local build, no registry digest (same-host lab profile)                                                               |
| GGUF                            | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, 2,497,281,120 B, HF revision `a06e946b…`                                     | SHA-256 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` (matches `model-manifest.json`; `data/e6/verify-model.log`) |
| spaCy sidecar                   | `arsnova-spacy:3.8.15`, built locally from `docker/spacy` @ v1.3.0                                                 | base image digest-pinned; pip without hashes                                                                                           |
| Postgres / Redis                | `postgres:16-alpine`, `redis:7.4-alpine`                                                                           | **tags only** (as in production)                                                                                                       |

## Laborhardware

| Item | Value                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Host | Apple M1, 8 cores, 16 GB RAM, macOS (Darwin 27)                                                                                             |
| VM   | Podman 5.8.1, machine `arsnova-lab` (provider `applehv`, Fedora CoreOS), 6 vCPU, 11 GiB RAM, 60 GB disk, rootless, cgroup v2, `linux/arm64` |
| Note | the existing `libkrun` machine could not access host files ("virtiofs connection refused") and was left unchanged                           |

**Production reference** (ADR-0035, capacity estimate):

- app host Hetzner CAX31-class arm64, 8 vCPU / 16 GB
- LLM canonically on a second private host (≥ 4 cores / 12 GiB)

## Konfiguration (Abweichungen von `.env.production.example` fett)

- **Compose:** `docker-compose.prod.yml` from v1.3.0, unchanged. Profiles `nlp` and `llm` (same-host lab, 5 GiB / 4 CPU, `network_mode: none`, Unix socket). Run via Docker Compose v5.6.0 against the Podman Docker API.
- **Secrets:** freshly generated with `openssl rand`; stored only in `lab/.env.production` (chmod 600, outside the repo).
- **Flags:** **`OPEN_WEIGHT_LLM_ENABLED=true`**, **`QA_SUMMARY_ENABLED=true`**, **`QA_NLP_ENABLED=true`**, **`NLP_ENABLED=true`** (production default: all `false`). **`OPEN_WEIGHT_LLM_SOCKET_PATH=/run/open-weight-llm/llm.sock`**.
- **Access:** **`PUBLIC_FRONTEND_URL=http://localhost:3000`**, **`TRUST_PROXY_HOPS=0`** (no nginx in front).
- **Unchanged timeouts:**
  - `QA_SUMMARY_TIMEOUT_MS=8000` (queue wall clock)
  - `OPEN_WEIGHT_LLM_SUMMARY_TIMEOUT_MS=90000`
  - `OPEN_WEIGHT_LLM_LEARNING_TIMEOUT_MS=120000`
  - `OPEN_WEIGHT_LLM_LABEL_TIMEOUT_MS=30000`
- **Context profile:** `qwen3-4b-instruct-2507-q4_k_m:ctx-4096:summary-v2`, window 4096, reserve 640, margin 128 (`moderationSummaryContext.ts:50-57`); llama-server `--ctx-size 4096 --parallel 1 --n-predict 768` (`entrypoint.sh`).

## Zweite Laborinstanz: upstream/main (Delta und E4/E5)

- Same VM. The v1.3 stack was stopped first; its volumes are kept. The main stack runs as Compose project `arsnova-main` with fresh volumes and `prisma migrate deploy`.
- Compose file: `docker-compose.prod.yml` @ `74608ca7`, unchanged.
- `lab-main/.env.production` is the same as the v1.3 lab, plus three values from **main's** `.env.production.example`:
  - `QA_SUMMARY_TIMEOUT_MS=90000`
  - `OPEN_WEIGHT_LLM_LEARNING_TIMEOUT_MS=300000`
  - `OPEN_WEIGHT_LLM_LEARNING_DEBUG_LOG=false`
- llama-server on main: `--ctx-size 8192`. Context profile `ctx-8192` (`moderationSummaryContext.ts` @ main).
- Main forces list nicknames for new Q&A sessions (`participantJoin.ts:395`). Lab scripts therefore use list names (`lib/trpc.mjs`, `nick()`).

**Measured on which version:**

| Version | Experiments                                                      |
| ------- | ---------------------------------------------------------------- |
| v1.3.0  | E1, E2-unit, E4-0, F4/F5, E5-unit, E6, E7, E8, E9 tests, F1-unit |
| main    | E1, E2-unit, E4, E5-unit, E5-live, F1-unit, F1 server round trip |

## Testumgebung (Unit-Tests)

- Node v25.5.0 locally. `.nvmrc` asks for 24.18.0; main has `engine-strict` with `<25`.
- For main, `npm ci --engine-strict=false` was used. That's a documented deviation; the tests use no Node-25-specific APIs.

## Nicht nachgebaut (Gültigkeitsgrenze)

None of the following touch a Thema 5 trust boundary between participant, host, backend and runtime:

- nginx/TLS/certbot, UFW/fail2ban, SSH hardening
- systemd backup and monitoring units, restic Storage Box
- the second physical host (only optionally as a VM; same-host lab profile instead)

TLS and host hardening are explicitly "Betriebssache" per `docs/SECURITY-OVERVIEW.md:292`.

## Hinweise zu den Rohdaten

- `data/e1-authz-negative-main-74608ca7.json` contains the field `"baseline": "v1.3.0"`. The run itself targeted `upstream/main@74608ca7`, as the file name says; the script writes this label as a constant (`scripts/e1-authz-negative.mjs:113`).
- In `data/e2-lifecycle-unit-main.json`, `variant: baseline-1.3` names the baseline variant of the test (full revalidation). The code under test is `main@74608ca7`.
- `data/e8/npm-sbom-v1.3.0.cdx.json` lists 229 components. `package-lock.json` at v1.3.0 has 471 non-dev entries; for example `@angular/core` and `zod` are missing, so the SBOM covers only part of the production tree.
