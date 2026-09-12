// Builds the trusted DOCX resume template from reviewable XML sources.
//
// The generated binary (`src/resumes/templates/mouad_standard_v1.docx`) is
// checked in because the runtime must load a fixed template, but THIS FILE
// is the reviewed source: `tests/unit/resumes/docx-template.test.ts`
// regenerates the bytes in-memory (fixed zip dates for determinism) and
// asserts they equal the checked-in binary, so any binary edit without a
// source change fails loudly.
//
// Usage: node scripts/build-docx-template.mjs [--check]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PizZip from "pizzip";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "src", "resumes", "templates", "mouad_standard_v1.docx");
// Fixed zip entry date so regeneration is byte-deterministic.
const ENTRY_DATE = new Date("2026-01-01T00:00:00.000Z");

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="213C6B"/><w:sz w:val="41"/><w:szCs w:val="41"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="213C6B"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`;

function para(inner, style, center) {
  const pPr =
    style || center
      ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${center ? `<w:jc w:val="center"/>` : ""}</w:pPr>`
      : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${inner}</w:t></w:r></w:p>`;
}

function boldPara(text) {
  return `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function italicPara(text) {
  return `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

// Every docxtemplater tag sits in its own run so Word never splits it.
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${para("{full_name}", "Heading1", true)}${para("{contact_line}", null, true)}${para("{#has_summary}")}${para("Summary", "Heading2")}${para("{summary_copy}")}${para("{/has_summary}")}${para("{#has_professional}")}${para("Professional Experience", "Heading2")}${para("{/has_professional}")}${para("{#professional_experience}")}${boldPara("{company} | {dates}")}${italicPara("{role} | {location}")}${para("{#bullets}")}${para("\u2022 {text}")}${para("{/bullets}")}${para("{/professional_experience}")}${para("{#has_earlier}")}${para("Earlier Career", "Heading2")}${para("{/has_earlier}")}${para("{#earlier_career}")}${boldPara("{company} | {dates}")}${italicPara("{role} | {location}")}${para("{#bullets}")}${para("\u2022 {text}")}${para("{/bullets}")}${para("{/earlier_career}")}${para("{#has_skills}")}${para("Skills", "Heading2")}${para("{#skill_rows}")}${para("{label}: {terms}")}${para("{/skill_rows}")}${para("{/has_skills}")}${para("{#has_education}")}${para("Education", "Heading2")}${para("{#education_rows}")}${para("{line}")}${para("{/education_rows}")}${para("{/has_education}")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="979" w:right="1066" w:bottom="893" w:left="1066"/></w:sectPr></w:body></w:document>`;

export function buildTemplateBytes() {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES, { date: ENTRY_DATE });
  zip.file("_rels/.rels", RELS, { date: ENTRY_DATE });
  zip.file("word/document.xml", DOCUMENT, { date: ENTRY_DATE });
  zip.file("word/styles.xml", STYLES, { date: ENTRY_DATE });
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

const checkOnly = process.argv.includes("--check");
const bytes = buildTemplateBytes();
if (checkOnly) {
  const current = readFileSync(OUT_PATH);
  const match = Buffer.compare(current, bytes) === 0;
  console.log(match ? "DOCX_TEMPLATE_MATCH" : "DOCX_TEMPLATE_DRIFT");
  process.exit(match ? 0 : 1);
} else {
  writeFileSync(OUT_PATH, bytes);
  console.log(`wrote ${OUT_PATH} (${bytes.length} bytes)`);
  console.log(`sha256: ${createHash("sha256").update(bytes).digest("hex")}`);
}
