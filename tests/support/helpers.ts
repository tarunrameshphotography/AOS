import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const fixture = (name: string): string => path.join(FIXTURES, name);

/**
 * Seeded prototype users (Frontend/src/fake/seed.ts) — real employee accounts
 * since the Employee Authentication milestone, all sharing one dev-only
 * password (DEV_PASSWORD below, hashed in seed.ts — never committed as
 * plaintext anywhere but this test helper and that file's own comment).
 */
export const USERS = {
  telecaller: "Priya Raman",
  loginExecutive: "Karthik V",
  manager: "Lakshmi Narayanan",
} as const;

/** The six real AOS employees created for the Employee Authentication milestone. */
export const EMPLOYEES = {
  telecallerAndLoginExecutive: "Chinna Thambi",
  telecaller: "Jayalakshmi",
  manager: "Tarun Ramesh",
  managingPartner: "C Sasi Rekha",
  managingPartner2: "Mohammed Ismail",
  managingPartner3: "V Keerthivhasan",
} as const;

/** Development-only shared seed password. Never a real credential — see Frontend/src/fake/seed.ts. */
export const DEV_PASSWORD = "Amaze@123";

const USERNAME_BY_NAME: Record<string, string> = {
  "Priya Raman": "priya.raman",
  "Karthik V": "karthik.v",
  "Lakshmi Narayanan": "lakshmi.n",
  "Suresh Babu": "suresh.babu",
  "Karthik V (also calling)": "karthik.v2",
  "Chinna Thambi": "chinna.thambi",
  Jayalakshmi: "jayalakshmi",
  "Tarun Ramesh": "tarun.ramesh",
  "C Sasi Rekha": "sasi.rekha",
  "Mohammed Ismail": "mohammed.ismail",
  "V Keerthivhasan": "keerthivhasan",
};

function usernameFor(fullName: string): string {
  const username = USERNAME_BY_NAME[fullName];
  if (!username) throw new Error(`No seeded username known for "${fullName}" — add it to helpers.ts.`);
  return username;
}

/**
 * Logs in as `fullName` through the real login screen (Employee
 * Authentication milestone — there is no user-switcher any more). If someone
 * is already signed in, logs them out first, so the many existing tests that
 * call this repeatedly to change identity mid-test keep working unchanged.
 */
export async function switchUser(page: Page, fullName: string): Promise<void> {
  const onLoginScreen = await page
    .getByRole("button", { name: "Sign in" })
    .isVisible()
    .catch(() => false);
  if (!onLoginScreen) {
    await logout(page);
  }

  await page.getByLabel("Username / Employee ID").fill(usernameFor(fullName));
  await page.getByLabel("Password").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("header").getByText(fullName, { exact: true }).first()).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await openIdentityMenu(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
}

async function openIdentityMenu(page: Page): Promise<void> {
  // The identity button shows the current user's initials + name; click it to reveal the menu.
  const header = page.locator("header");
  const menuButton = header.locator("button").filter({ has: page.locator("span.rounded-full") });
  await menuButton.click();
}

export async function resetPrototype(page: Page): Promise<void> {
  await openIdentityMenu(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset prototype data" }).click();
}

export interface NewCaseInput {
  name: string;
  phone: string;
  loanTypeLabel: string; // e.g. "Business Loan · Machinery"
  amount: string;
}

/** Drives the real New Case screen and returns the resulting case URL/id. */
export async function createCaseThroughUi(page: Page, input: NewCaseInput): Promise<string> {
  // The app uses HashRouter — routes live after "#", not as a real path segment.
  await page.goto("/#/cases/new");
  await expect(page.getByRole("heading", { name: "New case" })).toBeVisible();

  // "Who is applying" — PersonSearchField renders Name/Phone inputs.
  await page.getByLabel("Name").fill(input.name);
  // getByLabel("Phone") is ambiguous: the "Source" combobox's selected option text ("Phone
  // Enquiry") also matches by accessible name. The phone field is the only textbox, so pin
  // it down by role.
  await page.getByRole("textbox", { name: "Phone" }).fill(input.phone);

  await page.getByLabel("Loan type").selectOption({ label: input.loanTypeLabel });
  await page.getByLabel("Amount").fill(input.amount);

  await page.getByRole("button", { name: "Open case" }).click();
  await page.waitForURL(/\/cases\/[^/]+$/);
  return page.url();
}

export async function gotoTab(page: Page, tab: "overview" | "documents" | "banks" | "timeline"): Promise<void> {
  // Under HashRouter the route path and its query string both live inside the fragment
  // (e.g. "/#/cases/cas_001?tab=documents"), not in the real URL's pathname/search.
  const url = new URL(page.url());
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const [hashPath, hashSearch] = hash.split("?");
  const params = new URLSearchParams(hashSearch);
  params.set("tab", tab);
  await page.goto(`${url.pathname}#${hashPath}?${params.toString()}`);
}

/**
 * Locates a checklist row (li) by its document name.
 *
 * Defaults to a substring match, which is what most callers want (e.g.
 * `documentRow(page, "Existing Loan Statement — HDFC Bank")` against a row whose
 * full text also carries a description and an "Asked for by" line). Pass
 * `exact: true` when the name itself is a prefix of another real row's name —
 * "PAN" substring-matches both "PAN Card" and "Business PAN Card", and on a
 * business-loan checklist both exist. Exact matching targets the row's own name
 * line (CaseDetail.tsx: the `<p className="text-sm font-medium">` holding
 * `presentation.name`), not the row's full concatenated text.
 */
export function documentRow(page: Page, name: string, options?: { exact?: boolean }) {
  if (options?.exact) {
    return page.locator("li").filter({ has: page.getByText(name, { exact: true }) }).first();
  }
  return page.locator("li").filter({ hasText: name }).first();
}

/**
 * A button by name inside the currently-open modal dialog.
 *
 * Modal panels (Edit facts, Add property, Add document, ...) render their own
 * "Save & continue" alongside the page's own stage-footer button of the same
 * name, so an unscoped `getByRole` is ambiguous. Every Modal renders exactly
 * one "Close" control in its header, right before its own body buttons in
 * document order — scoping off that anchor reliably lands inside whichever
 * dialog is currently open, without depending on markup/classes.
 */
export function dialogButton(page: Page, name: string) {
  return page
    .getByRole("button", { name: "Close" })
    .locator(`xpath=following::button[normalize-space()="${name}"][1]`);
}

/**
 * A button by name within the page section identified by a unique heading —
 * e.g. the "Property" section's own "Add property", as opposed to the
 * identically-labelled quick action in the case summary toolbar above it.
 * Uses document order from the heading rather than DOM nesting, since the
 * button is a sibling of the heading's wrapper, not a descendant of it.
 */
export function sectionButton(page: Page, headingName: string, buttonName: string) {
  return page
    .getByRole("heading", { name: headingName, exact: true })
    .locator(`xpath=following::button[normalize-space()="${buttonName}"][1]`);
}

/**
 * Advances a freshly-created case from "New" straight to "Documents Pending" via the
 * real stage buttons (src/domain/case/transitions.ts: new -> contacted -> documents_pending
 * are both unguarded user transitions). Requirements only become due — with an Upload
 * control and their full row detail — once the case reaches that stage; a "New" case shows
 * every requirement as "not due yet" with no actionable row.
 */
export async function advanceToDocumentsPending(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Move to Contacted" }).click();
  await page.getByRole("button", { name: "Move to Documents Pending" }).click();
}

export async function uploadForRow(
  page: Page,
  name: string,
  filePath: string,
  buttonName: RegExp = /^Upload$|^Upload again$/,
  options?: { exact?: boolean },
) {
  const row = documentRow(page, name, options);
  await expect(row).toBeVisible();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await row.getByRole("button", { name: buttonName }).click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(filePath);
}
