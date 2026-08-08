import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const fixture = (name: string): string => path.join(FIXTURES, name);

/** Seeded prototype users (Frontend/src/fake/seed.ts). No login — this is a session switch. */
export const USERS = {
  telecaller: "Priya Raman",
  loginExecutive: "Karthik V",
  manager: "Lakshmi Narayanan",
} as const;

export async function switchUser(page: Page, fullName: string): Promise<void> {
  await openUserMenu(page);
  await page.getByRole("button", { name: fullName, exact: true }).click();
  await expect(page.locator("header").getByText(fullName, { exact: true }).first()).toBeVisible();
}

async function openUserMenu(page: Page): Promise<void> {
  // The switcher button shows the current user's initials + name; click it to reveal the list.
  const header = page.locator("header");
  const switcherButton = header.locator("button").filter({ has: page.locator("span.rounded-full") });
  await switcherButton.click();
}

export async function resetPrototype(page: Page): Promise<void> {
  await openUserMenu(page);
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
  await page.goto("/cases/new");
  await expect(page.getByRole("heading", { name: "New case" })).toBeVisible();

  // "Who is applying" — PersonSearchField renders Name/Phone inputs.
  await page.getByLabel("Name").fill(input.name);
  await page.getByLabel("Phone").fill(input.phone);

  await page.getByLabel("Loan type").selectOption({ label: input.loanTypeLabel });
  await page.getByLabel("Amount").fill(input.amount);

  await page.getByRole("button", { name: "Open case" }).click();
  await page.waitForURL(/\/cases\/[^/]+$/);
  return page.url();
}

export async function gotoTab(page: Page, tab: "overview" | "documents" | "banks" | "timeline"): Promise<void> {
  const url = new URL(page.url());
  url.searchParams.set("tab", tab);
  await page.goto(url.pathname + url.search);
}

/** Locates a checklist row (li) by the visible document name text. */
export function documentRow(page: Page, nameSubstring: string) {
  return page.locator("li").filter({ hasText: nameSubstring }).first();
}

export async function uploadForRow(page: Page, nameSubstring: string, filePath: string, buttonName: RegExp = /^Upload$|^Upload again$/) {
  const row = documentRow(page, nameSubstring);
  await expect(row).toBeVisible();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await row.getByRole("button", { name: buttonName }).click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(filePath);
}
