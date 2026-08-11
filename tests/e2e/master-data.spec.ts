/**
 * Master Data — document types, rejection reasons, document requirement
 * rules and thresholds — against PostgreSQL, through the real screens.
 *
 * STAGE 4 ITEM 4. Before this stage, `DocumentRules.tsx` and the Document
 * Types / Rejection Reasons sections of `MasterData.tsx` wrote to
 * `Frontend/src/fake/store.ts`'s `localStorage` blob — real, but invisible to
 * every other PC and to the real requirement engine. Every assertion here is
 * one that store could not have made honestly: a change made in one browser
 * is visible after a hard reload, and tampering with this browser's
 * `localStorage` cannot make the screen show anything other than what the
 * server holds.
 *
 * Products and Lenders are deliberately NOT exercised here — Item 4 keeps
 * them read-only; `tests/e2e/*` already covers the Banks tab reading them.
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

test.describe("Document Rules — reads and writes the office database", () => {
  test("a Manager edits a rule and it survives a hard reload", async ({ page }) => {
    await signIn(page, "e2e.manager");
    await page.getByRole("link", { name: "Document Rules" }).click();
    await expect(page.getByRole("heading", { name: "Document rules" })).toBeVisible();

    await page.getByPlaceholder("GST · patta · salaried · partnership · valuation").fill("PAN");
    const row = page.locator("li", { hasText: "PAN Card" }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();

    const dialog = page.getByRole("dialog", { name: "Edit rule" });
    const notes = dialog.getByLabel("Why this rule exists");
    const marker = `e2e note ${Date.now()}`;
    await notes.fill(marker);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Rule saved.")).toBeVisible();

    // A hard reload re-fetches from the server — no client-side cache to fool.
    await page.reload();
    await page.getByPlaceholder("GST · patta · salaried · partnership · valuation").fill("PAN");
    await expect(page.locator("li", { hasText: "PAN Card" }).first()).toContainText(marker);
  });

  test("a Telecaller has no Document Rules link, and the API refuses the write directly", async ({
    page,
  }) => {
    await signIn(page, "e2e.telecaller");
    await expect(page.getByRole("link", { name: "Document Rules" })).toHaveCount(0);

    const token = await page.evaluate(() => sessionStorage.getItem("aos.token"));
    const rules = await page.request.get("/api/master-data/document-rules", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rules.ok()).toBe(true);
    const [firstRule] = await rules.json();

    const refused = await page.request.put(`/api/master-data/document-rules/${firstRule.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { ...firstRule },
    });
    expect(refused.status()).toBe(403);
  });
});

test.describe("Master Data — Document Types and Rejection Reasons are server-authoritative", () => {
  test("localStorage cannot override what the screen shows", async ({ page }) => {
    await signIn(page, "e2e.manager");
    await page.getByRole("link", { name: "Master Data" }).click();
    await expect(page.getByRole("heading", { name: "Master Data" })).toBeVisible();

    // Document Types is the first section under System Master Data.
    await page.getByRole("button", { name: "Document Types" }).click();
    await page.getByPlaceholder("Search document types…").fill("PAN");
    const row = page.locator("li", { hasText: "PAN Card" }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Edit" }).click();

    const dialog = page.getByRole("dialog", { name: "Edit Document Type" });
    const marker = `Server description ${Date.now()}`;
    await dialog.getByLabel("Description").fill(marker);
    await dialog.getByRole("button", { name: "Save & continue" }).click();
    await expect(page.getByText("Document type updated.")).toBeVisible();

    // Tamper with this browser's own copy of the prototype store — the array
    // this screen used to read before Stage 4 Item 4.
    await page.evaluate(() => {
      const raw = localStorage.getItem("aos.prototype.v9");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const type of parsed.documentTypes ?? []) {
        if (type.code === "pan_card") type.description = "TAMPERED — should never be shown";
      }
      localStorage.setItem("aos.prototype.v9", JSON.stringify(parsed));
    });

    await page.reload();
    await page.getByRole("button", { name: "Document Types" }).click();
    await page.getByPlaceholder("Search document types…").fill("PAN");
    const reloadedRow = page.locator("li", { hasText: "PAN Card" }).first();
    await expect(reloadedRow).toContainText(marker);
    await expect(reloadedRow).not.toContainText("TAMPERED");
  });

  test("a Telecaller sees no edit controls, and the API refuses the write directly", async ({
    page,
  }) => {
    await signIn(page, "e2e.telecaller");
    // Telecaller holds master_data.read but not master_data.manage, so the
    // nav link itself is gated on manage (App.tsx) — reached by URL instead.
    await page.goto("/#/admin/master-data");
    await expect(page.getByText("This user can view but not edit")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);

    const token = await page.evaluate(() => sessionStorage.getItem("aos.token"));
    const reasons = await page.request.get("/api/master-data/rejection-reasons", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(reasons.ok()).toBe(true);
    const [firstReason] = await reasons.json();

    const refused = await page.request.put(
      `/api/master-data/rejection-reasons/${firstReason.id}/active`,
      { headers: { Authorization: `Bearer ${token}` }, data: { isActive: false } },
    );
    expect(refused.status()).toBe(403);
  });
});
