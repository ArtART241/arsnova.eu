# E10 – CI/CD-Lieferkette (GitHub Actions)

The analysis is **read-only**, against two workflow states:

- **Baseline:** `v1.3.0` (`87c39334`), from the local worktree.
- **Delta:** `upstream/main` at `74608ca7` (2026-11-15). The files were fetched via `gh api` and have the same content as the local `delta-main` worktree.

## Tools

| Tool   | Version | Call                                                       | Raw data                                                 |
| ------ | ------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| zizmor | 1.32.0  | `zizmor --offline --persona=regular .github/workflows/`    | `data/e10/zizmor-v1.3.0.txt`, `data/e10/zizmor-main.txt` |
| gh CLI | —       | `gh api` (workflow contents, commit/tag lookups, run list) | inline below                                             |

**Limitation of `--offline`:** online audits (`impostor-commit`, `known-vulnerable-actions`, `ref-confusion`) were not run, because no token was used.

## Findings

| #   | Vector                                                                                               | Status                     | Evidence                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | "Pwn request" (`pull_request_target`, `workflow_run`, `issue_comment` with checkout of foreign code) | **absent**                 | triggers: `ci.yml:17-24`, `codeql.yml:11-18`, `deploy-landing.yml:9-20`, `pr-template-gate.yml:3-10`                                                                                                                        |
| V2  | Script injection via `${{ github.event.* }}` in `run:`                                               | **absent**                 | PR body arrives only via `env:` (`pr-template-gate.yml:33-36`); other event values are SHAs (`ci.yml:73-75`)                                                                                                                |
| V3  | Mutable action refs (tags)                                                                           | **absent**                 | all `uses:` are 40-hex SHAs (78 entries: `ci.yml` 70, `deploy-landing.yml` 4, `codeql.yml` 3, `pr-template-gate.yml` 1); the non-SHA grep is empty                                                                          |
| V4  | Token scope too broad                                                                                | **present (High, zizmor)** | `deploy-landing.yml:22-25` sets `pages: write` and `id-token: write` at workflow level, so they also apply to the `build` job, which runs `npm ci` on PRs                                                                   |
| V5  | Write rights in the build job                                                                        | **absent**                 | `ci.yml:42` sets `contents: read`; `packages: write` only in `publish-image` (push to main)                                                                                                                                 |
| V6  | Archived third-party action                                                                          | **present**                | `grafana/k6-action@e471…` (`ci.yml:1850`); only in the manually or variable-gated production load job                                                                                                                       |
| V7  | `persist-credentials` (artipacked)                                                                   | **heuristic, 27×**         | `actions/checkout` without `persist-credentials: false`; uploaded artifacts contain only reports, not the workspace → low risk                                                                                              |
| V8  | SSH host key not pinned                                                                              | **present**                | `appleboy/ssh-action` without the `fingerprint` input (`ci.yml:2324-2330`, `2440-2446`); the deploy user is in the docker group (root-equivalent)                                                                           |
| V9  | Install scripts in the build                                                                         | **present**                | `npm ci` without `--ignore-scripts` in the Docker build; 14 packages have lifecycle scripts                                                                                                                                 |
| V10 | Transitive downloads behind a SHA-pinned action                                                      | **present**                | `trivy-action@ed142fd` (v0.36.0) → `setup-trivy@3fb12ec` (v0.2.6) → `trivy/contrib/install.sh@75c4dc0`. The tarball and checksum come from the **same release** (`install.sh:61`), which proves integrity, not authenticity |
| V11 | No Dependabot for `github-actions`                                                                   | **present**                | `.github/dependabot.yml` covers npm only, so SHA pins age without alerts                                                                                                                                                    |
| V12 | Environment protection / fork-PR approval                                                            | **not verifiable**         | admin API returns 403 (validity limit)                                                                                                                                                                                      |

## Case study: CVE-2026-33634 (Trivy, 19–20 March 2026)

- **What happened:** 76 of 77 `trivy-action` tags and all 7 `setup-trivy` tags were force-pushed to a credential stealer. Exposure window was about 19.03. 17:43 UTC to 20.03. 05:40 UTC (sources: Aqua Security, Snyk, Socket; GHSA-69fq-xp46-6x23).
- **Measured non-exposure of arsnova:**
  - `git log -G 'trivy-action@'` shows Trivy first entered `ci.yml` on 2026-07-06 (`c7283bbc`, `dddc355a`).
  - At the commit before the window (`53de744b`) and the commit inside the window (`f6fdd260`), the workflow contained no Trivy step.
  - The one CI run inside the window was run `23310814270` (2026-03-19 18:33 UTC, push, `f6fdd260`). It had no Trivy step.
- **Today:** the pinned `trivy-action@ed142fd…` is v0.36.0 (commit dated 2026-04-22, after the incident). That version itself pins `setup-trivy` by hash.

## Assessment

The repository applies the most important GitHub Actions hardening patterns:

- SHA pinning
- minimal default permissions
- write scope isolated in its own job
- no risky triggers
- no script injection

The remaining risks sit **behind** the pins:

- transitive downloads (V10)
- lifecycle scripts (V9)
- stale pins (V11)
- an unverified SSH host key (V8)

Plus one concrete least-privilege violation (V4).

## Recommendations

| Rec. | Measure                                                                                                | Effort           | Addresses             |
| ---- | ------------------------------------------------------------------------------------------------------ | ---------------- | --------------------- |
| R1   | Move `pages`/`id-token` permissions into the `deploy` job                                              | 5 lines          | V4                    |
| R2   | Add `fingerprint:` to `ssh-action`                                                                     | 2 lines + secret | V8                    |
| R3   | Add the `github-actions` ecosystem to Dependabot                                                       | 4 lines          | V11                   |
| R4   | Run `zizmor` as a CI job                                                                               | 1 job            | regression protection |
| R5   | Replace `grafana/k6-action` with `grafana/setup-k6-action`                                             | small            | V6                    |
| R6   | Long-term: verify Trivy via cosign signature or a fixed binary SHA instead of the same-origin checksum | medium           | V10                   |

Ein Fix ist nicht Teil der Prüfungsleistung (Spec §4.1.3), die Empfehlungen sind konkret und umsetzbar.
