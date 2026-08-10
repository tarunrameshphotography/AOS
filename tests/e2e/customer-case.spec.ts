/**
 * Stage 3B acceptance — the migrated customer and case slice, in a browser.
 *
 * These are the tests that answer the question the stage was set: does the
 * application, driven through its own UI, read and write PostgreSQL rather
 * than the browser's own storage?
 *
 * The ones worth reading are the last three. Two independent browser contexts
 * see the same case; a Telecaller cannot reach a colleague's case by typing
 * its URL; and data survives clearing localStorage entirely. None of those
 * could have passed before this stage — the first because each tab had its own
 * database, the second because the check ran in the tab that wanted to bypass
 * it, and the third because localStorage WAS the database.
 */

import { expect, test, type Page } from "@playwright/test";

import { E2E_PASSWORD } from "../support/e2e-globalsetup.js";

const TELECALLER = "e2e.telecaller";
const OTHER_TELECALLER = "e2e.telecaller2";
const MANAGER = "e2e.manager";

/** A name nothing else in the database will collide with. */
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
  // The top bar only renders inside an authenticated session.
  await expect(page.getByRole("link", { name: "All Cases" })).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.locator("header button").last().click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator('input[name="username"]')).toBeVisible();
}

/** Opens a case through the UI and returns its number and URL. */
async function openCase(page: Page, applicantName: string): Promise<{ number: string; url: string }> {
  await page.goto("/#/cases/new");
  await page.locator('input[name="applicantName"]').fill(applicantName);
  await page.locator('input[name="applicantPhone"]').fill("9843012345");
  await page.locator('input[name="requestedAmount"]').fill("3500000");
  await page.getByRole("button", { name: "Open case" }).click();

  // Landing on the case screen is the assertion: the number was allocated by
  // the server and the redirect used the id it returned.
  const heading = page.locator("h1.tnum").first();
  await expect(heading).toContainText(/^AL-\d{4}-\d{5}$/);
  return { number: (await heading.textContent()) ?? "", url: page.url() };
}

// ---------------------------------------------------------------------------

test.describe("authentication against the backend", () => {
  test("signs in with a real account and refuses a wrong password", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[name="username"]').fill(TELECALLER);
    await page.locator('input[name="password"]').fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toContainText("Incorrect username or password");
    await expect(page.getByRole("link", { name: "All Cases" })).toHaveCount(0);

    await page.locator('input[name="password"]').fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("link", { name: "All Cases" })).toBeVisible();
  });

  test("a refresh keeps the session", async ({ page }) => {
    await signIn(page, TELECALLER);
    await page.reload();

    // Straight back into the app, no login form in between.
    await expect(page.getByRole("link", { name: "All Cases" })).toBeVisible();
    await expect(page.locator('input[name="username"]')).toHaveCount(0);
  });

  test("logging out invalidates the session on the server, not just this tab", async ({ page }) => {
    await signIn(page, TELECALLER);

    // Capture the token, log out, then try to use it directly. A logout that
    // only cleared the browser would leave this token working.
    const token = await page.evaluate(() => localStorage.getItem("aos.token"));
    expect(token).toBeTruthy();

    await signOut(page);

    const replay = await page.request.get("/api/cases", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(replay.status()).toBe(401);
  });

  test("a stale token in storage returns to the login screen", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("aos.token", "not-a-real-token"));
    await page.goto("/#/cases");

    // Validated against the server on load rather than trusted.
    await expect(page.locator('input[name="username"]')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------

test.describe("customers and cases are read and written through the API", () => {
  test("opens a case and shows it in the list", async ({ page }) => {
    await signIn(page, TELECALLER);
    const applicant = unique("Ravi");
    const { number } = await openCase(page, applicant);

    await page.goto("/#/cases");
    await expect(page.getByRole("link", { name: number })).toBeVisible();
    await expect(page.getByText(applicant).first()).toBeVisible();
  });

  test("the case survives a browser restart with storage cleared", async ({ page, context }) => {
    await signIn(page, TELECALLER);
    const applicant = unique("Durable");
    const { number } = await openCase(page, applicant);

    // The old prototype kept everything here. Clearing it used to be the same
    // as deleting the database; now it only signs the employee out.
    await context.clearCookies();
    await page.evaluate(() => localStorage.clear());

    await signIn(page, TELECALLER);
    await page.goto("/#/cases");
    await expect(page.getByRole("link", { name: number })).toBeVisible();
  });

  test("edits a case and the change persists across a reload", async ({ page }) => {
    await signIn(page, TELECALLER);
    await openCase(page, unique("Editable"));

    await page.locator('input[name="requestedAmount"]').fill("7250000");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    await page.reload();
    await expect(page.locator('input[name="requestedAmount"]')).toHaveValue("7250000");
  });

  test("moves a case through the stages the domain allows, and is refused one it does not", async ({
    page,
  }) => {
    await signIn(page, TELECALLER);
    await openCase(page, unique("Staged"));

    const dialog = page.getByRole("dialog");
    await page.getByRole("button", { name: "Move stage" }).click();
    await dialog.locator("select").selectOption("documents_pending");
    await dialog.getByRole("button", { name: "Move", exact: true }).click();

    // The server's own words — `new -> documents_pending` is not a transition
    // the domain allows, and the refusal says so rather than the button just
    // failing.
    await expect(page.getByRole("alert")).toContainText("cannot move from new to documents_pending");

    await dialog.locator("select").selectOption("contacted");
    await dialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("Moved to Contacted.")).toBeVisible();

    await page.reload();
    await expect(page.getByText("Contacted").first()).toBeVisible();
  });

  test("finds an existing customer by name, from the database", async ({ page }) => {
    await signIn(page, TELECALLER);
    const applicant = unique("Findable");
    await openCase(page, applicant);

    await page.locator('input[name="search"]').fill(applicant.split(" ")[1]!);
    // The result comes from `GET /api/search`, not from anything this tab loaded.
    await expect(page.getByText(applicant).first()).toBeVisible();
  });

  test("warns that AOS may already know this customer", async ({ page }) => {
    await signIn(page, TELECALLER);
    const applicant = unique("Duplicate");
    await openCase(page, applicant);

    await page.goto("/#/cases/new");
    await page.locator('input[name="applicantName"]').fill(applicant);

    // The duplicate check runs against the database rather than the people
    // this tab happens to be holding.
    await expect(page.getByTestId("duplicate-warning")).toBeVisible();
    await expect(page.getByTestId("duplicate-warning")).toContainText(applicant);
  });

  test("edits a customer's contact details", async ({ page }) => {
    await signIn(page, TELECALLER);
    const applicant = unique("Contactable");
    await openCase(page, applicant);

    await page.getByRole("link", { name: applicant }).first().click();
    await expect(page.getByRole("heading", { name: applicant })).toBeVisible();

    const contacts = page.getByRole("dialog");
    await page.getByRole("button", { name: "Edit contacts" }).click();
    await page.getByRole("button", { name: "Add another" }).click();
    await contacts.locator("select").last().selectOption("email");
    await contacts.locator("input:not([type=checkbox])").last().fill("ravi@example.com");
    await contacts.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("ravi@example.com")).toBeVisible();
    await page.reload();
    await expect(page.getByText("ravi@example.com")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The tests this stage exists to make possible
// ---------------------------------------------------------------------------

test.describe("one authoritative database", () => {
  test("two independent sessions see the same case", async ({ browser }) => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    const telecallerPage = await first.newPage();
    const managerPage = await second.newPage();

    try {
      await signIn(telecallerPage, TELECALLER);
      const applicant = unique("Shared");
      const { number, url } = await openCase(telecallerPage, applicant);

      // A different browser context: its own storage, its own session, its own
      // token. Before this stage it would have had its own database too.
      await signIn(managerPage, MANAGER);
      await managerPage.goto(url);
      await expect(managerPage.locator("h1.tnum").first()).toHaveText(number);
      await expect(managerPage.getByText(applicant).first()).toBeVisible();

      // And a change made by one is visible to the other on reload.
      const managerDialog = managerPage.getByRole("dialog");
      await managerPage.getByRole("button", { name: "Move stage" }).click();
      await managerDialog.locator("select").selectOption("contacted");
      await managerDialog.getByRole("button", { name: "Move", exact: true }).click();
      await expect(managerPage.getByText("Moved to Contacted.")).toBeVisible();

      await telecallerPage.reload();
      await expect(telecallerPage.getByText("Contacted").first()).toBeVisible();
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("a Telecaller cannot reach a colleague's case by typing its URL", async ({ browser }) => {
    const owning = await browser.newContext();
    const nosy = await browser.newContext();
    const ownerPage = await owning.newPage();
    const otherPage = await nosy.newPage();

    try {
      await signIn(ownerPage, TELECALLER);
      const { number, url } = await openCase(ownerPage, unique("Private"));

      await signIn(otherPage, OTHER_TELECALLER);

      // Not hidden by the list — refused by the server. The URL is the exact
      // one that works for its owner.
      await otherPage.goto(url);
      await expect(otherPage.getByText("No such case, or you do not have access to it.")).toBeVisible();
      expect(await otherPage.content()).not.toContain(number);

      // And it is absent from their list.
      await otherPage.goto("/#/cases");
      await expect(otherPage.getByRole("link", { name: number })).toHaveCount(0);
    } finally {
      await owning.close();
      await nosy.close();
    }
  });

  test("a Manager sees a Telecaller's case; case.read is `all` for them", async ({ browser }) => {
    const owning = await browser.newContext();
    const managing = await browser.newContext();
    const ownerPage = await owning.newPage();
    const managerPage = await managing.newPage();

    try {
      await signIn(ownerPage, TELECALLER);
      const { number } = await openCase(ownerPage, unique("Visible"));

      await signIn(managerPage, MANAGER);
      await managerPage.goto("/#/cases");
      await expect(managerPage.getByRole("link", { name: number })).toBeVisible();
    } finally {
      await owning.close();
      await managing.close();
    }
  });
});

test.describe("the un-migrated tabs say so", () => {
  test("Documents, Banks and Timeline are marked not yet migrated", async ({ page }) => {
    await signIn(page, TELECALLER);
    await openCase(page, unique("Tabbed"));

    for (const tab of ["Documents", "Banks", "Timeline"]) {
      await page.getByRole("button", { name: tab }).click();
      // Explicit, so an unmigrated tab is never mistaken for an empty one.
      await expect(page.getByText("Not yet migrated.")).toBeVisible();
    }

    await page.getByRole("button", { name: "Overview" }).click();
    await expect(page.getByText("What this case is asking for")).toBeVisible();
  });
});
