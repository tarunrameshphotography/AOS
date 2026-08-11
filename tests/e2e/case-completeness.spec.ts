/**
 * Phase 4 acceptance — case completeness, driven through the real UI.
 *
 * Proves the workflow the roadmap named as missing: a Login Executive adds a
 * co-applicant, a guarantor and a property to an existing case, and waives a
 * requirement — each through the Case Detail screen, each persisted in
 * PostgreSQL (survives a reload and is visible from a second session), never
 * through localStorage.
 */

import { expect, test, type Page } from "@playwright/test";

import { E2E_PASSWORD } from "../support/e2e-globalsetup.js";

const LOGIN_EXECUTIVE = "e2e.loginexec";

function unique(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
}

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/");
  const usernameField = page.locator('input[name="username"]');
  await expect(usernameField).toBeVisible();
  await usernameField.fill(username);
  await page.locator('input[name="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "All Cases" })).toBeVisible();
}

async function openCase(page: Page, applicantName: string): Promise<string> {
  await page.goto("/#/cases/new");
  await page.locator('input[name="applicantName"]').fill(applicantName);
  await page.locator('input[name="applicantPhone"]').fill("9843012345");
  await page.getByRole("button", { name: "Open case" }).click();
  const heading = page.locator("h1.tnum").first();
  await expect(heading).toContainText(/^AL-\d{4}-\d{5}$/);
  return page.url();
}

test.describe("case completeness (Phase 4)", () => {
  test("adds a co-applicant, a guarantor and a property, all surviving a reload", async ({ page }) => {
    await signIn(page, LOGIN_EXECUTIVE);
    const applicant = unique("Ravi");
    const caseUrl = await openCase(page, applicant);

    // The applicant is on the case from the start.
    await expect(page.getByText(applicant).first()).toBeVisible();

    // Add a co-applicant, created inline.
    await page.getByRole("button", { name: /Add co-applicant/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Role").selectOption("co_applicant");
    const coApplicant = unique("Priya");
    await dialog.locator('input[name="applicantName"]').fill(coApplicant);
    await dialog.locator('input[name="applicantPhone"]').fill("9840000010");
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(coApplicant)).toBeVisible();
    await expect(page.getByText("Co-applicant added.")).toBeVisible();

    // Add a guarantor.
    await page.getByRole("button", { name: /Add co-applicant/ }).click();
    await dialog.getByLabel("Role").selectOption("guarantor");
    const guarantor = unique("Karthik");
    await dialog.locator('input[name="applicantName"]').fill(guarantor);
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(guarantor)).toBeVisible();
    await expect(page.getByText("Guarantor added.")).toBeVisible();

    // Add a property — this account holds property.create.
    await page.getByRole("button", { name: "Add property…" }).click();
    await dialog.getByLabel("Locality").fill("Race Course");
    await dialog.getByLabel("City").fill("Coimbatore");
    await dialog.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("Race Course")).toBeVisible();

    // Survives a reload — real PostgreSQL, not component state.
    await page.reload();
    await expect(page.getByText(coApplicant)).toBeVisible();
    await expect(page.getByText(guarantor)).toBeVisible();
    await expect(page.getByText("Race Course")).toBeVisible();

    // A second, independent session sees the same composition.
    const secondContext = await page.context().browser()!.newContext();
    const secondPage = await secondContext.newPage();
    await signIn(secondPage, LOGIN_EXECUTIVE);
    await secondPage.goto(caseUrl);
    await expect(secondPage.getByText(coApplicant)).toBeVisible();
    await expect(secondPage.getByText(guarantor)).toBeVisible();
    await expect(secondPage.getByText("Race Course")).toBeVisible();
    await secondContext.close();
  });

  test("waives a requirement with a reason, and it stays visible as waived after a reload", async ({
    page,
  }) => {
    await signIn(page, LOGIN_EXECUTIVE);
    await openCase(page, unique("Waiver"));

    // Move the case into document collection so requirements exist.
    await page.getByRole("button", { name: "Move stage" }).click();
    await page.getByRole("dialog").getByRole("combobox").selectOption("contacted");
    await page.getByRole("dialog").getByRole("button", { name: "Move" }).click();
    await page.getByRole("button", { name: "Move stage" }).click();
    await page.getByRole("dialog").getByRole("combobox").selectOption("documents_pending");
    await page.getByRole("dialog").getByRole("button", { name: "Move" }).click();

    await page.getByRole("button", { name: "Documents" }).click();
    const waiveButton = page.getByRole("button", { name: "Waive" }).first();
    await expect(waiveButton).toBeVisible();
    await waiveButton.click();

    const waiveDialog = page.getByRole("dialog");
    await waiveDialog.getByLabel("Reason").fill("Bank agreed to proceed without this document");
    await waiveDialog.getByRole("button", { name: "Confirm waiver" }).click();

    await expect(page.getByText("Waived", { exact: true }).first()).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Documents" }).click();
    await expect(page.getByText("Waived", { exact: true }).first()).toBeVisible();
  });
});
