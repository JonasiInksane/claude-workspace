# Example library app: audit, v2 (synthetic test fixture)

Date: 2026-01-10 | Project: Example lending library (made up for the findings import tests) | Type: audit

## Summary
- **Progress since v1:** C7, H23 and K-3 are fixed.
- **Biggest risk now:** the loan export.
  - **X1:** anyone can list another member's loans.
- **Recommended next step:** Phase 1 below, starting with X1.

## How this was done
- Synthetic: written by hand for the tests. It describes no real project, and every path is made up.
- **Checked by hand (✔):** X1 and X2.

## Status of v1 findings

| ID | Status | Note |
|---|---|---|
| C7 loan export authz | **Fixed** | Member check plus tests |
| H21 fine waivers in `fines.waive` | **Open, worse**: see R-M1 | |
| H23 card number on receipts | Partly | Masked on paper, still shown in the email |
| H29 holiday calendar | Open (only in December) | |
| M4 slow catalog search | Partly | Faster, still no index on titles |
| L2 footer year | Open | |
| K-3, K-4, K-5 | **Fixed** | |
| W-2, W-6/W-7 | Open | Overdue days are counted three different ways |
| D-1 / D-9 shelf labels, print layout | Open | Labels are cut off on narrow printers |
| `loan.member!` / `as unknown` | Open | 9 / 3 |
| Stray TODOs | Open | A handful left |
| Q-8 old bundler | Won't fix | Replaced next year |

## New findings

### Critical
| # | Problem | Where | Fix |
|---|---|---|---|
| X1 ✔ | The **public** loan export accepts a `memberId` from the query string, so anyone can list another member's loans. | `apps/api/src/loans/export.mjs:8-20` → `loans/query.mjs` | Read the member from the session. |
| X2 ✔ | Renewal links never expire, so an old email renews a loan forever. | `loans/renew.mjs:14`, `mail/links.mjs:30`, `loans/router.mjs`, `mail/templates.mjs:5` | Sign renewal links with an expiry. |

### High
| # | Problem | Where | Fix |
|---|---|---|---|
| X3 | The catalog page sends staff notes to visitors. | `catalog/page.mjs:22` | A visitor view of each book. |
| R-N1 | Two renewals at the same moment both pass the renewal limit. | `loans/renew.mjs:40+` | A conditional update. |
| Q-H1 | **The reminder tests fail on the first day of every month.** They build dates from the real clock. | `reminders/*.test.mjs`, `jobs/digest.test.mjs:12` and others | A fixed test clock. |
| Q-H2 | The search index is rebuilt inside the request, so a busy page times out. | `apps/api/src/search/rebuild.mjs` | Move it to a job. |

### Medium (grouped)
- **Members:**
  - The password hint is shown in plain text (X6).
  - There is no limit on how many holds one member can place (X7). The holds page also forgets its sort order.
- **Fines:**
  - A fine can be waived twice (R-M1); same root cause as H21.
  - The fine receipt repeats H21.

### Low (summary)
- **Web:**
  - `EX-LINT` warnings are noisy.
- Duplicated date formatters (L-3).

## Checks

| Check | Result |
|---|---|
| Type-check (api, web) | 0 errors |
| Tests api | 120 pass, **4 fail** |

```text
### Critical
| Z-1 | inside a code block | never parsed |
```

## Updated fix plan

### Phase 1: access (this week)
1. **X1** loan export: read the member from the session. This also closes H23.
2. **X2** expiring renewal links.
3. **X3** a visitor view for the catalog.
4. **H21 + R-M1** one waiver rule.

### Phase 1.5: tests green again (an hour)
5. A fixed clock for the reminder tests, and the search rebuild as a job (Q-H1, Q-H2).

### Phase 2: holds and fines
6. The renewal limit (R-N1), and the overdue maths (W-2, W-6/W-7).
   Continued: the holiday calendar (H29) too.
7. Hold limits (X7) and the password hint (X6). See also Z-99.
8. The member pages (K-3 to K-5, and Z-40 to Z-42).

## Open questions for the owner
1. Do members ever share one library card? (X3)
2. Should a waived fine be logged for the treasurer? (R-M1)
