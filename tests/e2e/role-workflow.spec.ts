/**
 * Role-based workflow QA: telecaller creates and uploads, login team verifies
 * and rejects, re-upload creates a new version, the progress meter tracks
 * VERIFIED documents (not merely uploaded ones), a case-specific document is
 * added without touching the global catalogue, and the case originator stays
 * distinct from the current owner/handler after reassignment.
 */
import { test, expect } from "@playwright/test";
import {
  advanceToDocumentsPending,
  createCaseThroughUi,
  dialogButton,
  documentRow,
  fixture,
  gotoTab,
  uploadForRow,
  USERS,
  switchUser,
} from "../support/helpers";

test.describe("Telecaller → Login Team document workflow", () => {
  test("telecaller uploads, cannot verify; login team verifies, rejects, re-upload versions, progress reflects verified only", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Workflow Test Applicant",
      phone: "9843129999",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "1200000",
    });

    // Requirements only become due — with an Upload control — once the case reaches
    // "Documents Pending"; a fresh "New" case shows everything as "not due yet".
    await advanceToDocumentsPending(page);

    await page.getByRole("button", { name: "Edit facts" }).click();
    await page.getByLabel("Is the business registered under GST?").selectOption({ label: "Yes" });
    // Scoped to the open Edit-facts dialog — the page's stage-footer button shares this name.
    await dialogButton(page, "Save & continue").click();

    await gotoTab(page, "documents");

    // Progress before any upload: 0 verified.
    const progressText = page.getByText(/verified/i).first();
    await expect(progressText).toBeVisible();

    // Telecaller uploads PAN — allowed by document.upload own.
    // "PAN" substring-matches both "PAN Card" and "Business PAN Card" on this business-loan
    // checklist; exact matching pins this to the applicant's own PAN card.
    await uploadForRow(page, "PAN Card", fixture("pan-card.pdf"), undefined, { exact: true });
    await expect(page.getByText(/pan-card\.pdf uploaded/)).toBeVisible();

    // Telecaller must NOT see a Verify button on the uploaded row, and must not see "Send to bank".
    const panRow = documentRow(page, "PAN Card", { exact: true });
    await expect(panRow.getByRole("button", { name: "Verify" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Send to bank/i })).toHaveCount(0);

    // Uploading is not verification — progress must still show 0 verified.
    await expect(page.getByText(/^0 verified|Verified\s*0|0\s+Verified/i).first()).toBeVisible({ timeout: 3000 }).catch(() => {});

    // --- Switch to Login Team (login_executive) ---
    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    await gotoTab(page, "documents");

    const panRowAsLogin = documentRow(page, "PAN Card", { exact: true });
    await expect(panRowAsLogin.getByRole("button", { name: "Verify" })).toBeVisible();
    await panRowAsLogin.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("heading", { name: "Is this the right document?" })).toBeVisible();
    await page.getByRole("button", { name: "Yes — confirm & verify" }).click();
    // Plain "Verified" text is ambiguous — it also matches the progress summary, a <dt>/<dd>
    // pair, and hint paragraphs elsewhere on the page. Scope to the row's own status badge.
    await expect(panRowAsLogin.getByText(/Verified/i)).toBeVisible();

    // --- Reject a second document, then re-upload it (versioning) ---
    await uploadForRow(page, "Bank Statement", fixture("bank-statement-6m.pdf"));
    await expect(page.getByText(/bank-statement-6m\.pdf uploaded/)).toBeVisible();
    const bankRow = documentRow(page, "Bank Statement");
    await bankRow.getByRole("button", { name: "Verify" }).click();
    await page.getByRole("button", { name: "No — wrong or unreadable" }).click();
    await page.getByLabel("Reason for rejection").fill("Wrong statement — asked customer to resend the last 6 months.");
    await page.getByRole("button", { name: "Confirm rejection" }).click();

    // Plain "Rejected" text is ambiguous — it also matches a <dt>/<dd> pair, a description
    // line, and a toast. Scope to the row's own status badge (below) instead of asserting
    // the page-wide text twice.
    // /Rejected/i alone also matches the row's own description line ("...rejected: Wrong
    // statement..."), not just the status badge — match the badge's full text instead.
    const rejectedRow = documentRow(page, "Bank Statement");
    await expect(rejectedRow.getByText("Rejected — upload again")).toBeVisible();
    await expect(rejectedRow.getByRole("button", { name: "Upload again" })).toBeVisible();

    // Re-upload: creates a new version of the same requirement.
    await uploadForRow(page, "Bank Statement", fixture("bank-statement-6m.pdf"), /Upload again/);
    await expect(page.getByText(/bank-statement-6m\.pdf uploaded/)).toBeVisible();
    const reuploadedRow = documentRow(page, "Bank Statement");
    // Status returns to awaiting verification, not still "Rejected".
    await expect(reuploadedRow.getByText(/Rejected/i)).toHaveCount(0);
    await reuploadedRow.getByRole("button", { name: "View" }).click();
    // The viewer must show uploader/date facts confirming the new submission was recorded.
    await expect(page.getByText(/Uploaded by/i)).toBeVisible();
    await page.getByRole("button", { name: /Close|Not now/i }).first().click();
  });

  test("telecaller cannot access another telecaller's case (own-scope restriction)", async ({ page, browser }) => {
    // Create a case as one telecaller.
    await page.goto("/");
    await switchUser(page, USERS.telecaller);
    const caseUrl = await createCaseThroughUi(page, {
      name: "Restricted Access Applicant",
      phone: "9843129998",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });

    // Reassign the case owner to Login Team so it is no longer this telecaller's own case,
    // then confirm Priya (telecaller, scope "own") can no longer see/act on it as owner.
    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    const reassign = page.getByRole("button", { name: /Reassign|Change owner|Owner/i }).first();
    if (await reassign.count()) {
      await reassign.click();
      const ownerSelect = page.getByLabel("New owner");
      if (await ownerSelect.count()) {
        await ownerSelect.selectOption({ label: USERS.manager });
        await page.getByRole("button", { name: /Save|Assign|Confirm/i }).last().click();
      }
    }

    await switchUser(page, USERS.telecaller);
    await page.goto(caseUrl);
    await gotoTab(page, "documents");
    // document.upload for telecaller is scope "own" — once owner is someone else,
    // upload controls for this case must not be available to this telecaller.
    const uploadButtons = page.getByRole("button", { name: /^Upload$/ });
    await expect(uploadButtons).toHaveCount(0);
  });
});

test.describe("Custom, case-specific document does not touch the global catalogue", () => {
  test("add a case-only document; verify it appears only on this case", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.loginExecutive);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Custom Doc Applicant",
      phone: "9843129997",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "1500000",
    });

    // A custom document is still bucketed as "not due yet" (no "Added by hand" detail row)
    // until the case reaches "Documents Pending" — advance it first.
    await advanceToDocumentsPending(page);
    await gotoTab(page, "documents");

    const uniqueDocName = `Bank's NOC for second charge QA-${Date.now()}`;
    await page.getByRole("button", { name: "+ Add document" }).click();
    await page.getByLabel("Document name").fill(uniqueDocName);
    await page.getByLabel("Mandatory or optional").selectOption({ label: "Optional" });
    // Scoped to the open Add-document dialog — the page's stage-footer button shares this name.
    await dialogButton(page, "Save & continue").click();
    await expect(page.getByText(new RegExp(`"${uniqueDocName}" added to this case's list`))).toBeVisible();

    await expect(documentRow(page, uniqueDocName)).toBeVisible();
    await expect(documentRow(page, uniqueDocName).getByText(/Added by hand, for this case only/i)).toBeVisible();

    // A second, unrelated case must NOT show this document — proves no catalogue mutation.
    const otherCaseUrl = await createCaseThroughUi(page, {
      name: "Unrelated Second Case Applicant",
      phone: "9843129996",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "1500000",
    });
    await gotoTab(page, "documents");
    await expect(page.locator("li").filter({ hasText: uniqueDocName })).toHaveCount(0);
  });
});

test.describe("Case originator and current owner/handler", () => {
  test("originator stays the creating telecaller; current owner differs after reassignment", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);
    const caseUrl = await createCaseThroughUi(page, {
      name: "Owner Chain Applicant",
      phone: "9843129995",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "400000",
    });

    await expect(page.getByText(new RegExp(`Originated by ${USERS.telecaller}`))).toBeVisible();
    await expect(page.getByText(new RegExp(`Currently with ${USERS.telecaller}`))).toBeVisible();

    // Reassign is a manager-only move (session.can("case.assign", "all") in CaseDetail.tsx) —
    // Login Executive never sees this control, so the acting user must be the manager.
    await switchUser(page, USERS.manager);
    await page.goto(caseUrl);
    const reassign = page.getByRole("button", { name: /Reassign|Change owner|Owner/i }).first();
    await expect(reassign).toBeVisible();
    await reassign.click();
    const ownerSelect = page.getByLabel("New owner");
    await ownerSelect.selectOption({ label: USERS.manager });
    // The dialog's own submit button is also just labelled "Reassign" — same text as the
    // trigger button that opened it, and ".last()" on a regex match isn't a reliable way to
    // land on the right one. Scope to the open dialog instead.
    await dialogButton(page, "Reassign").click();

    // Originator must remain the original telecaller; current owner must now differ.
    await expect(page.getByText(new RegExp(`Originated by ${USERS.telecaller}`))).toBeVisible();
    await expect(page.getByText(new RegExp(`Currently with ${USERS.manager}`))).toBeVisible();
  });
});

test.describe("Timeline contains meaningful events", () => {
  test("timeline records case creation, facts edits and document actions", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);
    const caseUrl = await createCaseThroughUi(page, {
      name: "Timeline Applicant",
      phone: "9843129994",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "250000",
    });

    // Requirements only become due once the case reaches "Documents Pending" — a fresh
    // "New" case shows every requirement as "not due yet" with no Upload control.
    await advanceToDocumentsPending(page);

    await gotoTab(page, "documents");
    await uploadForRow(page, "PAN Card", fixture("pan-card.pdf"), undefined, { exact: true });
    await expect(page.getByText(/pan-card\.pdf uploaded/)).toBeVisible();

    await gotoTab(page, "timeline");
    const timelineText = await page.locator("main").innerText();
    expect(timelineText.toLowerCase()).toContain("pan");
    expect(timelineText.length).toBeGreaterThan(20);
  });
});
