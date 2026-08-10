/**
 * Real browser QA — four end-to-end loan-case scenarios driven entirely
 * through the AOS UI (no store/domain calls). Each case is created fresh via
 * New Case, its customer profile is edited, its case facts are set through
 * the "Edit facts" dialog, and the generated document checklist is inspected
 * for business sense, then one document is uploaded and viewed.
 */
import { test, expect } from "@playwright/test";
import {
  USERS,
  advanceToDocumentsPending,
  createCaseThroughUi,
  dialogButton,
  documentRow,
  fixture,
  gotoTab,
  sectionButton,
  switchUser,
  uploadForRow,
} from "../support/helpers";

/* ===========================================================================
 * SUSPENDED BY STAGE 3B — not deleted, and not passing.
 *
 * These specs drive the prototype as it was before the customer/case slice
 * moved to PostgreSQL. Two things they depend on no longer exist:
 *
 *   1. They sign in as `seed.ts` employees (Priya Raman, Karthik V, …), who
 *      lived in one browser's localStorage. Authentication is server-side now,
 *      so those accounts cannot be signed in to at all.
 *   2. Most of them then drive the old case screen's Documents, Banks and
 *      Timeline tabs, which are marked not-yet-migrated on an API-backed case.
 *
 * They are skipped rather than deleted because the FEATURES they cover —
 * document collection, verification, bank submission, the timeline — have not
 * been removed from the product; they are waiting for their own slice to move.
 * When it does, these are the tests it has to satisfy, and they will be
 * rewritten against the seeded accounts in `tests/support/e2e-globalsetup.ts`
 * rather than reinvented.
 *
 * A red suite people learn to ignore is the worst outcome available, which is
 * why this is an explicit skip with a reason and not a known failure.
 * ===========================================================================
 */

test.describe.configure({ mode: "serial" });
test.skip(true, "Suspended by Stage 3B — see the note at the top of this file.");

test.describe("Case 1 — Business / Machinery Loan (₹65,00,000, GST, existing loan)", () => {
  test("create, edit customer, set facts, checklist, upload, navigate, persist", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Ravi Kumar Machinery",
      phone: "9843120001",
      loanTypeLabel: "Business Loan · Machinery",
      amount: "6500000",
    });
    await expect(page).toHaveURL(caseUrl);
    // "Ravi Kumar Machinery" also appears in the "People on this case" list — scope to the
    // case-title heading, the intended assertion target.
    await expect(page.getByRole("heading", { level: 1 }).getByText("Ravi Kumar Machinery")).toBeVisible();
    await expect(page.getByText(/AL-\d{4}-\d{5}/)).toBeVisible();

    // Requirements only become due — with an Upload control — once the case reaches
    // "Documents Pending"; a fresh "New" case shows everything as "not due yet".
    await advanceToDocumentsPending(page);

    // --- Edit the customer profile through the UI ---
    await page.getByRole("heading", { level: 1 }).getByRole("link").click();
    await page.waitForURL(/\/people\//);
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Full name").fill("Ravi Kumar (Machinery Works)");
    await page.getByLabel("Address").fill("14 Mettupalayam Road");
    await page.getByLabel("City").fill("Coimbatore");
    await page.getByLabel("State").fill("Tamil Nadu");
    await page.getByLabel("PIN code").fill("641001");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.goto(caseUrl);

    // --- Case facts: GST yes, existing obligations yes ---
    await page.getByRole("button", { name: "Edit facts" }).click();
    await page.getByLabel("Is the business registered under GST?").selectOption({ label: "Yes" });
    await page.getByLabel("Is anyone on this file already servicing a loan?").selectOption({ label: "Yes" });
    // The page's own stage-footer "Save & continue" coexists with this one; scope to the
    // open Edit-facts dialog.
    await dialogButton(page, "Save & continue").click();
    // This button (CaseDetail.tsx EditFactsDialog) commits and closes the dialog without a
    // toast — only "Save draft" shows one. Assert the saved facts themselves (the case-facts
    // <dt>/<dd> pairs) instead of a toast this action never fires.
    const gstTerm = page.getByText("GST registered", { exact: true });
    await expect(gstTerm.locator("xpath=following-sibling::*[1]")).toHaveText("Yes");
    const obligationsTerm = page.getByText("Existing obligations", { exact: true });
    await expect(obligationsTerm.locator("xpath=following-sibling::*[1]")).toHaveText("Yes");

    // --- Existing loans and EMIs: add another lender + statement ---
    await expect(page.getByText("Yes — already servicing a loan")).toBeVisible();
    await page.getByRole("button", { name: "+ Another loan" }).click();
    await page.getByLabel("Who is the loan with?").fill("HDFC Bank");
    await page.getByRole("button", { name: "Add the statement" }).click();
    await expect(page.getByText(/Existing Loan Statement — HDFC Bank added/)).toBeVisible();

    // --- Documents tab: checklist must include GST + machinery-specific docs ---
    await gotoTab(page, "documents");
    await expect(page.getByText("GST", { exact: false }).first()).toBeVisible();
    const machineryRow = documentRow(page, "Machinery");
    // A machinery/business loan checklist must ask for a machinery-related document.
    await expect(machineryRow).toBeVisible();
    await expect(documentRow(page, "Existing Loan Statement")).toBeVisible();
    // Since GST=Yes was recorded, the checklist must not show a bare N/A GST row.
    await expect(page.getByText(/Not Applicable/).and(page.getByText(/GST/))).toHaveCount(0);

    // --- Upload the PAN document, confirm UI + storage + view ---
    // "PAN" substring-matches both "PAN Card" and "Business PAN Card" on a business-loan
    // checklist; exact matching pins this to the applicant's own PAN card.
    await uploadForRow(page, "PAN Card", fixture("pan-card.pdf"), undefined, { exact: true });
    await expect(page.getByText(/pan-card\.pdf uploaded/)).toBeVisible();
    const panRow = documentRow(page, "PAN Card", { exact: true });
    await expect(panRow.getByText(/pan-card\.pdf/)).toBeVisible();
    await expect(panRow.getByText(/Awaiting verification|Uploaded/i)).toBeVisible();

    await panRow.getByRole("button", { name: "View" }).click();
    // ViewDocumentDialog (CaseDetail.tsx) titles the modal with the document type's own
    // name — "PAN Card" here — not the separate verify-flow's "Verify: PAN Card"
    // dialog, which only appears from a login executive's "Verify" action.
    await expect(page.getByRole("heading", { name: "PAN Card" })).toBeVisible();
    await page.getByRole("button", { name: /Close|Not now/i }).first().click();

    // --- Save an incomplete case and continue: partial upload state must survive navigation ---
    await gotoTab(page, "overview");
    await expect(page.getByText(/Originated by/)).toBeVisible();
    await gotoTab(page, "banks");
    await gotoTab(page, "timeline");
    await expect(page.getByText(/Case opened|opened/i).first()).toBeVisible();

    // Navigate backwards and confirm data persists.
    await gotoTab(page, "documents");
    await expect(panRow.getByText(/pan-card\.pdf/)).toBeVisible();
    await gotoTab(page, "overview");
    await expect(page.getByText("Yes — already servicing a loan")).toBeVisible();
  });
});

test.describe("Case 2 — Home Loan (₹50,00,000, salaried, no GST)", () => {
  test("create, edit customer, set facts, checklist has no GST rows, upload, navigate", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Meena Sundaram",
      phone: "9843120002",
      loanTypeLabel: "Home Loan · Purchase",
      amount: "5000000",
    });
    await expect(page).toHaveURL(caseUrl);

    // Requirements only become due — with an Upload control — once the case reaches
    // "Documents Pending"; a fresh "New" case shows everything as "not due yet".
    await advanceToDocumentsPending(page);

    await page.getByRole("heading", { level: 1 }).getByRole("link").click();
    await page.waitForURL(/\/people\//);
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Full name").fill("Meena Sundaram");
    await page.getByLabel("Address").fill("7 Race Course Road");
    await page.getByLabel("City").fill("Coimbatore");
    await page.getByLabel("State").fill("Tamil Nadu");
    await page.getByLabel("PIN code").fill("641018");
    await page.getByRole("button", { name: "Save" }).click();
    await page.goto(caseUrl);

    // Income-proof documents are asked for by employment type (CaseDetail.tsx
    // PartyProfileDialog: "Salaried is asked for payslips and Form 16; self-employed for an
    // ITR"). This scenario is a salaried applicant, so record that on the case party — an
    // unset employment type generates no income-proof requirement at all, salaried or not.
    await page.getByRole("listitem").filter({ hasText: "Meena Sundaram" }).getByRole("button", { name: "Profile" }).click();
    await page.getByLabel("Employment type").selectOption({ label: "Salaried" });
    await dialogButton(page, "Save & continue").click();

    await page.getByRole("button", { name: "Edit facts" }).click();
    await page.getByLabel("Is the business registered under GST?").selectOption({ label: "No" });
    await page.getByLabel("Is anyone on this file already servicing a loan?").selectOption({ label: "No" });
    // Scoped to the open Edit-facts dialog — the page's stage-footer button shares this name.
    await dialogButton(page, "Save & continue").click();

    // Property required for a purchase home loan. The "Property" section's own "Add
    // property" is scoped separately from the identically-labelled quick action in the
    // case summary toolbar above it.
    await sectionButton(page, "Property", "Add property").click();
    await page.getByLabel("Locality").fill("Race Course");
    await page.getByLabel("City").fill("Coimbatore");
    await dialogButton(page, "Save & continue").click();
    await expect(page.getByText(/Property added/)).toBeVisible();

    await gotoTab(page, "documents");
    // A salaried, no-GST home loan should not surface GST or business documents.
    await expect(page.getByText("GST Certificate", { exact: false })).toHaveCount(0);
    await expect(documentRow(page, "Income Proof").or(documentRow(page, "Salary"))).toBeVisible();
    // Property-backed checklist: title/encumbrance style property docs must appear.
    await expect(page.locator("li").filter({ hasText: /Property|Title|Encumbrance/i }).first()).toBeVisible();

    await uploadForRow(page, "PAN Card", fixture("pan-card.pdf"), undefined, { exact: true });
    await expect(page.getByText(/pan-card\.pdf uploaded/)).toBeVisible();

    await gotoTab(page, "overview");
    await gotoTab(page, "documents");
    await expect(documentRow(page, "PAN Card", { exact: true }).getByText(/pan-card\.pdf/)).toBeVisible();
  });
});

test.describe("Case 3 — Smaller GST-registered Business Loan (existing loan)", () => {
  test("create, edit customer, set facts, checklist, upload, existing loan statement", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Suresh Textiles Owner",
      phone: "9843120003",
      loanTypeLabel: "Business Loan · Unsecured",
      amount: "800000",
    });
    await expect(page).toHaveURL(caseUrl);

    // Requirements only become due — with an Upload control — once the case reaches
    // "Documents Pending"; a fresh "New" case shows everything as "not due yet".
    await advanceToDocumentsPending(page);

    await page.getByRole("heading", { level: 1 }).getByRole("link").click();
    await page.waitForURL(/\/people\//);
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Full name").fill("Suresh (Textiles)");
    await page.getByLabel("Address").fill("21 Trichy Road");
    await page.getByLabel("City").fill("Coimbatore");
    await page.getByLabel("State").fill("Tamil Nadu");
    await page.getByLabel("PIN code").fill("641005");
    await page.getByRole("button", { name: "Save" }).click();
    await page.goto(caseUrl);

    await page.getByRole("button", { name: "Edit facts" }).click();
    await page.getByLabel("Is the business registered under GST?").selectOption({ label: "Yes" });
    await page.getByLabel("Is anyone on this file already servicing a loan?").selectOption({ label: "Yes" });
    // Scoped to the open Edit-facts dialog — the page's stage-footer button shares this name.
    await dialogButton(page, "Save & continue").click();

    await page.getByRole("button", { name: "+ Another loan" }).click();
    await page.getByLabel("Who is the loan with?").fill("Bajaj Finserv");
    await page.getByRole("button", { name: "Add the statement" }).click();
    await expect(page.getByText(/Existing Loan Statement — Bajaj Finserv added/)).toBeVisible();

    await gotoTab(page, "documents");
    await expect(page.getByText("GST", { exact: false }).first()).toBeVisible();
    await expect(documentRow(page, "Existing Loan Statement — Bajaj Finserv")).toBeVisible();

    await uploadForRow(page, "GST", fixture("gst-certificate.pdf"));
    await expect(page.getByText(/gst-certificate\.pdf uploaded/)).toBeVisible();

    // Save an incomplete case (only one document uploaded) and continue via navigation.
    await gotoTab(page, "overview");
    await gotoTab(page, "documents");
    await expect(documentRow(page, "GST").getByText(/gst-certificate\.pdf/)).toBeVisible();
  });
});

test.describe("Case 4 — Property-backed / Land Collateral Loan", () => {
  test("create, add collateral property, checklist has property documents, upload", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Ganesh Property Owner",
      phone: "9843120004",
      loanTypeLabel: "Loan Against Property · Loan Against Property",
      amount: "3000000",
    });
    await expect(page).toHaveURL(caseUrl);

    // Requirements only become due — with an Upload control — once the case reaches
    // "Documents Pending"; a fresh "New" case shows everything as "not due yet".
    await advanceToDocumentsPending(page);

    await page.getByRole("heading", { level: 1 }).getByRole("link").click();
    await page.waitForURL(/\/people\//);
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Full name").fill("Ganesh (Property Owner)");
    await page.getByLabel("Address").fill("3 DB Road");
    await page.getByLabel("City").fill("Coimbatore");
    await page.getByLabel("State").fill("Tamil Nadu");
    await page.getByLabel("PIN code").fill("641002");
    await page.getByRole("button", { name: "Save" }).click();
    await page.goto(caseUrl);

    // The "Property" section's own "Add property" is scoped separately from the
    // identically-labelled quick action in the case summary toolbar above it.
    await sectionButton(page, "Property", "Add property").click();
    await page.getByLabel("Locality").fill("RS Puram");
    await page.getByLabel("City").fill("Coimbatore");
    const roleSelect = page.getByLabel("Role on this case");
    await roleSelect.selectOption({ value: "collateral" });
    // Scoped to the open Add-property dialog — the page's stage-footer button shares this name.
    await dialogButton(page, "Save & continue").click();
    await expect(page.getByText(/Property added/)).toBeVisible();

    await gotoTab(page, "documents");
    // Property/collateral must have produced property-specific requirement rows.
    const propertyRows = page.locator("li").filter({ hasText: /Title|Encumbrance|Patta|Property/i });
    await expect(propertyRows.first()).toBeVisible();
    expect(await propertyRows.count()).toBeGreaterThan(0);

    await uploadForRow(page, "PAN Card", fixture("pan-card.pdf"), undefined, { exact: true });
    await expect(page.getByText(/pan-card\.pdf uploaded/)).toBeVisible();

    // Save incomplete, navigate away and back — confirm the property and upload persist.
    await gotoTab(page, "overview");
    await expect(page.getByText(/Property on file/)).toBeVisible();
    await gotoTab(page, "documents");
    await expect(documentRow(page, "PAN Card", { exact: true }).getByText(/pan-card\.pdf/)).toBeVisible();
  });
});
