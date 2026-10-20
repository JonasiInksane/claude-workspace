# Tattoogenda: web app audit

Date: 2026-10-20 | Project: `projects/tattoogenda` (`apps/web`, plus server endpoints it depends on) | Type: audit

## Summary
- **The structure is solid; the safety issues are not.** The routes are thin, and there are no `any` or `ts-ignore` in production code. But there are 2 critical server authorization holes and about 15 high-severity issues in security, money handling and data integrity.
- **Fix first:** anyone can read or change other shops' data through `subscription.create` / `upgradeDowngrade` and the unauthenticated `/api/exact/*` debug routes. Provider secrets (Mollie, Bird, Brevo, FullStack) are also sent to every staff browser.
- **Recommended next step:** Phase 0 below, nine small security slices that are each about a day or less. Then Phase 1, money and data integrity.

## How this audit was done
- **Coverage:** 7 parallel read-only reviewers, each with its own scope. Together they covered all ~93k lines of `apps/web`: security, Next.js architecture, inbox, booking/payments, admin/staff, remaining features + shared UI, and quality/tooling.
- **Read-only:** nothing was edited, built, tested or started, and no `.env` or `.npmrc` was opened.
- **Verified by hand:** the lead auditor re-read the code for C1, C2, H1, H2, H3, H5, H6 and H8 and confirmed each one (✔ below). The other findings come from the reviewers, who confirmed them against source with file:line evidence, but they were not independently re-checked.
- **Not covered:** runtime behaviour, the server beyond the endpoints the web uses, Expo, and the Python agents.
- **Finding IDs:** S = security, N = Next.js, T = inbox, P = payments/booking, A = admin, R = remaining features, Q = quality. They refer to the reviewers' detailed reports (about 150 findings with file:line, impact and fix), which can be saved as `findings.md` on request.

## Critical (fix immediately)

| # | Problem | Where | Fix |
|---|---|---|---|
| C1 ✔ | `subscription.create` and `upgradeDowngrade` use `protectedProcedure` with no shop membership check. Any logged-in user can write a subscription with client-chosen status and dates (e.g. ACTIVE until 2099) for **any** shop, or cancel another shop's real Stripe subscription (`updateToPlan: ''`). `createSubscriptionBySessionId` has the same gap. | `apps/server/src/modules/subscription/router.ts:48-77`, `onboarding.ts:44-163` | `shopProcedure` + owner check. The server derives status and dates; the input becomes `{shopId, productId}` only. (R-1) |
| C2 ✔ | `GET /api/exact/invoices` and `/api/exact/api_test` have **no authentication** and are always mounted. With a `shopId` they use that shop's Exact OAuth tokens to return invoice PDFs and run API calls. | `apps/server/src/http/exactDebug.ts:68-120`, mounted at `http/app.ts:53` | Delete both routes, or require a session + `requireOwner`. (S-1) |

## High

| # | Problem | Where | Fix |
|---|---|---|---|
| H1 ✔ | `shop.get` (any staff member, not only owners) returns `APIKey`, `mollieAPIKey`, `sendInBlueApiKey`, Bird `accessKey`/`webhookSigningKey` and FullStack `authKey`/`hostedAuthKey` in plain text. Several pages fetch it just to compute a "connected" boolean. | `apps/server/src/modules/shop/get.ts`; web: TicketsSettingsModal, FormBuilder, NotificationsSettingsPage, Integrations cards | Return booleans or masked values. Write-only key fields, plus an owner-only procedure if editing needs it. (T-1, A-3) |
| H2 ✔ | The payment schema accepts **negative** cash, card, tip, voucher, other and amount values. Product `price` comes from the client and is trusted, and there is no server-side sum check on direct POS writes. | `apps/server/src/modules/payment/schema.ts:55-69`, `mutations.ts`; web `pos/saleControls.tsx`, `SaleTab.tsx` | `.nonnegative()` everywhere, a server-side tender sum check, and product prices looked up from the DB. Client: reject negatives. (P-5) |
| H3 ✔ | Email (Gmail/Outlook) OAuth `state` is plain JSON `{shopId, provider}` with no nonce or user binding. An attacker can link their own mailbox to a victim shop by sending a staff member a callback link. | `apps/server/src/modules/email/router.ts:37-53`; web `tickets/oauth/EmailOAuthPage.tsx` | Single-use, user-bound VerificationToken state, the same pattern as googleSync. (S-3) |
| H4 | Same-origin XSS: the email preview iframes use `srcDoc` without `sandbox`. `interpolateMail` inserts custom content without escaping, so a staff member can plant a script that runs as the owner. | `notifications/settings/EmailPreview.tsx:6`, `composer/HtmlPreview.tsx:4`, `packages/utils/src/interpolateMail.ts:131-140` | Add `sandbox=""`, and escape or sanitize custom content on write and on interpolation. (S-2, T-4, Q-1; plan task A01) |
| H5 ✔ | Editing a service that has an availability window **corrupts the dates**. superjson delivers `Date`, so `String(date).slice(0,10)` gives `"Wed Oct 21"`, and `new Date("Wed Oct 21")` saves as 2001. The service then drops out of online booking. | `features/services/ServiceModal.tsx:124-125, 227-228` | Format as `YYYY-MM-DD` in the shop timezone, and send date strings. **Check production data for 2001 dates and repair them.** (R-2) |
| H6 ✔ | The public consent page receives whole entities: `customer: true` (all columns, including internal notes) and every `filledCustomForms` (signed medical forms). Anyone with the link can see them. | `apps/server/src/modules/consent/publicById.ts` | An explicit `select` DTO with only the fields the page renders. (S-6) |
| H7 | In the appointment wizard's tabs mode, Save on another tab skips the totals, photo and passport checks. A corrected payment can be saved with mismatched totals. | `appointments/wizard/AppointmentWizard.tsx:225-319` | Validate every step in `submit()`, whichever tab is active. (P-1) |
| H8 ✔ | The POS non-tattoo modal records gift-voucher income without deducting any voucher balance, so a voucher can be spent again. | `pos/NonTattooModal.tsx:93-155`; server `payment/mutations.ts:145-180` | Use the shared `GiftVoucherLines` and send the voucher lines. (P-4) |
| H9 | Correcting a terminal payment's card amount always fails on the server (EDIT_REQUIRES_REVIEW), and the user sees "status unknown". If that guard were relaxed, the full amount would be charged twice. | `appointments/chargeCard.ts`, `paymentCommand.ts` | Never start the terminal for an existing payment. Lock the card fields, or add an explicit "charge difference" flow. (P-2, P-3) |
| H10 | Live marketing automations autosave on every keystroke, unordered and not debounced, so customers can get emails from a half-edited flow. The "unsaved changes" dialog is misleading because the edits are already saved. | `marketing/automations/AutomationBuilderPage.tsx`, `FlowInspector.tsx` | Explicit Save for enabled flows, or debounced, serialized autosave. Validate on the server before enabling. (A-1) |
| H11 | The Configuration tab can be saved before settings load, which resets 7 shop flags to defaults. Every save also toggles the deposit-receipt automation. | `administration/configuration/ConfigurationTab.tsx`; server `shop/configuration.ts` | Gate the form on load success, send only changed fields, and decouple the automation. (A-2) |
| H12 | After a successful Stripe checkout, if a later step fails, "Try again" creates a **second shop** for the same payment. | `onboarding/RegistrationSuccessPage.tsx`, `CreateShopPage.tsx` | One idempotent server command keyed by the checkout `sessionId`. (R-3) |
| H13 | Public booking-link `finalize` has no request identity and is auto-retried. A retry after commit shows a raw `ALREADY_BOOKED`, and with a deposit it can create a second checkout. | `publicBook/steps/DetailsStep.tsx` | Route it through `withPublicBookingRequest` with a server `requestId`, and treat `ALREADY_BOOKED` as success. (R-5) |
| H14 | Guest-spot seat capacity is sent by the client and trusted by the server. It is hard-coded per production shop ID and duplicated, and unknown shops get 0 seats, which breaks booking. | `guestPlanner/*`; server `guestSpot/service.ts:258` | Store capacity per shop in the DB and drop it from the input. (R-4) |
| H15 | The inbox only ever loads the latest 50 messages, so older messages can't be reached on web. Auto-scroll also stops working at 50. | `tickets/thread/MessageThread.tsx` | Infinite query on `getMessagePage`, and scroll based on the last message id. (T-2) |
| H16 | Inbound email `<style>` is kept and only `body`/`html` rules are stripped. A sender can restyle or overlay the whole app (a fake login panel), and track or exfiltrate via CSS. | `tickets/thread/EmailHtml.tsx`, `html.ts`, `ui/SanitizedHtml.tsx` | Render email in a sandboxed iframe, and drop `class` from SanitizedHtml. (T-3, S-4) |
| H17 | List errors show as empty lists ("no customers"), because DataTable has no error state. | `ui/table/DataTable.tsx`, `customers/CustomersPage.tsx` | Add an error/retry slot to DataTable/ListPage. (Q-2; plan task A07) |
| H18 | Very thin tests on the riskiest code: POS 1 test for ~5k lines; customers, auth, consent, exact and guestPlanner have none. Browser fixtures are manual and not in CI. CI has no lint warning budget and no format check. | whole app; `.github/workflows/typescript-check.yml` | Pure/controller tests for the checkout, consent and auth flows, and CI ratchets. (Q-3, Q-4) |

## Medium (grouped)
- **Security hardening:**
  - No security headers at all: no CSP, frame-ancestors, HSTS, nosniff or Referrer-Policy (N-7, S-5).
  - CSV export formula injection (S-7).
  - The WhatsApp `postMessage` origin check uses `endsWith` (T-5, S-8).
  - `book-embed.js` accepts any origin and navigates to any URL (S-9).
  - Unsandboxed attachment previews (T-15, S-12).
  - Open redirect via `returnUrl` (R-7, S-10).
  - Raw server errors shown on public pages (R-6).
- **Money and data:**
  - Unrounded float tender maths, with card-fee logic copied 7 times and terminal detection 4 times (P-8, P-10, P-12). This needs one `payments/tender.ts` working in cents.
  - Card fees are recalculated from the *current* rate, which rewrites past reports (P-9).
  - Voucher issue and voucher payment are not linked (P-6).
  - POS direct writes are not idempotent (P-13).
  - The franchise balance is calculated in the browser (P-14).
  - Other-shop appointments are shown in the wrong timezone (P-7).
- **Permissions shown or hidden incorrectly in the UI:**
  - Salary fields are shown to artists who can't change them (A-4).
  - Dashboard widgets are decided by role instead of grants (A-7).
  - The form-builder plan limit is enforced only in the UI (A-10).
  - The delete-shop panel is shown to owners the server rejects (A-11).
- **State bugs:**
  - HoursTab wipes edits that haven't been saved yet (A-5).
  - The email designer re-hydrates over what you're typing (A-9).
  - Mailing (un)subscribe calls overwrite each other (A-6).
  - The inbox CustomerPanel race opens the modal for the wrong customer (T-7).
  - The AI-extract cache never expires (T-8).
  - Inbox pagination gets stuck (T-9).
  - Mark-read doesn't refresh (T-6).
  - One poll failure blanks the thread (T-12).
- **Public and auth flows:**
  - Consent, verify-email and guest-verify have dead-end and error states (R-9, R-10, R-11).
  - Auth errors are silent or wrong (R-12).
  - `/shop/undefined` redirects and deep links are lost (R-13).
  - The booking calendar shows the wrong day for visitors behind the shop's timezone (R-8).
- **Next.js and performance:**
  - All 8 locales (~1.5–1.9 MB) ship to every visitor (N-1, plan task A09).
  - The shop shell waits for the client session before rendering anything, then makes extra client-side redirect hops (N-3).
  - There is no root `error.tsx` or `global-error.tsx` (N-4).
  - Route IDs aren't validated, and a bad ID silently turns the edit page into a create page (N-2).
  - Public booking pages are client-only with generic metadata (N-8).
  - Attachments are eagerly downloaded as base64 (T-14).
- **i18n:** about 700 missing keys per non-English locale, and `services.json` exists in English only (N-5, Q-7). Ant Design and dayjs have no locale set (N-6). The timezone is hard-coded to Europe/Brussels (N-11).
- **Tooling:**
  - ESLint 8 (end of life) with eslint-config-next 14 against Next 16 (N-13, Q-5).
  - Node 20.15.1 is past end of life (Q-6).
  - Moment and dayjs are both in use, heroicons is still v1, and some dependencies are unused (Q-14).
  - There are 172 deep cross-feature imports and no boundary lint (T-22, A-19, R-22, Q-13).

## Low (summary)
- **Type escapes:**
  - About 100 `session.shop!` non-null assertions. Add one `useShop()` hook.
  - Handwritten DTOs and `as` casts on tRPC outputs. Use `inferRouterOutputs`.
  - 15 `as never` casts.
- **Accessibility:**
  - Rows, conversation items and calendar cells that can't be reached by keyboard.
  - Placeholder-only labels in the auth forms.
  - The hand-built menus and drawer have no focus trap.
- **Dead code:** `ServiceFormFields.tsx` (386 lines), `ArtistsPage.tsx` (276 lines) and 3 smaller files.
- **Next.js:** rename `middleware.ts` to `proxy.ts` (Next 16 deprecation).
- **Hard-coded English:** about 46 strings.
- **Docs:** `WEB-PAYMENT-COORDINATION.md` cites a test file that doesn't exist, and the A-task table conflicts with newer records.

## What's good
- **Routing:** route `page.tsx` files are thin server components; `params` is always awaited; Bryntum is lazy-loaded.
- **Type safety:** strict TypeScript, and 0 `any`, `ts-ignore` or `console.log` in production code.
- **Server import boundary:** `@tattoogenda/server` is only ever imported as types (14 importers, 0 value imports).
- **HTML sanitizing:** DOMPurify is used on every `dangerouslySetInnerHTML`.
- **Session cookies:** HttpOnly, SameSite=Lax, Secure in production.
- **OAuth flows:** the Meta and Google connection flows were already hardened (signed or single-use state).
- **Recent work:** the payment journal and terminal recovery work, and the appointment editor split, are well structured.

## Fix plan

Each line is one small slice: one session, one PR, verified, then committed. For each one, use `docs/refactor/prompts/per-feature-refactor.md` and record it in `docs/refactor/records/`.

### Phase 0: security hotfixes (this week, ~1 day each or less)
1. C1: lock down `subscription.*` (shopProcedure + owner, server-derived dates). Add tests for the cross-shop rejection.
2. C2: delete or lock the `/api/exact/*` debug routes.
3. H1: redact secrets from `shop.get`, and add `integrationStatus` booleans plus write-only key fields.
4. H4: sandbox both preview iframes, and escape custom content in `interpolateMail`.
5. H3: user-bound, single-use email OAuth state.
6. H2: nonnegative payment schema, server-side sum check, and DB product prices.
7. H6: an explicit DTO for the public consent page.
8. H5: fix the ServiceModal dates, plus a **data repair query** for services with 2001 dates.
9. Security headers in `next.config.ts` (frame-ancestors with an allow-list for `/book`, `/b` and `/booking-widget`, plus nosniff, Referrer-Policy and HSTS), and the `book-embed.js` origin and URL checks.

### Phase 1: money and data integrity (next 2–3 weeks)
10. `payments/tender.ts` (in cents): one place for paid, remaining, card fee, validation and terminal capability. Replace `saleControls.tsx`, which fixes P-8, P-10 and P-12.
11. Wizard validation across all tabs (H7), and terminal correction rules plus clear rejection messages (H9, P-3).
12. Gift vouchers: shared voucher lines in NonTattooModal (H8), and link issue to payment (P-6).
13. Idempotent onboarding (H12), booking finalize (H13) and POS direct writes (P-13).
14. Marketing automation persistence model (H10), and the Configuration tab load gate (H11).
15. Guest-spot capacity stored in the DB (H14).
16. Store the card fee on each payment (P-9). Move the franchise balance to the server, in cents (P-14).

### Phase 2: reliability and UX
17. Error states: DataTable error slot (H17), root `error.tsx` and `global-error.tsx` (N-4), and error reporting (Q-10).
18. Inbox: message paging (H15), sandboxed email rendering (H16), and the T-6/T-7/T-9/T-12 fixes.
19. Public and auth flows: R-6, R-9 to R-13, and the booking calendar day (R-8).
20. QueryClient defaults per data type (N-14), and route ID validation with `notFound()` (N-2).

### Phase 3: architecture and quality
21. i18n: load only one locale per visitor, add a key-parity test, backfill the ~700 missing keys, and set the Ant Design and dayjs locale and the shop timezone (N-1, N-5, N-6, N-11).
22. Shop shell: prefetch the session on the server, and replace the 14 route regexes with layouts (N-3, N-18; plan task A12).
23. Feature boundaries: `public.ts` for tickets, notifications, artists and administration; move shared editors to `ui/`; a madge or ESLint boundary rule in CI.
24. Tooling: ESLint 9 flat config + eslint-config-next 16, CI lint warning ratchet + format check, `middleware.ts` → `proxy.ts`, and a Node 22/24 LTS plan.
25. Types: a `useShop()` hook, and `inferRouterOutputs` instead of handwritten DTOs.
26. Cleanup: delete the dead files, remove unused dependencies, and standardise on one date library.

### Phase 4: decomposition (alongside features, when touched)
- `pos/SaleTab.tsx` (620) → `useSaleCheckout` + the shared checkout components
- `composer/DocumentInspector.tsx` (853) → an inspector registry per block type
- `artists/ArtistFormPage.tsx` (601) → `useArtistDraft` / `useArtistCommands`
- `marketing/emails/EmailDesignerPage.tsx` (535) → `useEmailDraft`
- `tickets/inbox/TicketsInbox.tsx` (477) and `CustomerPanel.tsx` (511) → filter, selection and actions hooks
- `features/auth/TermsContent.tsx` (881) → locale markdown

### Tests that go with the plan
For each Phase 0–1 slice, add a test that reproduces the bug first. Priority order: subscription cross-shop rejection; negative tender rejected; ServiceModal date round-trip; wizard validation; voucher deduction; consent DTO shape.

## Open questions for the owner
1. Is the API server (port 4000) directly reachable from the internet? That decides how urgent C2 is (the reviewer assumed yes, because Expo calls it directly).
2. Should *any* staff member be able to manage billing, or only owners? The server currently uses `requireStaff`.
3. Do existing services already have 2001 availability dates (H5)? Run a read-only count before repairing.
4. Does Render add security headers at the edge?
5. Should autosave ever write to live automations?
6. Is there a release target date for the web rebuild?
