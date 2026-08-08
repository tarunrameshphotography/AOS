// One-off generator for real, valid test files used by the Playwright suite.
// Run manually: node tests/support/make-fixtures.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function minimalPdf(text) {
  const content = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 150]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length ${text.length + 40}>>stream
BT /F1 14 Tf 20 100 Td (${text}) Tj ET
endstream
endobj
xref
0 6
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`;
  return Buffer.from(content, "latin1");
}

// 1x1 red PNG, valid minimal PNG bytes.
const png1x1Red = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const files = [
  ["pan-card.pdf", minimalPdf("PAN CARD - QA TEST FIXTURE - ABCDE1234F")],
  ["aadhaar-card.pdf", minimalPdf("AADHAAR - QA TEST FIXTURE")],
  ["bank-statement-6m.pdf", minimalPdf("BANK STATEMENT 6 MONTHS - QA TEST FIXTURE")],
  ["itr-3fy.pdf", minimalPdf("ITR 3 YEARS - QA TEST FIXTURE")],
  ["gst-certificate.pdf", minimalPdf("GST CERTIFICATE - QA TEST FIXTURE - 33AAAAA0000A1Z5")],
  ["machinery-quotation.pdf", minimalPdf("MACHINERY QUOTATION - QA TEST FIXTURE")],
  ["property-title-deed.pdf", minimalPdf("PROPERTY TITLE DEED - QA TEST FIXTURE")],
  ["existing-loan-statement.pdf", minimalPdf("EXISTING LOAN STATEMENT - QA TEST FIXTURE")],
  ["salary-slip.pdf", minimalPdf("SALARY SLIP - QA TEST FIXTURE")],
  ["photo.png", png1x1Red],
  ["photo-reupload.png", png1x1Red],
];

for (const [name, buf] of files) {
  writeFileSync(path.join(dir, name), buf);
  console.log("wrote", name, buf.length, "bytes");
}
