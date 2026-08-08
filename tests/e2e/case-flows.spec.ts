/**
 * Real browser QA — four end-to-end loan-case scenarios driven entirely
 * through the AOS UI (no store/domain calls). Each case is created fresh via
 * New Case, its customer profile is edited, its case facts are set through
 * the "Edit facts" dialog, and the generated document checklist is inspected
 * for business sense, then one document is uploaded and viewed.
 */
import { test, expect } from "@playwright/test";
import {
  createCaseThroughUi,
  documentRow,
  fixture,
  gotoTab,
  uploadForRow,
} from "../support/helpers";

test.describe("Case 1 — Business / Machinery Loan (₹65,00,000, GST, existing loan)", () => {
  test("create, edit customer, set facts, checklist, upload, navigate, persist", async ({ page }) => {
    await page.goto("/");

    const caseUrl = await createCaseThroughUi(page, {
      name: "Ravi Kumar Machinery",
      phone: "9843120001",
      loanTypeLabel: "Business Loan · Machinery",
      amount: "6500000",
    });
    await expect(page).toHaveURL(caseUrl);
    await expect(page.getByText("Ravi Kumar Machinery")).toBeVisible();
    await expect(page.getByText(/AL-\d{4}-\d{5}/)).toBeVisible();

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
    await page.getByRole("button", { name: "Save & continue" }).click();
    await expect(page.getByText("Saved. The documents list has already changed.")).toBeVisible();

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
    await uploadForRow(page, "PAN", fixture("pan-card.pdf"));
    await expect(page.getByText(/pan-card\.pdf uploaded/)).toBeVisible();
    const panRow = documentRow(page, "PAN");
    await expect(panRow.getByText(/pan-card\.pdf/)).toBeVisible();
    await expect(panRow.getByText(/Awaiting verification|Uploaded/i)).toBeVisible();

    await panRow.getByRole("button", { name: "View" }).click();
    await expect(page.getByRole("heading", { name: /Is this the right document\?|pan-card/i })).toBeVisible();
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

    const caseUrl = await createCaseThroughUi(page, {
      name: "Meena Sundaram",
      phone: "9843120002",
      loanTypeLabel: "Home Loan · Purchase",
      amount: "5000000",
    });
    await expect(page).toHaveURL(caseUrl);

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

    await page.getByRole("button", { name: "Edit facts" }).click();
    await page.getByLabel("Is the business registered under GST?").selectOption({ label: "No" });
    await page.getByLabel("Is anyone on this file already servicing a loan?").selectOption({ label: "No" });
    await page.getByRole("button", { name: "Save & continue" }).click();

    // Property required for a purchase home loan.
    await page.getByRole("button", { name: "Add property" }).click();
    await page.getByLabel("Locality").fill("Race Course");
    await page.getByLabel("City").fill("Coimbatore");
    await page.getByRole("button", { name: "Save & continue" }).click();
    await expect(page.getByText(/Property added/)).toBeVisible();

    await gotoTab(page, "documents");
    // A salaried, no-GST home loan should not surface GST or business documents.
    await expect(page.getByText("GST Certificate", { exact: false })).toHaveCount(0);
    await expect(documentRow(page, "Income Proof").or(documentRow(page, "Salary"))).toBeVisible();
    // Property-backed checklist: title/encumbrance style property docs must appear.
    await expect(page.locator("li").filter({ hasText: /Property|Title|Encumbrance/i }).first()).toBeVisible();

    await uploadForRow(page, "PAN", fixture("pan-card.pdf"));
    await expect(page.getByText(/pan-card\.pdf uploaded/)).toBeVisible();

    await gotoTab(page, "overview");
    await gotoTab(page, "documents");
    await expect(documentRow(page, "PAN").getByText(/pan-card\.pdf/)).toBeVisible();
  });
});

test.describe("Case 3 — Smaller GST-registered Business Loan (existing loan)", () => {
  test("create, edit customer, set facts, checklist, upload, existing loan statement", async ({ page }) => {
    await page.goto("/");

    const caseUrl = await createCaseThroughUi(page, {
      name: "Suresh Textiles Owner",
      phone: "9843120003",
      loanTypeLabel: "Business Loan · Unsecured",
      amount: "800000",
    });
    await expect(page).toHaveURL(caseUrl);

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
    await page.getByRole("button", { name: "Save & continue" }).click();

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

    const caseUrl = await createCaseThroughUi(page, {
      name: "Ganesh Property Owner",
      phone: "9843120004",
      loanTypeLabel: "Loan Against Property · Loan Against Property",
      amount: "3000000",
    });
    await expect(page).toHaveURL(caseUrl);

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

    await page.getByRole("button", { name: "Add property" }).click();
    await page.getByLabel("Locality").fill("RS Puram");
    await page.getByLabel("City").fill("Coimbatore");
    const roleSelect = page.getByLabel("Role on this case");
    await roleSelect.selectOption({ value: "collateral" });
    await page.getByRole("button", { name: "Save & continue" }).click();
    await expect(page.getByText(/Property added/)).toBeVisible();

    await gotoTab(page, "documents");
    // Property/collateral must have produced property-specific requirement rows.
    const propertyRows = page.locator("li").filter({ hasText: /Title|Encumbrance|Patta|Property/i });
    await expect(propertyRows.first()).toBeVisible();
    expect(await propertyRows.count()).toBeGreaterThan(0);

    await uploadForRow(page, "PAN", fixture("pan-card.pdf"));
    await expect(page.getByText(/pan-card\.pdf uploaded/)).toBeVisible();

    // Save incomplete, navigate away and back — confirm the property and upload persist.
    await gotoTab(page, "overview");
    await expect(page.getByText(/Property on file/)).toBeVisible();
    await gotoTab(page, "documents");
    await expect(documentRow(page, "PAN").getByText(/pan-card\.pdf/)).toBeVisible();
  });
});
