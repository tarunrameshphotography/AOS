/**
 * Sending a case's documents to a banker, through the real UI (ADR-039).
 *
 * WHAT THIS PROVES THAT THE UNIT TESTS DO NOT. Everything below is driven by
 * clicking: open a case, collect documents, verify them, add a bank, choose
 * what to send, review the batches, confirm, and read the result and the
 * timeline. The domain tests prove the rules; this proves a person can reach
 * them.
 *
 * WHERE IT STOPS. The mail backend runs in `capture` mode (see
 * playwright.config.ts): it builds each message exactly as a real send does
 * and writes it to disk instead of delivering it. So the boundary this suite
 * stops at is Gmail's front door, and the captured messages are read back
 * here to assert what would have gone out.
 *
 * NO TEST IN THIS FILE SENDS A REAL EMAIL, and none should be added that
 * does. Real delivery is a manual check with a credential — see
 * Docs/Email and WhatsApp Integration.md.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  advanceToDocumentsPending,
  createCaseThroughUi,
  dialogButton,
  fixture,
  gotoTab,
  USERS,
  switchUser,
} from "../support/helpers";

const MAIL_BASE_URL = process.env.AOS_MAIL_BASE_URL ?? "http://127.0.0.1:4320";
const MB = 1024 * 1024;

interface CapturedEmail {
  subject: string;
  body: string;
  to: { email: string; name?: string }[];
  cc: { email: string }[];
  from: { email: string; name?: string };
  attachments: { fileName: string; sizeBytes: number }[];
  mimeBytes: number;
}

async function capturedEmails(request: APIRequestContext): Promise<CapturedEmail[]> {
  const response = await request.get(`${MAIL_BASE_URL}/captured`);
  expect(
    response.ok(),
    "The mail backend is not running in capture mode. Stop any dev server started without " +
      "AOS_MAIL_PROVIDER=capture and let Playwright start its own.",
  ).toBe(true);
  return (await response.json()) as CapturedEmail[];
}

/**
 * Big fixture files, generated at run time rather than committed.
 *
 * Twelve megabytes of PDF in the repository to prove a size rule is a poor
 * trade. They are written to a temp directory the first time a test needs
 * them and thrown away with it.
 */
let bigFixtureDir: string | null = null;
function bigFixture(name: string, megabytes: number): string {
  bigFixtureDir ??= mkdtempSync(path.join(tmpdir(), "aos-mail-fixtures-"));
  const filePath = path.join(bigFixtureDir, name);
  // A valid-enough PDF header followed by padding — the size is what matters,
  // and the storage backend stores bytes without inspecting them.
  const header = Buffer.from("%PDF-1.4\n% AOS QA large fixture\n", "latin1");
  const padding = Buffer.alloc(Math.round(megabytes * MB) - header.length, 0x20);
  writeFileSync(filePath, Buffer.concat([header, padding]));
  return filePath;
}

/**
 * Upload each file against whichever checklist row is next outstanding.
 *
 * Waits for the file's OWN confirmation rather than a generic one: a toast
 * left over from the previous upload would otherwise satisfy the wait and the
 * next click would race the row disappearing.
 */
async function uploadFirstDocuments(page: Page, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const upload = page.getByRole("button", { name: "Upload", exact: true }).first();
    await expect(upload).toBeVisible();
    const chooserPromise = page.waitForEvent("filechooser");
    await upload.click();
    const chooser = await chooserPromise;
    await chooser.setFiles(file);
    await expect(page.getByRole("status")).toContainText(`${path.basename(file)} uploaded`);
  }
}

/** Confirm one document through the verify dialog. */
async function confirmVerify(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Verify", exact: true }).first().click();
  await dialogButton(page, "Yes — confirm & verify").click();
  // The dialog closing is the unambiguous signal. "Verified" as text matches
  // the badge, the toast and a definition list term all at once.
  await expect(page.getByRole("heading", { name: /^Verify: / })).toHaveCount(0);
}

/** Verify every document currently awaiting review on this case. */
async function verifyEverything(page: Page): Promise<number> {
  let verified = 0;
  for (;;) {
    if ((await page.getByRole("button", { name: "Verify", exact: true }).count()) === 0) break;
    await confirmVerify(page);
    verified += 1;
    if (verified > 20) throw new Error("too many documents to verify — check the loop");
  }
  return verified;
}

async function addBank(page: Page, bankerEmail: string, bankerName: string): Promise<void> {
  await gotoTab(page, "banks");
  await page.getByRole("button", { name: "Add Bank" }).click();
  await expect(page.getByRole("heading", { name: "Add a bank to this file" })).toBeVisible();

  /**
   * The two selects, by position inside the open dialog.
   *
   * Not by label: `Field` wraps its control in the <label>, so a select's
   * accessible name is its own option list concatenated onto the label text —
   * and the Branch field's hint ("Choose a bank first.") makes `getByLabel`
   * match both of them. Anchoring off the modal's Close control is the same
   * trick `dialogButton` in the shared helpers already uses.
   */
  const dialogSelect = (index: number) =>
    page.getByRole("button", { name: "Close" }).locator(`xpath=following::select[${index}]`);

  await dialogSelect(1).selectOption({ label: "HDFC Bank" });
  // Any open branch of it — the seed gives HDFC Bank several Coimbatore ones.
  await dialogSelect(2).selectOption({ index: 1 });

  // By role, not by label: the "How it goes out" select lists "By Email" among
  // its options, so its accessible name contains the word too.
  await page.getByRole("textbox", { name: "Email" }).fill(bankerEmail);
  await page.getByRole("textbox", { name: "Name" }).first().fill(bankerName);

  await dialogButton(page, "Add Bank").click();
  await expect(page.getByText("Bank added.")).toBeVisible();
}

test.describe("Send documents to the banker", () => {
  test("the whole workflow: choose, review, confirm, and see it in the timeline", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Ravi Kumar",
      phone: "9843150001",
      loanTypeLabel: "Business Loan · Machinery",
      amount: "2500000",
    });
    await advanceToDocumentsPending(page);
    await gotoTab(page, "documents");

    await uploadFirstDocuments(page, [
      fixture("pan-card.pdf"),
      fixture("aadhaar-card.pdf"),
      fixture("gst-certificate.pdf"),
    ]);

    // One more upload that nobody verifies — it must appear in the send
    // dialog, disabled, with its reason.
    const upload = page.getByRole("button", { name: "Upload", exact: true }).first();
    const chooserPromise = page.waitForEvent("filechooser");
    await upload.click();
    await (await chooserPromise).setFiles(fixture("itr-3fy.pdf"));

    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    await gotoTab(page, "documents");

    // Verify three of the four, leaving the last one received-but-unverified.
    for (let index = 0; index < 3; index += 1) {
      await confirmVerify(page);
    }

    await addBank(page, "karthik@examplebank.com", "Karthik V");

    // --- Choose -----------------------------------------------------------
    await page.getByRole("button", { name: "Send documents via mail" }).click();
    await expect(page.getByRole("heading", { name: "Send documents to the banker" })).toBeVisible();

    await expect(page.getByText("3 of 3 verified selected")).toBeVisible();
    // The unverified upload is visible and refused, with the reason on screen.
    await expect(page.getByText("Cannot send")).toBeVisible();
    await expect(
      page.getByText(/Not verified yet\. Only a document a person has checked goes to a bank/),
    ).toBeVisible();
    // Exactly one row is offered and refused — it cannot be ticked.
    expect(await page.locator('input[type="checkbox"]:disabled').count()).toBe(1);

    // The banker chosen when the bank was added is already filled in.
    await expect(page.getByLabel("Banker email 1")).toHaveValue("karthik@examplebank.com");

    // --- Review -----------------------------------------------------------
    await page.getByRole("button", { name: /^Review / }).click();

    // The review's own summary block — scoped to the definition list so the
    // case header behind the dialog cannot satisfy an assertion.
    const summary = page.getByRole("definition");
    await expect(summary.filter({ hasText: "karthik@examplebank.com" })).toBeVisible();
    await expect(summary.filter({ hasText: "Ravi Kumar" })).toBeVisible();
    await expect(summary.filter({ hasText: "Machinery and Equipment Loan" })).toBeVisible();
    await expect(summary.filter({ hasText: "3 verified documents" })).toBeVisible();
    await expect(summary.filter({ hasText: "amazeloans@gmail.com" })).toBeVisible();
    await expect(page.getByText("Email 1 of 1")).toBeVisible();
    await expect(
      page.getByText(/^Ravi Kumar - Machinery and Equipment Loan - /),
    ).toBeVisible();

    // Nothing has been sent merely by opening or reviewing.
    expect(
      (await capturedEmails(request)).filter((email) => email.subject.includes("Ravi Kumar")),
    ).toHaveLength(0);

    // --- Confirm ----------------------------------------------------------
    await page.getByRole("button", { name: "Send documents", exact: true }).click();

    await expect(page.getByText(/Documents sent successfully\./)).toBeVisible();
    await expect(page.getByText("karthik@examplebank.com").first()).toBeVisible();
    await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Close" }).last().click();

    // --- What actually left the building ----------------------------------
    const sent = (await capturedEmails(request)).filter((email) =>
      email.subject.includes("Ravi Kumar - Machinery and Equipment Loan"),
    );
    expect(sent).toHaveLength(1);
    const email = sent[0]!;
    expect(email.to[0]?.email).toBe("karthik@examplebank.com");
    expect(email.from.email).toBe("amazeloans@gmail.com");
    expect(email.body).toContain("Dear Karthik,");
    expect(email.body).toContain("Regards,\nAmaze Loans");
    expect(email.attachments).toHaveLength(3);
    // The MIME message was genuinely built, not shortcut past.
    expect(email.mimeBytes).toBeGreaterThan(0);

    // --- Recorded on the case ---------------------------------------------
    await expect(page.getByText(/Documents sent — 3 documents in 1 email/)).toBeVisible();

    await gotoTab(page, "timeline");
    await expect(page.getByText(/Documents sent to banker/)).toBeVisible();
    await expect(page.getByText(/Email sent: "Ravi Kumar - Machinery and Equipment Loan/)).toBeVisible();
    // The employee who sent it is named.
    await expect(page.getByText(USERS.loginExecutive).first()).toBeVisible();
  });

  test("splits across several emails when the documents exceed 10 MB, and every one is numbered", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Batching Applicant",
      phone: "9843150002",
      loanTypeLabel: "Business Loan · Machinery",
      amount: "4000000",
    });
    await advanceToDocumentsPending(page);
    await gotoTab(page, "documents");

    // 13 MB in total — over the ceiling, so it cannot go as one email.
    await uploadFirstDocuments(page, [
      bigFixture("large-a.pdf", 6),
      bigFixture("large-b.pdf", 4),
      bigFixture("large-c.pdf", 3),
    ]);

    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    await gotoTab(page, "documents");
    expect(await verifyEverything(page)).toBe(3);

    await addBank(page, "credit.cbe@examplebank.com", "Anitha R");

    await page.getByRole("button", { name: "Send documents via mail" }).click();
    await page.getByRole("button", { name: /^Review / }).click();

    // The review states the split and explains why, before anything is sent.
    await expect(
      page.getByText(/over the 10 MB an individual email may carry/),
    ).toBeVisible();

    // How many emails is a consequence of the file sizes, so it is read off
    // the screen rather than hard-coded — what matters is that there is more
    // than one and that each is numbered.
    const headings = page.getByText(/^Email \d+ of \d+$/);
    const emailCount = await headings.count();
    expect(emailCount).toBeGreaterThan(1);
    for (let index = 1; index <= emailCount; index += 1) {
      await expect(page.getByText(`Email ${index} of ${emailCount}`, { exact: true })).toBeVisible();
      await expect(page.getByText(new RegExp(`\\(${index}/${emailCount}\\)`))).toBeVisible();
    }

    await page.getByRole("button", { name: "Send documents", exact: true }).click();
    await expect(page.getByText(/Documents sent successfully\./)).toBeVisible();

    const sent = (await capturedEmails(request)).filter((email) =>
      email.subject.includes("Batching Applicant"),
    );
    expect(sent).toHaveLength(emailCount);

    // The hard rule, checked against what was actually built.
    for (const email of sent) {
      const total = email.attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
      expect(total).toBeLessThanOrEqual(10 * MB);
    }
    // Every document went, exactly once.
    const fileNames = sent.flatMap((email) => email.attachments.map((a) => a.fileName));
    expect(fileNames).toHaveLength(3);
    expect(new Set(fileNames).size).toBe(3);
    // And each email says which one it is, and says nothing is missing.
    expect(
      sent.map((email) => Number(email.subject.match(/\((\d+)\//)?.[1])).sort(),
    ).toEqual(Array.from({ length: emailCount }, (_, index) => index + 1));
    expect(sent.every((email) => email.body.includes("nothing is missing"))).toBe(true);
  });

  test("a Telecaller is not offered the action at all", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, USERS.telecaller);

    const caseUrl = await createCaseThroughUi(page, {
      name: "Permission Applicant",
      phone: "9843150003",
      loanTypeLabel: "Business Loan · Machinery",
      amount: "500000",
    });
    await advanceToDocumentsPending(page);
    await gotoTab(page, "documents");
    await uploadFirstDocuments(page, [fixture("pan-card.pdf")]);

    await switchUser(page, USERS.loginExecutive);
    await page.goto(caseUrl);
    await gotoTab(page, "documents");
    await verifyEverything(page);
    await addBank(page, "karthik@examplebank.com", "Karthik V");
    await expect(page.getByRole("button", { name: "Send documents via mail" })).toBeVisible();

    // The Telecaller collected every one of those documents and still may not
    // send the file to a bank — `submission.create`, which they hold at no
    // scope. Management decides where a case goes.
    await switchUser(page, USERS.telecaller);
    await page.goto(caseUrl);
    await gotoTab(page, "banks");
    await expect(page.getByRole("button", { name: "Send documents via mail" })).toHaveCount(0);
  });
});
