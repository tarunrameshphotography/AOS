/**
 * Workflow Polish milestone — real-browser QA for the usability fixes made
 * against the audit findings (see the milestone's approved plan). Each test
 * exercises one finding's fix through the actual UI, not the store directly.
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

test.describe("New Case — disabled 'Open case' explains itself", () => {
  test("shows why the button will not respond, and the reason clears once fixed", async ({ page }) => {
    await page.goto("/#/cases/new");
    await expect(page.getByRole("heading", { name: "New case" })).toBeVisible();

    // Nothing typed yet — Loan type defaults to the first product, so the only
    // thing missing is a name.
    await expect(page.getByText("Add a customer name to open this case.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open case" })).toBeDisabled();

    await page.getByLabel("Name").fill("Reason Text Applicant");
    await expect(page.getByText("Add a customer name to open this case.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open case" })).toBeEnabled();
  });
});

test.describe("Customer Profile — disabled 'Add' explains itself", () => {
  test("Add Identifier states the minimum length before it will accept a value", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Profile Validation Applicant",
      phone: "9843129001",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await page.goto(caseUrl);
    await page.getByRole("heading", { level: 1 }).getByRole("link").click();
    await page.waitForURL(/\/people\//);

    await page.getByRole("button", { name: "Add phone or email" }).click();
    await expect(
      page.getByText(/Enter at least 3 characters for the (phone number|email address)\./),
    ).toBeVisible();
    await expect(dialogButton(page, "Add")).toBeDisabled();

    await page.getByLabel("Value").fill("9000000001");
    await expect(page.getByText(/Enter at least 3 characters/)).toHaveCount(0);
    await expect(dialogButton(page, "Add")).toBeEnabled();
  });
});

test.describe("Banks — empty state is permission-aware", () => {
  test("tells a Telecaller Login Desk handles bank submission, and shows Add Bank to Login Desk", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Banks Empty State Applicant",
      phone: "9843129002",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await switchUser(page, USERS.telecaller);
    await page.goto(caseUrl);
    await gotoTab(page, "banks");

    await expect(
      page.getByText("No bank added yet. Bank selection and submission are handled by Login Desk"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Bank" })).toHaveCount(0);

    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    await gotoTab(page, "banks");
    await expect(page.getByText("No bank added to this file yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Bank" })).toBeVisible();
  });
});

test.describe("Save & continue — confirms without breaking navigation", () => {
  test("shows a toast and still moves to the next tab", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Save Continue Applicant",
      phone: "9843129003",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await page.goto(caseUrl);

    await page.getByRole("button", { name: "Save & continue" }).click();
    await expect(
      page.getByText(/Nothing was waiting|Saved your/),
    ).toBeVisible();
    // Navigation still happened — Documents is now the active tab.
    await expect(page).toHaveURL(/tab=documents/);
  });
});

test.describe("Verify dialog — names the document", () => {
  test("titles itself with the document, not a generic question", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Verify Title Applicant",
      phone: "9843129004",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await advanceToDocumentsPending(page);
    await gotoTab(page, "documents");
    await uploadForRow(page, "PAN Card", fixture("pan-card.pdf"), undefined, { exact: true });

    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    await gotoTab(page, "documents");
    const panRow = documentRow(page, "PAN Card", { exact: true });
    await panRow.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("heading", { name: "Verify: PAN Card" })).toBeVisible();
  });
});

test.describe("Permission refusals — plain language, technical code tucked away", () => {
  test("masked PAN explains itself in plain language, with the permission code behind a disclosure", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Masked Pan Applicant",
      phone: "9843129005",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await switchUser(page, USERS.telecaller);
    await page.goto(caseUrl);
    await page.getByRole("heading", { level: 1 }).getByRole("link").click();
    await page.waitForURL(/\/people\//);

    await expect(page.getByText("Full PAN is only visible to Login Desk and above.")).toBeVisible();
    // The raw permission key is not visible by default — it sits inside a
    // closed native <details>, present in the DOM but not on screen...
    await expect(page.getByText("identifier.view_full", { exact: true })).toBeHidden();
    // ...but is still reachable for support/training, behind the disclosure.
    await page.getByText("Technical detail").click();
    await expect(page.getByText("identifier.view_full", { exact: true })).toBeVisible();
  });
});

test.describe("Telecaller attention — rejected documents surface on the home screen", () => {
  test("a rejected document appears in 'Rejected — needs your follow-up' for its telecaller", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Rejected Followup Applicant",
      phone: "9843129006",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await advanceToDocumentsPending(page);
    await gotoTab(page, "documents");
    await uploadForRow(page, "PAN Card", fixture("pan-card.pdf"), undefined, { exact: true });

    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    await gotoTab(page, "documents");
    const panRow = documentRow(page, "PAN Card", { exact: true });
    await panRow.getByRole("button", { name: "Verify" }).click();
    await page.getByRole("button", { name: "No — wrong or unreadable" }).click();
    await page.getByLabel("Reason for rejection").fill("Blurry — ask for a clearer photo.");
    await page.getByRole("button", { name: "Confirm rejection" }).click();

    await switchUser(page, USERS.telecaller);
    await page.goto("/");
    await expect(page.getByText("Rejected — needs your follow-up")).toBeVisible();
    await expect(page.getByText("PAN Card").first()).toBeVisible();
    await expect(page.getByText("Blurry — ask for a clearer photo.")).toBeVisible();
  });
});

test.describe("Waiting on — distinct from Currently with", () => {
  test("appears on the case header and changes once a document is rejected", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Waiting On Applicant",
      phone: "9843129007",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await advanceToDocumentsPending(page);
    await gotoTab(page, "documents");
    await uploadForRow(page, "PAN Card", fixture("pan-card.pdf"), undefined, { exact: true });

    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    await expect(page.getByText(/Waiting on: .*awaiting verification/)).toBeVisible();

    await gotoTab(page, "documents");
    const panRow = documentRow(page, "PAN Card", { exact: true });
    await panRow.getByRole("button", { name: "Verify" }).click();
    await page.getByRole("button", { name: "No — wrong or unreadable" }).click();
    await page.getByLabel("Reason for rejection").fill("Unreadable scan.");
    await page.getByRole("button", { name: "Confirm rejection" }).click();

    await page.goto(caseUrl);
    await expect(page.getByText(/Waiting on: .*rejected/)).toBeVisible();
  });
});

test.describe("Reassign dialog — trigger and confirm are no longer the same label", () => {
  test("confirm button reads 'Confirm reassignment'", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Reassign Label Applicant",
      phone: "9843129008",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await switchUser(page, USERS.manager);
    await page.goto(caseUrl);
    await page.getByRole("button", { name: "Reassign" }).click();
    await expect(dialogButton(page, "Confirm reassignment")).toBeVisible();
  });
});

test.describe("Fresh case completeness — 'Not started' instead of a bare dash", () => {
  test("a brand-new case reads 'Not started' rather than '—'", async ({ page }) => {
    const caseUrl = await createCaseThroughUi(page, {
      name: "Fresh Completeness Applicant",
      phone: "9843129009",
      loanTypeLabel: "Personal Loan · Personal Loan",
      amount: "300000",
    });
    await page.goto(caseUrl);
    await expect(page.getByText("Not started")).toBeVisible();
  });
});
