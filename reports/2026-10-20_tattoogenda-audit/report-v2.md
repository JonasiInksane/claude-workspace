# Tattoogenda: web app audit, v2 (re-check after the two-PC merge)

Date: 2026-10-20 | Project: Tattoogenda (`C:\Users\jonas\Desktop\Coding\Tattoogenda\tattoogenda` on this PC, branch `rebuild-mascot` at merge `e0f8b9a6c`) | Type: audit (revision of `report.md`)

## Summary
- **Progress since v1:** C1, C2, H1 (for `shop.get`/`payment.config`), H15, H16, P-14, A-11 and the inbox state bugs (T-7, T-8, T-9, T-12) are fixed. The inbox refactor fits together after the merge and is covered by tests.
- **Biggest risk now: new auth holes.** These were not in v1.
  - **N1:** the email OAuth callback lets anyone attach their own mailbox to any shop.
  - **N2:** a verify-email link works as a password-reset token, and sessions can't be revoked.
  - **N3:** the Bird secrets still leak through the public consent page.
  - **N4:** the Pay.nl REST routes have no auth.
  - The lead auditor confirmed all four by hand.
- **Money paths are still mostly open:** H2, H5, H7, H8, H9 and H14, plus a new double-charge race on booking-link checkout.
- **Next.js and i18n:** the app is a client-side SPA inside the App Router (about 40% idiomatic). All 8 locales ship to every visitor, and dates and amounts are formatted in English or the browser's locale.
- **Recommended next step:** an updated Phase 0 (below), starting with N1, N2 and N3. Also fix the server test clock drift so CI is green again (61 failures).

## How this was done
- **Reviewers:** 6 parallel read-only reviewers covered auth/security, Next.js architecture, i18n, structure/tooling, money/booking, and inbox/admin/other.
- **Checks run:** type-check, lint and unit tests (web, utils, server). Server tests ran from a scratch folder with dummy env values (see Tooling).
- **Verified by hand (✔):** the lead auditor re-read the code for N1, N2, N3 and N4. Other findings come from the reviewers with file:line evidence and were not independently re-checked.
- **Not covered:** the running app, a production build, integration tests (they need a DB), Python agents, and Expo flows beyond i18n and shop settings.
- **Disclosure:** during the merge, before this audit, the lead ran focused server tests (shop, subscription) from `apps/server`. Those load the real root `.env` (see T-H2). They use a fake Prisma client, so no real DB writes are expected, but this was not proven.

## Status of v1 findings

| ID | Status | Note |
|---|---|---|
| C1 subscription authz | **Fixed** | `shopProcedure` + `requireShopOwner`, server-side trial terms, tests |
| C2 `/api/exact/*` debug routes | **Fixed** | Routes deleted, bootstrap test |
| H1 secrets in `shop.get` / `payment.config` | **Fixed** (for those two) | Other paths still leak, see N3. Expo reveal limited to the API key and the Bird webhook key (merge resolution) |
| H2 negative tenders / client prices / no sum check | Open | Same holes in wrap-up (`appointment/schema.ts`) and `payShare` |
| H3 email OAuth state | **Open, worse**: see N1 | |
| H4 preview iframes, `interpolateMail` | Open | |
| H5 ServiceModal 2001 dates | Open | |
| H6 public consent payload | Partly | Now token-gated, but still returns the full customer, forms and `shopConfiguration` |
| H7 wizard tabs-mode Save | Open | |
| H8 NonTattoo voucher | Partly | Server debits atomically, but the web modal never sends voucher lines |
| H9 terminal card correction | Open (fails closed) | |
| H10 automation autosave | Open | Also: autosave never clears `isDirty` |
| H11 Configuration tab | Open | |
| H12 onboarding second shop | Partly | Double linking is blocked; an orphan shop is still created on retry |
| H13 booking-link finalize | Partly | Sequential retries are OK; races and the raw `ALREADY_BOOKED` remain |
| H14 guest-spot seats | Open | |
| H15 inbox 50-message cap | **Fixed** | |
| H16 inbound email styles | **Fixed** | Sandboxed iframe, CSP, DOMPurify |
| H17 DataTable error state | Open | |
| H18 thin tests / CI | Partly | Many more tests; CI gaps remain (see Tooling) |
| N-1 all locales shipped | Open | ~1.9 MB raw JSON in the client bundle |
| N-2 route ID validation | Open | `notFound()` never used in `app/` |
| N-3 / N-18 client session shell, regex routing | Open | Up to 4 navigations on a cold `/`; 15 regexes |
| N-4 root `error.tsx` / `global-error.tsx` | Open | The shop `error.tsx` also shows `error.message` verbatim |
| N-5 / Q-7 missing keys | Open | Web: 589–781 missing per locale; `services.json` is English-only |
| N-6 Ant Design / dayjs locale | Open | |
| N-7 security headers | Open | |
| N-8 public booking metadata | Open | |
| N-11 Brussels timezone | Partly | Now only a fallback, but `I18nProvider` still hard-codes it |
| N-13 / Q-5 ESLint 8 | Open | |
| N-14 QueryClient defaults | Partly | Appointments have a policy; the rest use the global defaults |
| T-6 mark-read | Partly | It is a write inside a GET poll (see F-M3) |
| T-7, T-8, T-9, T-12 | **Fixed** | |
| T-14 attachments as base64 | Open | |
| A-4 salary fields | Partly | |
| A-5, A-6, A-9, A-10 | Open | |
| A-7 dashboard by role | Partly | |
| A-11 delete-shop panel | **Fixed** | |
| P-6, P-7, P-8/P-10/P-12, P-9, P-13 | Open | Terminal detection 5×, card fee ~5×, all float |
| P-14 franchise balance | **Fixed** | Server `weeklyFeeSummary` |
| R-8 booking calendar day | Partly | |
| R-9, R-10, R-11, R-13 | Open | Spinners that never end; `/shop/undefined`; no return path after login |
| R-12 auth errors | Partly | |
| Q-6 Node EOL | Open | |
| Q-13 deep imports | Open | 163 feature→feature (was 172), plus 100 from `app/`; 17 features in one cycle |
| Q-14 libraries / dependencies | Open | moment + dayjs, heroicons v1 in 154 files, ~19 unused root deps |
| `session.shop!` / `as never` | Open | 100 / 19 (was 15) |
| Dead files | Open | More candidates found (see Structure) |
| Phase 4 decomposition | Partly | TicketsInbox 477→372 and CustomerPanel 511→322 are done; the other five are untouched |

## New findings

### Critical
| # | Problem | Where | Fix |
|---|---|---|---|
| N1 ✔ | The **unauthenticated** email OAuth callback trusts plain-JSON `state` `{shopId, provider}`. An attacker authorizes their own Google/Microsoft mailbox, edits `shopId` to a victim shop, and opens the callback. The mailbox is then attached to that shop's inbox, so they can receive customer replies and possibly send as the shop. | `apps/server/src/http/oauth.ts:92-107` → `email/completeOAuth.ts` → `accounts.ts:93` | Random state stored hashed server-side, with TTL, single use, and bound to user and shop (copy `googleSync/oauth.ts`). Also check in the callback that the user is staff of the shop. Supersedes H3. |
| N2 ✔ | Verify-email and password-reset tokens are the same JWT (`{id,email}`, same secret, no purpose claim), so a 7-day verify link works as a reset token. Reset tokens are reusable for 4 h. Sessions are stateless 30-day JWTs that reset, change-password and logout never revoke. | `auth/verifyEmail.ts:11,35`, `auth/passwordReset.ts:17,31`, `sessionToken.ts`, `auth/router.ts:87-90` | A `typ`/`aud` claim on every `jwt.sign` (~15 sites), checked on verify. Single-use reset (store a hash or bind it to the password hash). Add `tokensValidAfter`/`sessionVersion` on User, checked in `createContext`. |

### High
| # | Problem | Where | Fix |
|---|---|---|---|
| N3 ✔ | The Bird `accessKey` and `webhookSigningKey` live in `shopConfiguration`, and raw `shopConfiguration` is returned by the **public consent endpoints** and by the appointment detail select. | `consent/publicById.ts:22`, `db/selects/appointment.ts:174` | An explicit safe DTO at every client boundary, and extend the response redactor. Better: move the secrets out of `shopConfiguration`. Consider rotating the Bird keys. |
| N4 ✔ | The `/api/paynl/*` REST routes have no auth, fall back to the platform `PAYNL_API_TOKEN`, and set global SDK config per request (a cross-tenant race). The FullStack relay is similar but lower risk. | `http/paynl.ts:9-104`, `http/fullstackPayments.ts` | Move them behind `shopProcedure` + POS permission, and load credentials from the DB on the server. |
| N5 | The platform superuser is matched by email, and registration does not require a verified email or block reserved addresses. If a listed email has no account in some environment, anyone can register it and become owner of every shop. | `access/platformSuperuser.ts`, `auth/register.ts:15-30` | A DB flag (`isPlatformAdmin`), or at least `emailVerified` plus a reserved-email block on register and invite. |
| B-N1 | Booking-link completion has no transaction or lock. Two finalizes, or finalize racing the Stripe webhook, can create duplicate projects and appointments. | `bookingLink/complete.ts:43+` | A serializable transaction with a conditional status claim (copy `bookingPublic/paymentCompletion.ts`). |
| B-N2 | Concurrent booking-link checkouts can each create a Stripe session, so a customer can pay twice. | `bookingLink/checkout.ts:76-127` | An attempt row, a Stripe idempotency key, and a flag for refunding a second paid session. |
| T-H1 | **The server test suite is red because the date moved on.** There are 61 failures. Fixtures hard-code `2026-10-06`, and the SMS grace period ended 2026-10-01. The best-hardened booking flows have no running coverage. | `bookingPublic/*.test.ts`, `bookingLink.contract.test.ts`, `sms/smsBilling.test.ts:24` and others | Inject a clock or use `mock.timers`. **Product check:** SMS billing now applies to the shops that were in the grace period. Is that intended? |
| T-H2 | Server tests load the real root `.env` (`env.ts:4-6`), so `npm test` on a dev machine can reach real services. | `apps/server/src/env.ts` | Skip dotenv when testing; the runner sets `IS_TEST_ENVIRONMENT`. |
| I-H1 | Web formats dates and amounts with the browser locale or English: `Intl.NumberFormat(undefined)`, bare `toLocaleString()`, and the public `BookSuccessPage` date. There is no `useFormatter` and no ICU plurals. | `money.ts:4`, `BookSuccessPage.tsx:49` and ~10 others | Route all formatting through next-intl's formatter with `shop.timezone`. |
| I-H2 | Server emails print English month and weekday names. | `guestSpot/emails.ts:174`, `dashboard/paymentStats.ts:233` | Locale-aware formatting per recipient language. |
| I-H3 | Web picks the owner's UI language from the shop, and Expo from the user, so the same person sees different languages on web and mobile. | `apps/web/src/i18n/locales.ts`, `apps/expo/App.tsx:89` | UI uses `user.language ?? shop.language`; customer messages use `customer.language ?? shop.language`. |
| X-H1 | The root layout awaits `cookies()` and `headers()` for the locale, so every route is dynamic and nothing can be static. | `app/layout.tsx:25-26` | Do locale detection in the proxy or a route segment. |
| S-H3 | Server modules have no boundaries: 676 deep cross-module imports, 41 of 64 modules in one cycle, and 10 file-level cycles (ai→bird→tickets→meta through `_shims`). | `apps/server/src/modules` | Add `madge --circular` to CI now, then dependency-cruiser per module. |

### Medium (grouped)
- **Auth and security:**
  - Exact OAuth state is unsigned (N6).
  - No rate limiting on login, forgot password, register or public booking (N7). The web tRPC proxy also drops the client IP.
  - Anyone can unsubscribe any customer by email and shopId (N8); use the existing HMAC token.
  - Redirect origin is built from `X-Forwarded-Host` (N9).
  - Still open from v1: CSV injection, WhatsApp `endsWith` origin check, `book-embed.js` fails open and allows `javascript:` URLs, unsandboxed attachment iframes, open redirect via `returnUrl`, and raw errors in Pay.nl, partner and widget REST responses.
- **Money:**
  - `payShare` and `updateArtistShare` accept any amount.
  - The wrap-up schema repeats H2.
  - `updateGiftVoucherPayments` accepts negative lines, which raises a voucher's balance.
  - An onboarding retry after a successful link leaves the user stuck.
- **Next.js:**
  - No server prefetch or `HydrationBoundary` anywhere.
  - `b/[code]` resolves the short link on the client.
  - Ant Design CSS is not extracted during SSR (flash of unstyled content).
  - 497 of 550 `.tsx` files are client components.
  - The two tRPC proxies forward different headers.
- **Inbox:**
  - When the customer lookup fails, the panel offers "create customer", which leads to duplicates.
  - The AI extract runs automatically for every unlinked conversation opened (token cost).
  - Polling writes to the DB and calls Bird every 10 s per tab.
  - The marketing list detail spins forever on an error.
- **i18n:**
  - Expo uses sentence-style keys, and the ones ending in `.` never resolve. 7 keys are used in Expo code but defined nowhere.
  - Expo moment locales are probably not registered.
  - About 20 string concatenations, and plurals done with code ternaries.
  - Two mail i18n systems with loose language codes.
  - Three separate locale matchers.
  - No type safety for message keys.
  - One missing web key: `tickets['failed to upload file']`.
- **Tooling:**
  - The Expo lint config turns off `react-hooks/rules-of-hooks`.
  - The server has no lint, with 121 `as any` and 274 `: any`.
  - There is no `.gitattributes`, so the format check is useless on Windows.
  - Turbo 1 `pipeline` lists `NEXTAUTH_*` env vars the app doesn't use.
  - `pos/SaleTab.tsx` and `pos/ArtistsTab.tsx` do float money math with 1 POS test.

### Low (summary)
- **Next.js:**
  - `middleware.ts` → `proxy.ts`.
  - No `metadataBase` or `robots.ts`; `book/[token]` has no noindex.
  - Possible double `decodeURIComponent` on a param.
  - Shop locale messages are loaded twice.
  - The `SERVER_URL` parsing is copied 3 times.
- **Auth:**
  - The partner API key comparison is not constant-time.
  - A manager can change a user's email without re-verification.
  - CSRF relies only on SameSite=Lax.
- **Inbox:**
  - Polling auto-scrolls a user who is reading older messages.
  - Notes are not paged.
  - `formatConversationTime.test.ts` tests its own copy, not production code.
  - Duplicated status and time formatters.
- **Dead code:**
  - Web: `ServiceFormFields.tsx`, `ArtistsPage.tsx`, `ShopSettingsSummaryHeading.tsx`, `PlaceholderPage.tsx`, `lib/publicBookUrl.ts`.
  - Server: `appointment/intern.ts`, `mailing/mjml.ts`, `meta/access.ts`, `resolveOmnichannelRollout.ts`, `lib/publicBookUrl.ts`.
- **Docs:** stale paths in `PROJECT_MAP.md`, including its outdated "5 tsc errors" note.

## Checks

| Check | Result |
|---|---|
| Type-check (web, server, utils, expo) | 0 errors |
| Lint web / expo | 0 errors; 51 / 16 warnings |
| Tests web | 407 / 407 pass |
| Tests utils | 86 / 86 pass |
| Tests server | 1447 pass, **61 fail**, 1 skipped (clock drift, see T-H1; 2 failures in `payment/integrity.test.ts` are error-code drift, NOT_FOUND vs FORBIDDEN/BAD_REQUEST, which still needs confirming) |
| Format (`--end-of-line auto`) | 3 files differ |
| Node | Active **v24.11.1** on this PC; repo pins 20.15.1 |

## i18n parity (web, source en-US, 4,046 keys)
| Locale | Missing | Missing files |
|---|---|---|
| en-GB | 781 | booking, services |
| nl | 589 | services |
| de, fr, es, it, pt | 698 each | services |

Expo (3,753 keys): 76–168 missing per locale, mostly `staff.json`. About 38% of Expo keys look unused.

## Verdict per area
- **Authentication and authorization:** central tenant checks (`shopProcedure`) are good, and Stripe, Meta and Google flows are solid. Token design and the OAuth callbacks are the weak spots (N1, N2, N6), and there is no rate limiting.
- **Next.js usage:** modern basics are right (async params, `next/font`, lazy Bryntum, no Pages Router). Architecturally it is a client SPA: session, permissions, redirects and data all live on the client, with no server prefetch and one dynamic root.
- **Module structure:** web `tickets` is now a good example (`public.ts` + boundary test). Most other features and almost all server modules have no boundaries and form large cycles.
- **Features:** the inbox is in good shape. Money and booking keep strong terminal and public-deposit paths, but the non-terminal POS, wrap-up and booking-link paths are weak. Admin and marketing state bugs remain.
- **Language:** nothing is untranslated at runtime thanks to the en-US fallback, but about 17% of web keys are missing per locale, formatting isn't localized, and web and Expo maintain separate catalogs.

## Updated fix plan

### Phase 0: security (now, each ≤ 1 day)
1. **N1** email OAuth: stored, single-use, user-bound state, and a session check in the callback. This also closes H3.
2. **N2** token purposes, single-use reset, and session revocation (`tokensValidAfter`).
3. **N3** a safe `shopConfiguration` DTO for consent and appointment, plus the redactor. Then decide whether to rotate the Bird keys.
4. **N4** Pay.nl and FullStack REST behind auth, with credentials from the DB.
5. **N5** a superuser DB flag, or a verified-email requirement plus reserved emails blocked.
6. **H4** sandbox the preview iframes and escape `interpolateMail`.
7. **H6** the remaining consent DTO (customer, forms).
8. **H2 + N4-money** one shared nonnegative tender schema for POS, NonTattoo, wrap-up and `payShare`; a server sum check; prices from the DB.
9. **H5** ServiceModal dates, plus a read-only count of services with 2001 dates.
10. Security headers, `book-embed.js` fixes, the open redirect, the WhatsApp origin check, rate limiting (N7) and the unsubscribe token (N8).

### Phase 0.5: CI back to green (half a day)
11. A test clock (`mock.timers`) for the 61 server failures, and test runs that never load the real `.env` (T-H1, T-H2). Confirm the `integrity.test.ts` error codes.

### Phase 1: money and data integrity
12. Booking-link completion transaction and checkout idempotency (B-N1, B-N2, H13).
13. `payments/tender.ts` in cents (P-8/P-10/P-12, the POS float math), and store the card fee per payment (P-9).
14. Voucher lines in NonTattoo (H8), the voucher edit validation, and linking issue to payment (P-6).
15. The wizard guards (H7) and terminal correction (H9).
16. Idempotent onboarding (H12, N6-money), POS direct writes (P-13), guest-spot capacity in the DB with a lock (H14).
17. The automation persistence model (H10), and the Configuration tab load gate (H11).

### Phase 2: reliability and UX
18. DataTable error slot (H17), root `error.tsx` and `global-error.tsx`, route ID validation with `notFound()`.
19. Public and auth dead-ends (R-9 to R-13), the login return path, and the inbox leftovers (customer-panel error branch, on-demand AI extract, mark-read mutation).
20. State bugs: A-4 to A-10.

### Phase 3: Next.js and i18n architecture
21. Server-side shop bootstrap in `shop/[shopId]/layout.tsx` (session, redirect, notFound, hydrate), and route groups instead of regexes.
22. next-intl `getRequestConfig` with one locale and only the needed namespaces per request; locale detection out of the root layout; one shared locale resolver; `useFormatter` with the shop timezone; Ant Design and dayjs locales.
23. A key-parity and placeholder CI check for web and Expo, and next-intl type augmentation. Backfill about 700 keys per locale and add `services.json`.
24. Server-rendered public booking (`generateMetadata`, `notFound`, prefetch) and Ant Design SSR style extraction.

### Phase 4: structure and tooling
25. ESLint 9 flat config with eslint-config-next 16; server lint; turn `rules-of-hooks` back on in Expo; a warning budget and a format check in CI with `.gitattributes`.
26. `madge --circular` in CI. Add `public.ts` to every web feature with a `no-restricted-imports` ratchet, then server module index files.
27. Node 22/24 LTS (this PC already runs 24); Turbo 2; delete unused deps and dead files; one date library; heroicons v2.
28. `useShopSession()` to remove the 100 `session.shop!`. Decompose the remaining Phase-4 files when they are touched.

## Open questions for the owner
1. Does any address in `PLATFORM_SUPERUSER_EMAILS` lack an account in any environment (staging, a fresh DB)? (N5)
2. Is `PAYNL_API_TOKEN` set in production? (N4)
3. Should the Bird, Mollie, Brevo, FullStack and Pay.nl keys be rotated, since they were readable by staff browsers (H1) and are still readable through public consent links (N3)?
4. Is SMS billing supposed to apply now that the grace period ended on 2026-10-01?
5. v1 questions 1, 4, 5 and 6 are still open: is port 4000 public, does Render add headers, should autosave ever write to live automations, and is there a release target.
6. On the merge-time server test run that loaded the real `.env` (see Disclosure): can it have reached anything real, for example a shared Redis?
