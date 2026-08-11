/**
 * Production Readiness Phase 2 — "Admin-screen honesty".
 *
 * Products, Lenders, and the "simple" Master Data vocabulary sections still
 * display `Frontend/src/fake/store.ts` — a per-browser prototype dataset,
 * not the office database. Before this phase they also offered Add/Edit
 * forms that wrote to that same localStorage blob: real writes, invisible
 * to every other PC and to every real case. This suite asserts the fix —
 * no screen offers a write control it cannot honour, and every one of them
 * says plainly that it is not connected to the office database.
 *
 * Document Rules and the Document Types / Rejection Reasons / Thresholds
 * sections of Master Data are NOT covered here — they are genuinely
 * PostgreSQL-authoritative (Stage 4 Item 4) and keep their real edit
 * controls; see `tests/e2e/master-data.spec.ts`.
 */

import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/");
  const usernameField = page.locator('input[name="username"]');
  await expect(usernameField).toBeVisible();
  await usernameField.fill(username);
  await page.locator('input[name="password"]').fill("e2e-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "All Cases" })).toBeVisible();
}

test.describe("Products — read-only reference, not a configuration screen", () => {
  test("a Manager sees no write controls, and the not-connected banner", async ({ page }) => {
    await signIn(page, "e2e.manager");
    await page.getByRole("link", { name: "Products" }).click();
    await expect(page.getByRole("heading", { name: "Lending Products" })).toBeVisible();

    await expect(page.getByText("Not connected to the office database.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add product" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  });
});

test.describe("Lenders — read-only reference, not a configuration screen", () => {
  test("a Manager sees no write controls, and the not-connected banner", async ({ page }) => {
    await signIn(page, "e2e.manager");
    await page.getByRole("link", { name: "Lenders", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Lenders", exact: true })).toBeVisible();

    await expect(page.getByText("Not connected to the office database.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add lender" })).toHaveCount(0);

    // Expand the first lender and confirm none of its panels offer a write
    // control either — the nested Add/Edit surface was the largest part of
    // the Phase 2 problem.
    const firstLender = page.locator("ul > li").first();
    await firstLender.getByRole("button").first().click();
    await expect(page.getByRole("button", { name: "Edit lender" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add branch" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add contact" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add what we know" })).toHaveCount(0);
  });
});

test.describe("Master Data — the still-local sections are read-only", () => {
  test("a Manager sees no Add control on Employment Types, unlike Document Types", async ({
    page,
  }) => {
    await signIn(page, "e2e.manager");
    await page.getByRole("link", { name: "Master Data" }).click();
    await expect(page.getByRole("heading", { name: "Master Data" })).toBeVisible();

    // Employment Types is a "simple" section — still local, no write UI.
    await page.getByRole("button", { name: "Employment Types" }).click();
    await expect(page.getByText("Not connected to the office database.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);

    // Document Types, on the same screen, is genuinely server-authoritative
    // and keeps its real Edit control — the fix did not overcorrect.
    await page.getByRole("button", { name: "Document Types" }).click();
    await expect(page.getByText("Not connected to the office database.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit", exact: true }).first()).toBeVisible();
  });
});
