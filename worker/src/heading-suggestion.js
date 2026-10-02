const GEMINI_GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const NAME_CREDENTIAL_PATTERN = String.raw`(?:o\.?\s*f\.?\s*m\.?(?:\s*cap\.?)?|ofm\s*cap\.?|ofmcap|ofin\s*cap\.?|ofincap|s\.?\s*j\.?|o\.?\s*p\.?|o\.?\s*s\.?\s*b\.?|o\.?\s*c\.?\s*s\.?\s*o\.?|c\.?\s*s\.?\s*r\.?|s\.?\s*d\.?\s*b\.?|c\.?\s*s\.?\s*c\.?|ph\.?\s*d\.?|d\.?\s*phil\.?|m\.?\s*div\.?|th\.?\s*d\.?|d\.?\s*min\.?|ed\.?\s*d\.?|psy\.?\s*d\.?|s\.?\s*t\.?\s*d\.?|s\.?\s*t\.?\s*l\.?|j\.?\s*c\.?\s*d\.?|j\.?\s*d\.?|m\.?\s*d\.?|d\.?\s*d\.?|m\.?\s*s\.?\s*w\.?|l\.?\s*c\.?\s*s\.?\s*w\.?|l\.?\s*m\.?\s*s\.?\s*w\.?|m\.?\s*b\.?\s*a\.?|r\.?\s*n\.?|m\.\s*a\.|b\.\s*a\.|m\.\s*s\.|b\.\s*s\.)`;
const COMMA_NAME_CREDENTIAL_PATTERN = String.raw`(?:${NAME_CREDENTIAL_PATTERN}|m\s*a|b\s*a|m\s*s|b\s*s)`;

export async function handleSuggestHeading(request, env, helpers) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return helpers.json({ error: "Invalid JSON body" }, request, env, 400);
  }

  helpers.requireStaffPasswordValue(body.password, env);

  const lines = normalizeHeadingLines(body.lines);
  const images = normalizeHeadingImages(body.images);
  const sourceAuthorHint = normalizeSourceAuthorHint(body.sourceAuthorHint);
  const sourceTitleHint = normalizeSourceTitleHint(body.sourceTitleHint);
  if (lines.length === 0 && images.length === 0) {
    return helpers.json({
      heading: "",
      source: "none",
      note: "No usable front-matter text was provided.",
    }, request, env);
  }

  if (env.GEMINI_API_KEY) {
    const aiHeading = await suggestHeadingWithGemini(lines, images, { sourceAuthorHint, sourceTitleHint }, env).catch(error => {
      console.warn("Gemini heading suggestion failed", {
        message: error.message || String(error),
      });
      return "";
    });

    if (aiHeading) {
      return helpers.json({
        heading: aiHeading,
        source: "ai",
        note: "Review before generating links.",
      }, request, env);
    }
  }

  return helpers.json({
    heading: buildHeadingSuggestion(lines),
    source: "heuristic",
    note: env.GEMINI_API_KEY
      ? "AI did not return a usable heading, so the Worker used the local fallback."
      : images.length > 0
        ? "This PDF may be scanned. Add a GEMINI_API_KEY Worker secret to read title-page images."
        : "No AI key is configured, so the Worker used the local fallback.",
  }, request, env);
}

function normalizeHeadingLines(rawLines) {
  if (!Array.isArray(rawLines)) {
    return [];
  }

  return rawLines
    .slice(0, 160)
    .map((line, index) => {
      if (typeof line === "string") {
        return { text: cleanFrontMatterLine(line), index };
      }
      if (line && typeof line === "object") {
        return {
          text: cleanFrontMatterLine(line.text),
          pageNumber: Number(line.pageNumber || 0),
          fontSize: Number(line.fontSize || 0),
          index,
        };
      }
      return { text: "", index };
    })
    .filter(line => line.text);
}

function normalizeHeadingImages(rawImages) {
  if (!Array.isArray(rawImages)) {
    return [];
  }

  return rawImages
    .slice(0, 18)
    .map(image => {
      if (!image || typeof image !== "object") {
        return null;
      }

      const mimeType = String(image.mimeType || "image/jpeg").toLowerCase();
      const data = String(image.data || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
      if (!/^image\/(jpeg|png|webp)$/.test(mimeType) || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        return null;
      }
      return { pageNumber: Number(image.pageNumber || 0), mimeType, data };
    })
    .filter(Boolean);
}

function normalizeSourceTitleHint(text) {
  const cleaned = cleanCitationText(text)
    .replace(/\bMMS\s+ID\b.*$/i, "")
    .replace(/\bBookmarked\b.*$/i, "")
    .replace(/\bPDF\b.*$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || containsNonLatinScript(cleaned)) return "";
  return cleaned.length <= 140 ? cleaned : "";
}

function normalizeSourceAuthorHint(text) {
  const cleaned = cleanCitationText(text)
    .replace(/\bMMS\s+ID\b.*$/i, "")
    .replace(/\bBookmarked\b.*$/i, "")
    .replace(/\bPDF\b.*$/i, "")
    .trim();
  if (!cleaned || containsNonLatinScript(cleaned)) return "";
  return cleaned.length <= 80 ? cleaned : "";
}

async function suggestHeadingWithGemini(lines, images, hints, env) {
  const { sourceAuthorHint = "", sourceTitleHint = "" } = hints || {};
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const excerpts = lines
    .slice(0, 80)
    .map(line => `p${line.pageNumber || "?"}: ${line.text}`)
    .join("\n");

  const prompt = [
    "You are helping library staff create a full bibliographic heading for chapter links.",
    "Use only the provided front matter, final imprint/copyright text, and page images. Do not invent facts.",
    "Hallucination guardrail: every non-empty field must be supported by exact visible words in the text or images.",
    "Exception: for a visible non-Latin-script personal contributor, the bracketed Latin-script form may be a romanization derived from the visible contributor name; visibleEvidence.contributor should still quote the visible original-script name.",
    "For each non-empty field, put the exact supporting visible words in visibleEvidence using the same field name.",
    "Do not include internal source markers such as page labels, page numbers, '(Page 4)', '[Page 4]', or similar locator notes in any citation field.",
    "If a field is likely but not explicitly visible, leave that field blank. Do not fill gaps from general knowledge, catalogs, memory, or assumptions.",
    "Extract separate bibliographic fields first, then create one clean Chicago Manual of Style bibliography-style entry for the whole book or source in heading.",
    "If contributor or title cannot be filled from visible evidence, leave heading blank rather than guessing a final citation.",
    "The heading is the authoritative final answer. Do not copy repeated contributor snippets, production credits, or role labels such as 지은이, 지음, 저자, or 저 into heading.",
    "The structured fields should support the final heading, but the heading should be a polished citation rather than a dump of every visible contributor-like phrase.",
    "Use this final style when the facts are visible: Last Name, First Name. Title: Subtitle. Responsibility statement. Series Title, volume/number. City: Publisher, Year.",
    "Do not split a single stacked title block into title plus series just because it contains a volume line. If the title page presents 'Lexham Geographic Commentary / on the Historical Books / Volume 2: 1 Samuel-Esther', cite that title block as 'Lexham Geographic Commentary on the Historical Books: Volume 2, 1 Samuel-Esther'.",
    "For a personal author shown as First Name Last Name, invert the author in the final bibliography heading as Last Name, First Name.",
    "For non-Latin-script personal authors, do not invert the original-script name. Keep the original-script name in visible order and add a romanized Latin-script form in square brackets, for example: 박성덕 [Park Sung-deok].",
    "For scanned non-Latin sources, trust the page image over OCR-like text when they conflict. Visually distinguish similar glyphs before filling names or publishers.",
    "Use the author name exactly as it appears on the title page. Do not expand, correct, or formalize it from copyright text; for example, if the title page says Tim Arnold and the copyright page says Timothy Arnold, use Tim Arnold.",
    "For non-Latin-script contributor names or titles, keep the visible non-Latin text first. If a visible English or Latin-script equivalent is also present, add it immediately after in square brackets, for example: 해돈 W. 로빈슨 [Haddon W. Robinson]. 성경 강해설교 강해설교 전개와 전달 [Biblical Preaching The Development and Delivery of Expository Messages].",
    "For non-Latin-script contributor names, include only a romanized contributor name in square brackets. Do not use a translated title, filename, URL slug, MMS ID, or other source identifier as the bracketed contributor form.",
    "For titles, never put a romanization or transliteration in the square brackets. Use the translated title in square brackets instead, for example: 영성 목회와 영적 지도 [The Pastor as Spiritual Guide], not 영성 목회와 영적 지도 [Yeongseong Mokhoe wa Yeongjeok Jido]: The Pastor as Spiritual Guide.",
    "For non-Latin-script titles, always include one English translated title in square brackets. If a filename/title hint is provided below, use it only for this bracketed English title; do not use it to replace the visible original-script title or contributor.",
    "For any non-Latin-script title/subtitle pair, do not bracket the main title and subtitle separately. Use one bracketed English equivalent after the full non-Latin title/subtitle, for example: 성경 강해설교: 강해설교 전개와 전달 [Biblical Preaching: The Development and Delivery of Expository Messages].",
    "Do not translate, romanize, or bracket equivalents for series titles, place names, publisher names, or responsibility names. Keep those fields in the full visible original form unless the source only shows a Latin-script form.",
    "For multiple authors, include them in Chicago bibliography order. For editors with no author, use ed. or eds. in the contributor field.",
    "For editor labels such as General Editor, cite the role as ed. or eds. in contributor and heading. Do not write General Editor in the final heading.",
    "If the title page identifies a book-level editor with phrases such as edited by, ouvrage édité par, edited and introduced by, or texte établi par, cite the whole book under that editor with ed. or eds. unless a distinct author is clearly identified.",
    "Do not treat names introduced only by with the collaboration of, avec la collaboration de, contributors, chapter authors, article authors, or table-of-contents entries as book-level authors/editors. Omit those names from the whole-book heading unless the request is for that specific chapter or article.",
    "Never omit named title-page contributors who supply a specific book-level responsibility. If the title page says a person supplied introduction, bibliography, translation, notes, commentary, edition, Latin text, or similar book-level work, capture that as responsibilityStatement and include it after the title.",
    "For translator or responsibility statements, use Chicago-style natural order after the role, such as Translated by 최대형. Prefer the visible original-script name when present; do not invert it as Choi, Dae-Hyung and do not add a bracketed romanization.",
    "For French title-page statements such as 'TEXTE LATIN / INTRODUCTION, BIBLIOGRAPHIE / TRADUCTION ET NOTES / par / René Roques', include: Texte latin, introduction, bibliographie, traduction et notes par René Roques.",
    "Normalize OCR all-caps surnames in responsibility names, such as Laure SOLIGNAC, to normal name capitalization. Omit trailing credential initials and religious/order credentials such as Ph.D., S.J., O.P., and OFM Cap. from all contributor names unless the credential is part of a title.",
    "Do not put title, subtitle, series, or edition text in contributor. For example, if a title page says 'ADULT LEARNING / Linking Theory and Practice / Second Edition / Laura L. Bierema, Monica Fedeli, Sharan B. Merriam', contributor is the three named people, title is Adult Learning: Linking Theory and Practice, and edition is Second Edition.",
    "An edition statement such as Second Edition is never the title by itself; put it in edition and keep looking for the actual title.",
    "Extract series title and series volume/number when they are clearly visible as a separate series statement, especially for commentary series or multi-volume sets. Do not move words from the displayed title block into series.",
    "Look for publication facts on copyright/title-page verso pages and final imprint/copyright pages: publisher name, publication place, and publication year.",
    "If a page lists both an original or first-publication date and a later printing or edition date, use the later visible printing/edition date for this scanned copy.",
    "Include a visible publication place when clearly identified in the front matter.",
    "When city, publisher, and year are clearly visible, the entry should end with City: Publisher, Year.",
    "Do not treat the series title as a substitute for publisher information; include both when both are visible.",
    "Include volume, translator, edition, revision/reprint, or editor details only when they are clearly visible and bibliographically important.",
    "For Korean books, publication facts may appear on a final imprint page with labels such as 발행처, 주소, and 초판/2쇄 발행일; use those visible facts when present. Do not include 초판 or 쇄 printing statements as edition unless the source explicitly says 판/edition as a bibliographic edition.",
    "For Korean title pages, the largest title line is usually the main title. A smaller line above it may be a subtitle; cite as main title: subtitle even if the subtitle is printed above the main title.",
    "For Korean author lines, remove role markers such as 지음 and 지은이. Carefully distinguish names such as 이수인 from 이수민; if a Latin hint says Lee Su-in and the page image supports 이수인, use 이수인.",
    "Read Korean publisher names carefully: 꿈미 is not 꾸밈. Prefer final imprint lines labeled 발행처 over cover logos or production credits. If 도서출판 꿈미, coommi, coommi.org, or coommimall appears, publisher is 도서출판 꿈미.",
    "When visibleEvidence.publisher contains a labeled imprint publisher, copy that exact publisher name into publisher and into the final heading. Do not shorten 도서출판 꿈미 to 꿈미, do not rewrite it as 꾸밈, and do not use a design/production credit as publisher.",
    "If place, publisher, or year are not visible, omit only the missing pieces instead of inventing them.",
    "Ignore ISBN, copyright boilerplate, library-cataloging blocks, table-of-contents lines, and chapter-title lines.",
    "Return JSON only, with this shape: {\"contributor\":\"...\",\"title\":\"...\",\"responsibilityStatement\":\"...\",\"series\":\"...\",\"seriesNumber\":\"...\",\"edition\":\"...\",\"city\":\"...\",\"publisher\":\"...\",\"year\":\"...\",\"heading\":\"...\",\"visibleEvidence\":{\"contributor\":\"...\",\"title\":\"...\",\"responsibilityStatement\":\"...\",\"series\":\"...\",\"seriesNumber\":\"...\",\"edition\":\"...\",\"city\":\"...\",\"publisher\":\"...\",\"year\":\"...\",\"heading\":\"...\"},\"warnings\":[\"...\"]}.",
    "",
    sourceAuthorHint ? `Filename/author hint for bracketed contributor form only: ${sourceAuthorHint}` : "",
    sourceTitleHint ? `Filename/title hint for bracketed English title only: ${sourceTitleHint}` : "",
    excerpts || "No selectable text was extracted. Read the attached front-matter page images.",
  ].join("\n");

  const parts = [{ text: prompt }];
  for (const image of images) {
    if (image.pageNumber) {
      parts.push({ text: `Rendered PDF page ${image.pageNumber}` });
    }
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.data,
      },
    });
  }

  const response = await fetch(`${GEMINI_GENERATE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini heading suggestion failed: ${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text || "{}");
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = JSON.parse(responseText || "{}");
  logAiCitationSummary(parsed);
  return buildAiCitation(parsed, lines, hints);
}

function logAiCitationSummary(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return;
  }

  const evidence = parsed.visibleEvidence || parsed.evidence || {};
  console.log("AI citation summary", {
    contributor: compactLogValue(parsed.contributor),
    title: compactLogValue(parsed.title),
    edition: compactLogValue(parsed.edition),
    city: compactLogValue(parsed.city),
    publisher: compactLogValue(parsed.publisher),
    year: compactLogValue(parsed.year),
    heading: compactLogValue(parsed.heading),
    evidence: {
      edition: compactLogValue(evidence.edition),
      city: compactLogValue(evidence.city),
      publisher: compactLogValue(evidence.publisher),
      year: compactLogValue(evidence.year),
    },
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.map(warning => compactLogValue(warning)).filter(Boolean).slice(0, 4)
      : [],
  });
}

function compactLogValue(value) {
  const cleaned = cleanCitationText(Array.isArray(value) ? value.join(" | ") : value || "");
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

function buildAiCitation(parsed, lines = [], hints = {}) {
  const { sourceAuthorHint = "", sourceTitleHint = "" } = hints || {};
  const evidence = normalizeEvidenceMap(parsed.visibleEvidence || parsed.evidence || {});
  const lineFields = extractLineCitationFields(lines);
  const publicationFields = extractSupportedPublicationFields(parsed, evidence);
  const fallbackHeading = normalizeAiCitationText(
    reconcileAiHeadingPublication(supportedAiHeading(parsed, evidence), publicationFields)
  );

  if (fallbackHeading) {
    if (
      hasCoreCitationFields(lineFields) &&
      !headingIncludesExtractedCore(fallbackHeading, lineFields) &&
      !shouldTrustEditedBookAiHeading(fallbackHeading, evidence) &&
      !shouldTrustSupportedAiHeading(fallbackHeading, parsed, evidence)
    ) {
      return buildCitationFromExtractedFields(lineFields);
    }
    return cleanCitationText(fallbackHeading);
  }

  const aiContributor = normalizeContributorField(
    normalizeContributorFromEvidence(supportedAiField(parsed, evidence, "contributor"), evidence.contributor),
    sourceAuthorHint
  );
  let contributor = preferTitlePageContributor(aiContributor, lines);
  let title = normalizeTitleField(supportedAiField(parsed, evidence, "title"), sourceTitleHint);
  const responsibilityEvidence = evidence.responsibilityStatement || evidence.responsibility || "";
  const responsibilityStatement = normalizeResponsibilityStatement(
    supportedAiField(parsed, evidence, "responsibilityStatement", ["responsibility"]),
    responsibilityEvidence
  );
  const series = stripNonTitleLatinBracketedEquivalents(supportedAiField(parsed, evidence, "series"));
  const seriesNumber = supportedAiField(parsed, evidence, "seriesNumber");
  let edition = normalizeEditionStatement(supportedAiField(parsed, evidence, "edition"));
  const { city, publisher, year } = publicationFields;

  if (shouldPreferExtractedCitationOverAi({ aiContributor, title, edition }, lineFields)) {
    return buildCitationFromExtractedFields(lineFields);
  }

  const parts = [];
  if (contributor) {
    parts.push(trimTerminalPeriod(formatChicagoBibliographyAuthors(contributor)));
  }
  if (title) {
    parts.push(trimTerminalPeriod(formatCitationTitle(title)));
  }
  if (responsibilityStatement) {
    parts.push(trimTerminalPeriod(responsibilityStatement));
  }
  if (series || seriesNumber) {
    parts.push(trimTerminalPeriod([series, seriesNumber].filter(Boolean).join(", ")));
  }
  if (edition) {
    parts.push(trimTerminalPeriod(edition));
  }

  let citation = parts.length > 0
    ? parts.join(". ") + "."
    : fallbackHeading;

  const publication = buildPublicationBlock(city, publisher, year);
  if (publication && !citationIncludesPublication(citation, publication)) {
    citation = `${trimTerminalPeriod(citation)}. ${publication}.`;
  }

  return normalizeAiCitationText(citation);
}

function shouldPreferExtractedCitationOverAi(fields, lineFields) {
  if (!hasCoreCitationFields(lineFields)) {
    return false;
  }

  if (!fields.title) {
    return true;
  }

  if (fields.title && looksLikeEditionLine(fields.title)) {
    return true;
  }

  if (fields.aiContributor && titleContainsText(lineFields.title, fields.aiContributor)) {
    return true;
  }

  return false;
}

function hasCoreCitationFields(fields) {
  return Boolean(fields.contributor && fields.title);
}

function headingIncludesExtractedCore(heading, lineFields) {
  return headingIncludesTitle(heading, lineFields.title) &&
    headingIncludesContributor(heading, lineFields.contributor);
}

function headingIncludesTitle(heading, title) {
  const headingKey = normalizeTitleComparison(heading);
  const titleKey = normalizeTitleComparison(title);
  return Boolean(headingKey && titleKey && headingKey.includes(titleKey));
}

function headingIncludesContributor(heading, contributor) {
  const headingKey = normalizeTitleComparison(heading);
  const lastNames = splitAuthorNames(contributor)
    .map(name => comparableLastName(name))
    .filter(Boolean);

  if (lastNames.length === 0) {
    return false;
  }

  return lastNames.every(lastName => headingKey.includes(lastName));
}

function titleContainsText(title, text) {
  const titleKey = normalizeTitleComparison(title);
  const textKey = normalizeTitleComparison(text);
  return Boolean(titleKey && textKey && titleKey.includes(textKey));
}

function normalizeTitleComparison(text) {
  return cleanCitationText(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLocaleLowerCase("en")
    .trim();
}

function supportedAiField(parsed, evidence, key, aliases = []) {
  const value = cleanCitationText([key, ...aliases].map(name => parsed[name]).find(Boolean) || "");
  if (!value) {
    return "";
  }

  const evidenceText = [key, ...aliases]
    .map(name => evidence[name])
    .find(Boolean);
  if (evidenceText) {
    return value;
  }

  console.warn("Dropped AI citation field without visible evidence", { field: key });
  return "";
}

function supportedAiHeading(parsed, evidence) {
  const value = cleanCitationText(parsed.heading || "");
  if (!value) {
    return "";
  }
  if (evidence.heading || hasHeadingFieldEvidence(evidence)) {
    return value;
  }

  console.warn("Dropped AI citation heading without supporting field evidence");
  return "";
}

function hasHeadingFieldEvidence(evidence) {
  return Boolean(
    evidence.contributor ||
    evidence.title ||
    evidence.responsibilityStatement ||
    evidence.responsibility ||
    evidence.series ||
    evidence.edition ||
    evidence.city ||
    evidence.publisher ||
    evidence.year
  );
}

function shouldTrustEditedBookAiHeading(heading, evidence) {
  const cleanedHeading = cleanCitationText(heading);
  const contributorEvidence = cleanCitationText(evidence.contributor || evidence.responsibilityStatement || evidence.responsibility || "");
  if (!/,\s*eds?\./i.test(cleanedHeading)) {
    return false;
  }

  return /\b(?:edited by|edited and introduced by|general editor|series editor)\b/i.test(contributorEvidence) ||
    /\b(?:ouvrage\s+[ée]dit[ée]\s+par|texte\s+[ée]tabli\s+par)\b/iu.test(contributorEvidence);
}

function shouldTrustSupportedAiHeading(heading, parsed, evidence) {
  const aiContributor = cleanCitationText(parsed.contributor || "");
  const aiTitle = cleanCitationText(parsed.title || "");
  if (!aiContributor || !aiTitle || !evidence.contributor || !evidence.title) {
    return false;
  }
  if (!headingIncludesContributor(heading, aiContributor) || !headingIncludesTitle(heading, aiTitle)) {
    return false;
  }

  return Boolean(evidence.publisher || evidence.year || evidence.city || evidence.edition || evidence.heading);
}

function extractSupportedPublicationFields(parsed, evidence) {
  const city = stripNonTitleLatinBracketedEquivalents(supportedAiField(parsed, evidence, "city"));
  const publisher = normalizePublisherName(
    preferLabeledPublisherEvidence(
      preferFullerOriginalScriptEvidenceValue(supportedAiField(parsed, evidence, "publisher"), evidence.publisher),
      evidence.publisher
    )
  );
  const year = normalizePublicationYear(supportedAiField(parsed, evidence, "year"), evidence.year);
  return { city, publisher, year };
}

function reconcileAiHeadingPublication(heading, publicationFields) {
  const cleaned = cleanCitationText(heading);
  if (!cleaned || !publicationFields?.publisher) {
    return cleaned;
  }

  const publication = buildPublicationBlock(publicationFields.city, publicationFields.publisher, publicationFields.year);
  if (!publication || citationIncludesPublication(cleaned, publication)) {
    return cleaned;
  }

  const city = publicationFields.city ? escapeRegExp(publicationFields.city) : "";
  const year = publicationFields.year ? escapeRegExp(publicationFields.year) : "";
  const trimmed = trimTerminalPeriod(cleaned);

  if (city && year) {
    const tailPattern = new RegExp(`(\\.\\s*)${city}\\s*:\\s*[^.]+?,\\s*${year}$`, "u");
    if (tailPattern.test(trimmed)) {
      return `${trimmed.replace(tailPattern, `$1${publication}`)}.`;
    }
  }

  if (year) {
    const tailPattern = new RegExp(`(\\.\\s*)[^.]+?,\\s*${year}$`, "u");
    if (tailPattern.test(trimmed)) {
      return `${trimmed.replace(tailPattern, `$1${publication}`)}.`;
    }
  }

  return cleaned;
}

function normalizeContributorFromEvidence(value, evidenceText = "") {
  const cleaned = cleanAuthorLine(value);
  const evidenceName = cleanAuthorLine(evidenceText);
  if (/^[가-힣\s,·ㆍ-]{2,20}$/u.test(evidenceName) && evidenceName !== cleaned) {
    return evidenceName;
  }
  return cleaned;
}

function normalizeContributorField(contributor, sourceAuthorHint = "") {
  const cleaned = normalizeEditorRoleLabels(cleanAuthorLine(contributor));
  const hint = normalizeSourceAuthorHint(sourceAuthorHint);
  if (cleaned && hint && containsNonLatinScript(cleaned) && !/\[[^\[\]]+\]/u.test(cleaned)) {
    return `${cleaned} [${hint}]`;
  }
  return cleaned;
}

function normalizeTitleField(title, sourceTitleHint = "") {
  let cleaned = cleanCitationText(title);
  const hint = normalizeSourceTitleHint(sourceTitleHint);
  if (cleaned && hint && containsNonLatinScript(cleaned) && !/\[[^\[\]]+\]/u.test(cleaned)) {
    cleaned = `${cleaned} [${hint}]`;
  }
  return cleaned;
}

function normalizeEditionStatement(edition) {
  const cleaned = cleanCitationText(edition);
  if (/^(?:초판\s*)?\d+\s*쇄$/u.test(cleaned)) return "";
  if (/^초판\s*\d+\s*쇄\s*발행(?:일)?/u.test(cleaned)) return "";
  return cleaned;
}

function normalizeEvidenceMap(rawEvidence) {
  if (!rawEvidence || typeof rawEvidence !== "object") {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(rawEvidence)) {
    const evidenceText = Array.isArray(value)
      ? value.map(item => cleanCitationText(item)).filter(Boolean).join(" | ")
      : cleanCitationText(value || "");
    if (evidenceText) {
      normalized[key] = evidenceText;
    }
  }
  return normalized;
}

function buildPublicationBlock(city, publisher, year) {
  if (city && publisher && year) {
    return `${city}: ${publisher}, ${year}`;
  }
  if (city && publisher) {
    return `${city}: ${publisher}`;
  }
  if (publisher && year) {
    return `${publisher}, ${year}`;
  }
  return publisher || year || city || "";
}

function normalizePublicationYear(year, evidenceText = "") {
  const cleanedYear = cleanCitationText(year);
  const evidence = cleanCitationText(evidenceText);
  if (!evidence) {
    return cleanedYear;
  }

  const KoreanIssueDatePattern = /(?:\d+\s*쇄|\d+\s*판|개정판|증보판|재판)\s*발행(?:일)?\s*(\d{4})/gu;
  const issueYears = [...evidence.matchAll(KoreanIssueDatePattern)]
    .map(match => match[1])
    .filter(Boolean);
  if (issueYears.length > 0) {
    return issueYears[issueYears.length - 1];
  }

  return cleanedYear;
}

function citationIncludesPublication(citation, publication) {
  return citation.toLowerCase().includes(publication.toLowerCase());
}

function trimTerminalPeriod(text) {
  return String(text || "").replace(/[.\s]+$/g, "").trim();
}

function trimAuthorName(text) {
  return cleanFrontMatterLine(text).replace(/[,;:]+$/g, "");
}

function punctuateAuthorList(text) {
  const cleaned = cleanCitationText(text);
  return /[.!?]$/.test(cleaned) ? cleaned : cleaned + ".";
}

function punctuateCitationPart(text) {
  const cleaned = cleanCitationText(text);
  return /[.!?]$/.test(cleaned) ? cleaned : cleaned + ".";
}

function formatCitationTitle(title) {
  const cleaned = moveTrailingNonLatinTitleTranslationIntoBrackets(
    mergeSplitNonLatinTitleTranslations(trimTerminalPeriod(title))
  );
  return cleanCitationText(cleaned.replace(/\b[\p{Lu}][\p{Lu}'’-]{2,}\b/gu, word => {
    if (/^(II|III|IV|IX|VI|VII|VIII|USA|UK|US|PDF|ISBN)$/u.test(word)) return word;
    return word.charAt(0).toLocaleUpperCase("en") + word.slice(1).toLocaleLowerCase("en");
  }));
}

function mergeSplitNonLatinTitleTranslations(text) {
  const cleaned = cleanCitationText(text);
  const match = cleaned.match(/^(.+?)\s*\[([^\[\]]+)\]\s*:\s*(.+?)\s*\[([^\[\]]+)\]$/u);
  if (!match) {
    return cleaned;
  }

  const [, sourceMain, translationMain, sourceSubtitle, translationSubtitle] = match;
  if (!containsNonLatinScript(`${sourceMain} ${sourceSubtitle}`)) {
    return cleaned;
  }
  if (containsNonLatinScript(translationMain) || containsNonLatinScript(translationSubtitle)) {
    return cleaned;
  }

  return cleanCitationText(`${sourceMain}: ${sourceSubtitle} [${translationMain}: ${translationSubtitle}]`);
}

function moveTrailingNonLatinTitleTranslationIntoBrackets(text) {
  const cleaned = cleanCitationText(text);
  const match = cleaned.match(/^(.+?)\s*\[([^\[\]]+)\]\s*:\s*([^\[\]]+)$/u);
  if (!match) {
    return cleaned;
  }

  const [, sourceTitle, bracketedText, trailingTitle] = match;
  if (!containsNonLatinScript(sourceTitle)) {
    return cleaned;
  }
  if (containsNonLatinScript(bracketedText) || containsNonLatinScript(trailingTitle)) {
    return cleaned;
  }
  if (!looksLikeRomanizedTitle(bracketedText)) {
    return cleaned;
  }

  return cleanCitationText(`${sourceTitle} [${trimTerminalPeriod(trailingTitle)}]`);
}

function looksLikeRomanizedTitle(text) {
  const cleaned = cleanCitationText(text);
  if (!cleaned || containsNonLatinScript(cleaned)) {
    return false;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return false;
  }

  return words.some(word => /^(?:wa|gwa|ui)$/i.test(word)) ||
    /\b[a-z]*(?:yeo|yeong|eong|eon|eo|eu|ae|oe|ui|jeok|jido|mokhoe|ganghae|seolgyo)[a-z]*\b/i.test(cleaned);
}

function preferTitlePageContributor(aiContributor, lines) {
  const titlePageAuthor = findTitlePageAuthor(lines);
  if (!titlePageAuthor) {
    return aiContributor;
  }

  if (!aiContributor) {
    return titlePageAuthor;
  }

  if (sameNormalizedName(aiContributor, titlePageAuthor)) {
    return aiContributor;
  }

  if (sameLastName(aiContributor, titlePageAuthor)) {
    return titlePageAuthor;
  }

  return aiContributor;
}

function findTitlePageAuthor(lines) {
  const candidates = lines.filter(line => isUsefulFrontMatterLine(line.text));
  const title = chooseTitleLine(candidates);
  const author = title ? chooseAuthorLine(candidates, title.index) : "";
  return author ? normalizeContributorName(author) : "";
}

function sameNormalizedName(a, b) {
  return normalizeNameForComparison(a) === normalizeNameForComparison(b);
}

function sameLastName(a, b) {
  const aLast = comparableLastName(a);
  const bLast = comparableLastName(b);
  return aLast && bLast && aLast === bLast;
}

function comparableLastName(name) {
  const cleaned = cleanAuthorLine(name);
  if (!cleaned) return "";

  if (cleaned.includes(",")) {
    return normalizeNameForComparison(cleaned.split(",")[0]);
  }

  const parts = normalizeNameForComparison(cleaned).split(" ").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : "";
}

function normalizeNameForComparison(name) {
  return cleanAuthorLine(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en")
    .trim();
}

function formatChicagoBibliographyAuthors(author) {
  const cleaned = normalizeEditorRoleLabels(cleanAuthorLine(author));
  if (!cleaned) return "";

  const names = splitAuthorNames(cleaned)
    .map(name => normalizeContributorName(name))
    .filter(Boolean);

  if (names.length === 0) return "";

  if (names.length === 1) {
    return punctuateAuthorList(trimAuthorName(invertPersonalName(names[0])));
  }

  const first = trimAuthorName(invertPersonalName(names[0]));
  const rest = names.slice(1).map(name => trimAuthorName(name));

  let authorList = "";
  if (rest.length === 1) {
    authorList = first + ", and " + rest[0];
  } else {
    authorList = first + ", " + rest.slice(0, -1).join(", ") + ", and " + rest[rest.length - 1];
  }

  return punctuateAuthorList(authorList);
}

function splitAuthorNames(authorText) {
  const cleaned = cleanAuthorLine(authorText);
  if (!cleaned) return [];

  const pieces = cleaned
    .replace(/\s+(?:and|&)\s+/gi, ", ")
    .split(/\s*,\s*/)
    .map(piece => trimAuthorName(piece))
    .filter(Boolean);

  if (looksLikeSingleNonLatinAuthorName(cleaned, pieces)) {
    return [cleaned];
  }

  if (pieces.length <= 1) return pieces;

  const names = [];
  let index = 0;
  if (pieces.length >= 2 && looksLikeInvertedAuthorPieces(pieces[0], pieces[1])) {
    names.push(`${pieces[0]}, ${pieces[1]}`);
    index = 2;
  }

  for (; index < pieces.length; index++) {
    if (isEditorRoleToken(pieces[index]) && names.length > 0) {
      names[names.length - 1] = `${trimAuthorName(names[names.length - 1])}, ${normalizeEditorRoleToken(pieces[index])}`;
      continue;
    }
    names.push(pieces[index]);
  }

  return names;
}

function looksLikeSingleNonLatinAuthorName(cleaned, pieces) {
  if (!containsNonLatinScript(cleaned)) return false;
  if (pieces.length === 1) return true;
  if (pieces.length !== 2) return false;
  if (/\s+(?:and|&)\s+/i.test(cleaned)) return false;
  return pieces.every(piece => piece.split(/\s+/).filter(Boolean).length <= 3);
}

function looksLikeInvertedAuthorPieces(lastName, givenNames) {
  const last = cleanFrontMatterLine(lastName);
  const given = cleanFrontMatterLine(givenNames);
  if (!last || !given || /[.;:]/.test(last)) return false;
  if (!looksLikeSurnamePiece(last)) return false;
  return given.split(/\s+/).filter(Boolean).length <= 4;
}

function looksLikeSurnamePiece(text) {
  const words = cleanFrontMatterLine(text).split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  if (words.some(word => /\.$/.test(word))) return false;
  if (words.length === 1) return /^\p{Lu}/u.test(words[0]);
  return words.slice(0, -1).every(word => /^\p{Ll}/u.test(word)) && /^\p{Lu}/u.test(words[words.length - 1]);
}

function looksLikePersonalName(name) {
  const cleaned = cleanAuthorLine(name);
  if (!cleaned || /[0-9;:]/.test(cleaned)) return false;
  const words = cleaned.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  const nameWords = words.filter(word => /^(\p{Lu}[\p{L}'’-]*\.?|[A-Z]\.)$/u.test(word) || /^\p{Ll}{1,3}$/u.test(word));
  const capitalizedWords = words.filter(word => /^(\p{Lu}[\p{L}'’-]*\.?|[A-Z]\.)$/u.test(word));
  return nameWords.length === words.length && capitalizedWords.length >= 2;
}

function invertPersonalName(name) {
  const cleaned = trimAuthorName(name);
  if (!cleaned) return "";

  const role = extractEditorRoleSuffix(cleaned);
  const nameWithoutRole = role ? role.name : cleaned;
  if (!nameWithoutRole || nameWithoutRole.includes(",") || containsNonLatinScript(nameWithoutRole)) {
    return role ? `${nameWithoutRole}, ${role.role}` : nameWithoutRole;
  }

  const parts = nameWithoutRole.split(/\s+/);
  if (parts.length < 2) return role ? `${nameWithoutRole}, ${role.role}` : nameWithoutRole;

  const suffixes = ["Jr.", "Jr", "Sr.", "Sr", "II", "III", "IV", "V"];
  let suffix = "";
  if (suffixes.includes(parts[parts.length - 1])) {
    suffix = parts.pop();
  }

  const last = parts.pop();
  const given = parts.join(" ");
  const inverted = last + ", " + given + (suffix ? ", " + suffix : "");
  return role ? `${inverted}, ${role.role}` : inverted;
}

function extractEditorRoleSuffix(name) {
  const cleaned = cleanCitationText(name);
  const match = cleaned.match(/^(.*?),\s*(eds?\.?)$/i);
  if (!match) {
    return null;
  }
  return {
    name: trimAuthorName(match[1]),
    role: normalizeEditorRoleToken(match[2]),
  };
}

function containsNonLatinScript(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /[\p{L}]/u.test(cleaned) &&
    /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(cleaned);
}

function extractLineCitationFields(lines) {
  const titlePageFields = extractTitlePageCitationFields(lines);
  const catalogFields = extractCatalogCitationFields(lines);

  if (shouldPreferCatalogCitationFields(titlePageFields, catalogFields)) {
    return preferCitationFields(catalogFields, titlePageFields);
  }

  return titlePageFields;
}

function extractTitlePageCitationFields(lines) {
  const candidates = lines.filter(line => isUsefulFrontMatterLine(line.text));
  const title = chooseTitleLine(candidates);
  const author = title ? chooseAuthorLine(candidates, title.index) : "";
  const responsibility = title ? chooseResponsibilityStatement(candidates, title.index) : "";
  const series = title ? chooseSeriesStatement(candidates, title.index) : "";
  const edition = title ? chooseEditionStatement(candidates, title.index) : "";
  const publication = choosePublicationStatement(lines);
  const titleText = title ? collectTitleText(lines, title) : "";

  return {
    contributor: author,
    title: titleText,
    responsibility,
    series,
    edition,
    publication,
    fallback: title?.text || lines[0]?.text || "",
  };
}

function extractCatalogCitationFields(lines) {
  const cleanLines = lines
    .map(line => cleanFrontMatterLine(line.text))
    .filter(Boolean);
  const titleIndex = cleanLines.findIndex(line => /^title\s*:/i.test(line));
  if (titleIndex < 0) {
    return emptyCitationFields();
  }

  const titleParts = [cleanLines[titleIndex].replace(/^title\s*:\s*/i, "")];
  for (const line of cleanLines.slice(titleIndex + 1, titleIndex + 5)) {
    if (isCatalogControlLine(line)) break;
    titleParts.push(line);
  }

  const titleStatement = cleanCitationText(titleParts.join(" "));
  const [rawTitle, rawContributor = ""] = titleStatement.split(/\s+\/\s+/, 2);
  if (!rawTitle) {
    return emptyCitationFields();
  }

  const description = cleanLines.find(line => /^description\s*:/i.test(line)) || "";
  const edition = extractEditionFromCatalogDescription(description);

  return {
    contributor: cleanAuthorLine(rawContributor.replace(/\s*\|.*$/g, "").replace(/[.;:]+$/g, "")),
    title: formatCatalogTitle(rawTitle.replace(/\s+:\s+/g, ": ")),
    responsibility: "",
    series: "",
    edition,
    publication: choosePublicationStatement(lines),
    fallback: titleStatement,
  };
}

function emptyCitationFields() {
  return {
    contributor: "",
    title: "",
    responsibility: "",
    series: "",
    edition: "",
    publication: "",
    fallback: "",
  };
}

function shouldPreferCatalogCitationFields(titlePageFields, catalogFields) {
  if (!catalogFields.title) {
    return false;
  }

  if (!titlePageFields.title) {
    return true;
  }

  if (looksLikeCatalogControlLine(titlePageFields.title) || looksLikePublisherLine(titlePageFields.title)) {
    return true;
  }

  return titlePageFields.contributor && titleContainsText(catalogFields.title, titlePageFields.contributor);
}

function preferCitationFields(preferred, fallback) {
  return {
    contributor: preferred.contributor || fallback.contributor,
    title: preferred.title || fallback.title,
    responsibility: preferred.responsibility || fallback.responsibility,
    series: preferred.series || fallback.series,
    edition: preferred.edition || fallback.edition,
    publication: preferred.publication || fallback.publication,
    fallback: preferred.fallback || fallback.fallback,
  };
}

function extractEditionFromCatalogDescription(description) {
  const match = cleanFrontMatterLine(description)
    .replace(/^description\s*:\s*/i, "")
    .match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?)\s+edition\b/i);
  return match ? sentenceCaseText(match[0]) : "";
}

function formatCatalogTitle(text) {
  const smallWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of", "on", "or", "the", "to", "with"]);
  let capitalizeNext = true;
  return cleanCitationText(text)
    .toLocaleLowerCase("en")
    .replace(/\b[\p{L}'’-]+\b/gu, (word, offset, source) => {
      const lower = word.toLocaleLowerCase("en");
      const replacement = capitalizeNext || !smallWords.has(lower)
        ? lower.charAt(0).toLocaleUpperCase("en") + lower.slice(1)
        : lower;
      const after = source.slice(offset + word.length).trimStart();
      capitalizeNext = /^[:.!?]/.test(after);
      return replacement;
    });
}

function isCatalogControlLine(text) {
  return /^(names|title|description|identifiers|subjects|classification|lc\s+record|cover\s+(design|art))\s*:/i.test(cleanFrontMatterLine(text));
}

function looksLikeCatalogControlLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /^published\b/i.test(cleaned) || isCatalogControlLine(cleaned);
}

function buildHeadingSuggestion(lines) {
  return buildCitationFromExtractedFields(extractLineCitationFields(lines));
}

function buildCitationFromExtractedFields(fields) {
  const parts = [];
  if (fields.contributor) {
    parts.push(formatChicagoBibliographyAuthors(fields.contributor));
  }
  if (fields.title) {
    parts.push(fields.title);
  }
  if (fields.responsibility) {
    parts.push(fields.responsibility);
  }
  if (fields.series) {
    parts.push(fields.series);
  }
  if (fields.edition) {
    parts.push(fields.edition);
  }
  if (fields.publication) {
    parts.push(fields.publication);
  }

  if (parts.length > 0) {
    return cleanCitationText(parts.map(punctuateCitationPart).join(" "));
  }

  return cleanCitationText(fields.fallback || "");
}

function chooseTitleLine(lines) {
  const maxFontSize = Math.max(...lines.map(line => line.fontSize || 0));
  const scored = lines.map(line => ({
    ...line,
    score: scoreTitleCandidate(line, maxFontSize),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score > 0 ? scored[0] : null;
}

function collectTitleText(lines, title) {
  const titleLines = [title];
  collectAdjacentTitleLines(lines, title, -1)
    .reverse()
    .forEach(line => titleLines.unshift(line));
  collectAdjacentTitleLines(lines, title, 1)
    .forEach(line => titleLines.push(line));

  const subtitleIndex = titleLines.findIndex((line, index) => index > 0 && looksLikeSubtitleLine(line.text));
  if (subtitleIndex > 0) {
    const mainTitle = formatCitationTitle(titleLines.slice(0, subtitleIndex).map(line => line.text).join(" "));
    const subtitle = formatCitationTitle(titleLines.slice(subtitleIndex).map(line => line.text).join(" "));
    return cleanCitationText(`${mainTitle}: ${subtitle}`);
  }

  return formatCitationTitle(titleLines.map(line => line.text).join(" "));
}

function collectAdjacentTitleLines(lines, title, direction) {
  const titleLines = [];
  let nextIndex = title.index + direction;

  while (titleLines.length < 3) {
    const next = lines.find(line => line.index === nextIndex);
    if (!next || !isTitleContinuationLine(next, title, direction)) {
      break;
    }

    titleLines.push(next);
    nextIndex += direction;
  }

  return titleLines;
}

function isTitleContinuationLine(line, title, direction = 1) {
  const text = cleanFrontMatterLine(line.text);
  const wordCount = text.split(/\s+/).length;
  if (!text || wordCount > 9) return false;
  if (line.pageNumber !== title.pageNumber) return false;
  if (title.fontSize && line.fontSize && line.fontSize < title.fontSize * 0.72) {
    if (!(direction > 0 && line.fontSize >= title.fontSize * 0.45 && looksLikeSubtitleLine(text))) {
      return false;
    }
  }
  if (/^(by|par)$/i.test(text)) return false;
  if (looksLikeSeriesLine(text)) return false;
  if (looksLikeEditionLine(text)) return false;
  if (looksLikeResponsibilityRoleLine(text)) return false;
  if (looksLikeSubtitleLine(text)) return true;
  if (looksLikeAuthorLine(text) && !(isMostlyAllCaps(text) && title.fontSize && line.fontSize >= title.fontSize * 0.72)) return false;
  return scoreTitleCandidate(line) > 0;
}

function chooseAuthorLine(lines, titleIndex) {
  const title = lines.find(line => line.index === titleIndex);
  const titleLineIndexes = getTitleLineIndexes(lines, title);
  const authorBeforeTitle = lines
    .filter(line => (
      line.index < titleIndex &&
      line.index >= titleIndex - 6 &&
      !titleLineIndexes.has(line.index) &&
      looksLikeAuthorLine(line.text) &&
      !looksLikeSeriesLine(line.text)
    ))
    .sort((a, b) => b.index - a.index);

  if (authorBeforeTitle.length > 0) {
    return collectAuthorText(lines, authorBeforeTitle[0]);
  }

  const authorWindow = lines.filter(line => (
    line.index > titleIndex &&
    line.index <= titleIndex + 6 &&
    !titleLineIndexes.has(line.index) &&
    looksLikeAuthorLine(line.text)
  ));

  return authorWindow.length ? collectAuthorText(lines, authorWindow[0]) : "";
}

function getTitleLineIndexes(lines, title) {
  if (!title) return new Set();
  return new Set([
    title.index,
    ...collectAdjacentTitleLines(lines, title, -1).map(line => line.index),
    ...collectAdjacentTitleLines(lines, title, 1).map(line => line.index),
  ]);
}

function collectAuthorText(lines, firstAuthorLine) {
  const authorLines = [firstAuthorLine];
  let nextIndex = firstAuthorLine.index + 1;

  while (authorLines.length < 4) {
    const next = lines.find(line => line.index === nextIndex);
    if (!next || !looksLikeAuthorLine(next.text)) break;
    authorLines.push(next);
    nextIndex += 1;
  }

  return cleanAuthorLine(authorLines.map(line => trimTerminalPeriod(line.text)).join(", "));
}

function chooseResponsibilityStatement(lines, titleIndex) {
  const window = lines.filter(line => (
    line.index > titleIndex &&
    line.index <= titleIndex + 18
  ));

  const direct = window.find(line => looksLikeDirectResponsibilityLine(line.text));
  if (direct) {
    return normalizeResponsibilityStatement(direct.text);
  }

  const byIndex = window.findIndex(line => /^(by|par)$/i.test(cleanFrontMatterLine(line.text)));
  if (byIndex <= 0 || byIndex >= window.length - 1) {
    return "";
  }

  const roleLines = window
    .slice(Math.max(0, byIndex - 6), byIndex)
    .filter(line => looksLikeResponsibilityRoleLine(line.text))
    .map(line => line.text);
  const name = normalizeContributorName(window[byIndex + 1].text);

  if (roleLines.length === 0 || !looksLikeContributorName(name)) {
    return "";
  }

  const connector = /^par$/i.test(cleanFrontMatterLine(window[byIndex].text)) ? "par" : "by";
  return cleanCitationText(`${formatResponsibilityRoles(roleLines)} ${connector} ${name}`);
}

function chooseSeriesStatement(lines, titleIndex) {
  const window = lines.filter(line => (
    line.index >= titleIndex - 8 &&
    line.index <= titleIndex + 8 &&
    looksLikeSeriesLine(line.text)
  ));
  if (window.length === 0) return "";

  const seriesLine = window.find(line => /\bseries\b|sources?\s+chr[ée]tiennes?/i.test(line.text));
  const numberLine = window.find(line => /^(volume|vol\.?|n[°o]|no\.?)\b/i.test(cleanFrontMatterLine(line.text)));

  if (seriesLine && numberLine && seriesLine !== numberLine) {
    return cleanCitationText(`${formatSeriesLine(seriesLine.text)}, ${formatSeriesLine(numberLine.text)}`);
  }

  return formatSeriesLine((seriesLine || numberLine || window[0]).text);
}

function chooseEditionStatement(lines, titleIndex) {
  const edition = lines.find(line => (
    line.index > titleIndex &&
    line.index <= titleIndex + 10 &&
    looksLikeEditionLine(line.text)
  ));
  return edition ? sentenceCaseText(edition.text) : "";
}

function formatSeriesLine(text) {
  const cleaned = cleanFrontMatterLine(text)
    .replace(/^n[°o]\s*/i, "")
    .replace(/^no\.?\s*/i, "")
    .replace(/^volume\s+/i, "volume ")
    .replace(/^vol\.?\s+/i, "volume ");
  return /^volume\b/i.test(cleaned) || /^\d+$/.test(cleaned)
    ? cleaned.toLocaleLowerCase("en")
    : formatCitationTitle(cleaned);
}

function choosePublicationStatement(lines) {
  const publisherInfo = findPublisherInfo(lines);
  const year = findPublicationYear(lines);
  return buildPublicationBlock(publisherInfo.city, publisherInfo.publisher, year);
}

function findPublicationYear(lines) {
  const yearLine = lines.find(line => /\b(copyright|first printing|published|publication|édition|impression)\b/i.test(line.text) && extractYear(line.text)) ||
    lines.find(line => extractYear(line.text));
  return yearLine ? extractYear(yearLine.text) : "";
}

function extractYear(text) {
  const match = String(text || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return match ? match[1] : "";
}

function findPublisherInfo(lines) {
  let best = { publisher: "", city: "", score: 0 };
  for (const line of lines) {
    const info = parsePublisherLine(line.text);
    if (info.publisher) {
      if (!info.city) {
        const nearbyPlace = lines
          .filter(candidate => candidate.index > line.index && candidate.index <= line.index + 4)
          .map(candidate => findPlaceInText(candidate.text))
          .find(Boolean);
        info.city = nearbyPlace || "";
      }
      const score = scorePublisherInfo(info, line.text);
      if (score > best.score) {
        best = { ...info, score };
      }
    }
  }
  return { publisher: best.publisher, city: best.city };
}

function scorePublisherInfo(info, sourceText) {
  let score = 1;
  if (info.city) score += 3;
  if (/\b(published by|éditions?|press|publisher|publishing|inc\.?|co\.?|company|sarl|sons?|wiley|jossey|bass|guilford|cerf)\b/i.test(sourceText)) score += 2;
  if (/\b(copyright|©)\b/i.test(sourceText)) score += 1;
  if (info.publisher.length > 8) score += 1;
  return score;
}

function parsePublisherLine(text) {
  let cleaned = cleanFrontMatterLine(text);
  if (!cleaned) return { publisher: "", city: "" };

  const publishedBy = cleaned.match(/^published by\s+(.+)$/i);
  if (publishedBy) cleaned = publishedBy[1];

  cleaned = cleaned
    .replace(/^copyright\s*©?\s*(?:\d{4}\s*)?(?:by\s+)?/i, "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/\ball rights reserved\b/ig, "")
    .replace(/\btous droits réservés\b/ig, "")
    .trim();

  if (!looksLikePublisherLine(cleaned)) return { publisher: "", city: "" };

  const dashParts = cleaned.split(/\s+[–-]\s+/).map(part => cleanFrontMatterLine(part)).filter(Boolean);
  if (dashParts.length > 1) {
    return {
      publisher: normalizePublisherName(dashParts[0]),
      city: findPlaceInText(dashParts.slice(1).join(", ")),
    };
  }

  const commaParts = cleaned.split(/\s*,\s*/).map(part => cleanFrontMatterLine(part)).filter(Boolean);
  if (/^published by/i.test(text) && commaParts.length > 1) {
    const publisherPartCount = commaParts.length >= 3 && /\b(inc\.?|co\.?|company|sons?)$/i.test(commaParts[1]) ? 2 : 1;
    return {
      publisher: normalizePublisherName(commaParts.slice(0, publisherPartCount).join(", ")),
      city: findPlaceInText(commaParts.slice(publisherPartCount).join(", ")),
    };
  }

  return {
    publisher: normalizePublisherName(cleaned),
    city: findPlaceInText(cleaned),
  };
}

function looksLikePublisherLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  if (!cleaned || looksLikeResponsibilityRoleLine(cleaned)) return false;
  if (looksLikeNonPublisherCredit(cleaned)) return false;
  if (/^(?:발행처|출판사|펴낸곳|펴낸 곳|출판|발행)\s*[:：]?/u.test(cleaned)) return true;
  return /\b(press|publisher|publishers|publishing|university|college|éditions?|editiones|books?|inc\.?|co\.?|company|sarl|sons?|wiley|jossey|bass|guilford|excelsis|leaders for leaders|hana medical|cerf)\b/i.test(cleaned);
}

function normalizePublisherName(text) {
  let cleaned = cleanFrontMatterLine(text);
  const labeledPublisher = cleaned
    .split(/\s*[,;]\s*/u)
    .map(part => cleanFrontMatterLine(part))
    .reverse()
    .find(part => /^(?:발행처|출판사|펴낸곳|펴낸 곳|출판|발행)\s*[:：]?/u.test(part));
  if (labeledPublisher) {
    cleaned = labeledPublisher;
  }

  cleaned = cleaned
    .replace(/^(?:발행처|출판사|펴낸곳|펴낸 곳|출판|발행)\s*[:：]?\s*/u, "")
    .replace(/\s+site internet\b.*$/i, "")
    .replace(/\s+www\..*$/i, "")
    .replace(/\s+all rights reserved.*$/i, "")
    .replace(/[,;:]+$/g, "");
  if (looksLikeNonPublisherCredit(cleaned)) return "";
  return /\b(inc|co|ltd|corp)\.$/i.test(cleaned) ? cleaned : cleaned.replace(/\.$/, "");
}

function looksLikeNonPublisherCredit(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /^(?:꾸밈|디자인|표지|편집|제작|본문|교정|인쇄)(?=$|\s|[,;:：])/u.test(cleaned) ||
    /(?:꾸밈|디자인|표지\s*디자인)\s*[:：]/u.test(cleaned);
}

function findPlaceInText(text) {
  const cleaned = cleanFrontMatterLine(text).replace(/\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/ig, "");
  const koreanPlace = cleaned.match(/(?:^|[\s,;:])((?:서울|서울시|부산|부산시|대구|대구시|인천|인천시|광주|광주시|대전|대전시|울산|울산시|세종|세종시|제주|제주시|[가-힣]{2,}(?:시|도|군)))(?=$|[\s,;:])/u);
  if (koreanPlace) return koreanPlace[1];
  const matches = [...cleaned.matchAll(/\b([\p{Lu}][\p{L}' .-]+,\s*(?:[A-Z]{2}|[\p{Lu}][\p{L}' .-]+|France|Korea|New Jersey))\b/gu)];
  for (const match of matches.reverse()) {
    const place = cleanFrontMatterLine(match[1]).replace(/[.,;:]+$/g, "");
    if (!/\b(inc|co|company|sons?|press|publisher|publishing|wiley|jossey|bass)\b/i.test(place)) {
      return place;
    }
  }
  return "";
}

function scoreTitleCandidate(line, maxFontSize = 0) {
  const text = line.text;
  const wordCount = text.split(/\s+/).length;
  let score = 0;

  if (line.pageNumber <= 3) score += 4;
  if (wordCount >= 2 && wordCount <= 14) score += 4;
  if (line.fontSize >= 12) score += 2;
  if (maxFontSize && line.fontSize && line.fontSize < maxFontSize * 0.72) score -= 5;
  if (maxFontSize && line.fontSize && line.fontSize >= maxFontSize * 0.9) score += 3;
  if (/^[A-Z0-9][A-Za-z0-9'":;,.& -]+$/.test(text)) score += 2;
  if (/[a-z]/.test(text) && /[A-Z]/.test(text)) score += 1;
  if (/^(edited by|translated by|by|chapter|contents|table of contents)\b/i.test(text)) score -= 5;
  if (/^(by|par)$/i.test(text)) score -= 8;
  if (looksLikeSeriesLine(text)) score -= 7;
  if (looksLikeEditionLine(text)) score -= 7;
  if (looksLikeResponsibilityRoleLine(text)) score -= 8;
  if (looksLikePublisherLine(text)) score -= 8;
  if (/^a\s+\w+\s+brand$/i.test(cleanFrontMatterLine(text))) score -= 8;
  if (looksLikeAuthorLine(text) && !(isMostlyAllCaps(text) && maxFontSize && line.fontSize >= maxFontSize * 0.9)) score -= 5;
  if (isMostlyAllCaps(text) && wordCount <= 3) score -= 1;

  return score;
}

function looksLikeAuthorLine(text) {
  const cleaned = cleanAuthorLine(text);
  if (!cleaned) return false;
  if (/^(edited|translated|compiled|introduction|foreword|preface)\b/i.test(cleaned)) return false;
  if (looksLikeSeriesLine(cleaned)) return false;
  if (looksLikeEditionLine(cleaned)) return false;

  const words = cleaned.split(/\s+/);
  if (words.length < 2 || words.length > 8) return false;
  if (/^(a|an|and|for|in|of|on|or|the|to|with)\b/i.test(cleaned)) return false;
  if (/[0-9]/.test(cleaned)) return false;
  if (/[;:]/.test(cleaned)) return false;
  if (words.length > 4 && !cleaned.includes(",")) return false;

  return splitAuthorNames(cleaned).some(name => looksLikePersonalName(name));
}

function looksLikeSeriesLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /^(sources?\s+chr[ée]tiennes?|n[°o]\s*\d+|series|volume|vol\.?)\b/i.test(cleaned) ||
    /\bseries\b/i.test(cleaned);
}

function looksLikeEditionLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?|premi[èe]re|deuxi[èe]me|troisi[èe]me)\s+(edition|ed\.?|édition|réimpression)\b/i.test(cleaned) ||
    /\b(edition|ed\.?|édition|réimpression)\b/i.test(cleaned) && cleaned.split(/\s+/).length <= 6;
}

function looksLikeSubtitleLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  if (!cleaned || isMostlyAllCaps(cleaned)) return false;
  if (looksLikeSeriesLine(cleaned)) return false;
  if (looksLikeResponsibilityRoleLine(cleaned)) return false;

  const words = cleaned.split(/\s+/);
  if (words.length < 2 || words.length > 14) return false;

  const hasTitleConnector = /\b(a|an|and|for|from|how|in|of|on|or|the|to|with|why)\b/i.test(cleaned);
  if (looksLikeAuthorLine(cleaned) && !hasTitleConnector) return false;

  return /^(a|an|and|for|from|how|in|of|on|or|the|to|with|why)\b/i.test(cleaned) ||
    hasTitleConnector ||
    (/[a-z]/.test(cleaned) && /[A-Z]/.test(cleaned));
}

function looksLikeDirectResponsibilityLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /\b(translated|translation|edited|editor|introduction|introduced|bibliography|bibliographie|notes?|commentary|latin text|texte latin|traduction|traduit|preface|préface|foreword|annotated|annotations?)\b/i.test(cleaned) &&
    /\b(by|par)\b/i.test(cleaned);
}

function looksLikeResponsibilityRoleLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /\b(translated|translation|edited|editor|introduction|introduced|bibliography|bibliographie|notes?|commentary|latin text|texte latin|traduction|traduit|preface|préface|foreword|annotated|annotations?)\b/i.test(cleaned);
}

function normalizeResponsibilityStatement(text, evidenceText = "") {
  const cleaned = stripNonTitleLatinBracketedEquivalents(cleanCitationText(text));
  if (!cleaned) {
    return "";
  }

  const match = cleaned.match(/^(.*?)\b(by|par)\b\s+(.+)$/i);
  if (!match) {
    return sentenceCaseText(cleaned);
  }

  const role = sentenceCaseText(match[1]);
  const connector = /^par$/i.test(match[2]) ? "par" : "by";
  const name = normalizeContributorName(preferOriginalScriptResponsibilityName(match[3], evidenceText));
  return cleanCitationText(`${role} ${connector} ${name}`);
}

function normalizeAiCitationText(text) {
  const cleaned = normalizeEditorRoleLabels(cleanCitationText(text).replace(/\b(by|par)\b\s+([^.;()]*?)(\s*)(?=[.;()]|$)/giu, (_match, connector, names, spacing) => {
    const normalizedConnector = /^par$/i.test(connector) ? "par" : "by";
    return `${normalizedConnector} ${normalizeContributorName(names)}${spacing}`;
  }));

  return normalizeLeadingInvertedInitialAuthorHeading(cleaned);
}

function normalizeEditorRoleLabels(text) {
  const cleaned = cleanCitationText(text);
  if (!cleaned) {
    return "";
  }

  return cleanCitationText(cleaned.replace(/,\s*(?:(?:general|series)\s+)?editors?\b\.?/giu, match => {
    return `, ${/\beditors\b/i.test(match) ? "eds." : "ed."}`;
  }));
}

function isEditorRoleToken(text) {
  return /^(?:(?:general|series)\s+)?editors?\.?$/i.test(cleanCitationText(text)) ||
    /^eds?\.?$/i.test(cleanCitationText(text));
}

function normalizeEditorRoleToken(text) {
  return /\beditors\b|^eds/i.test(cleanCitationText(text)) ? "eds." : "ed.";
}

function stripNonTitleLatinBracketedEquivalents(text) {
  const cleaned = cleanCitationText(text);
  if (!containsNonLatinScript(cleaned)) {
    return cleaned;
  }

  return cleanCitationText(cleaned.replace(/\s*\[([^\[\]]+)\]/gu, (match, bracketed) => {
    return containsNonLatinScript(bracketed) ? match : "";
  }));
}

function preferOriginalScriptResponsibilityName(name, evidenceText) {
  const cleanedName = cleanCitationText(name);
  if (!cleanedName || containsNonLatinScript(cleanedName)) {
    return cleanedName;
  }

  const evidenceName = extractOriginalScriptResponsibilityName(evidenceText);
  return evidenceName || cleanedName;
}

function preferFullerOriginalScriptEvidenceValue(value, evidenceText) {
  const cleanedValue = stripNonTitleLatinBracketedEquivalents(value);
  const cleanedEvidence = stripNonTitleLatinBracketedEquivalents(evidenceText);
  if (!cleanedValue || !cleanedEvidence) {
    return cleanedValue;
  }
  if (!containsNonLatinScript(cleanedEvidence) || !cleanedEvidence.includes(cleanedValue)) {
    return cleanedValue;
  }
  if (cleanedEvidence.length <= cleanedValue.length || cleanedEvidence.length > 80) {
    return cleanedValue;
  }
  if (/[.;]/.test(cleanedEvidence)) {
    return cleanedValue;
  }

  return cleanedEvidence;
}

function preferLabeledPublisherEvidence(value, evidenceText) {
  const cleanedValue = stripNonTitleLatinBracketedEquivalents(value);
  const evidencePublisher = normalizePublisherName(evidenceText);
  if (!evidencePublisher) {
    return cleanedValue;
  }
  if (/^(?:발행처|출판사|펴낸곳|펴낸 곳|출판|발행)\s*[:：]?/u.test(cleanCitationText(evidenceText))) {
    return evidencePublisher;
  }
  return cleanedValue || evidencePublisher;
}

function extractOriginalScriptResponsibilityName(text) {
  const cleaned = cleanCitationText(text);
  if (!containsNonLatinScript(cleaned)) {
    return "";
  }

  const koreanTranslator = cleaned.match(/([가-힣]{2,}(?:\s+[가-힣]{2,}){0,2})\s*(?:옮김|번역|역자|역)\b/u);
  if (koreanTranslator) {
    return cleanCitationText(koreanTranslator[1]);
  }

  const nonLatinRuns = [...cleaned.matchAll(/(?:[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}][\p{Script=Common}\p{Script=Inherited}]*){2,}/gu)]
    .map(match => cleanCitationText(match[0]).replace(/\s*(?:옮김|번역|역자|역|지음|저)\s*$/u, "").trim())
    .filter(candidate => candidate && containsNonLatinScript(candidate) && candidate.length <= 40);

  return nonLatinRuns[0] || "";
}

function formatResponsibilityRoles(lines) {
  return sentenceCaseText(cleanCitationText(lines.join(", ")));
}

function normalizeContributorName(text) {
  return stripNameCredentials(text)
    .replace(/[.,;:]+$/g, "")
    .replace(/\b[\p{L}'’-]+\b/gu, word => (
      word.length > 1 && word === word.toLocaleUpperCase("fr")
        ? word.charAt(0).toLocaleUpperCase("fr") + word.slice(1).toLocaleLowerCase("fr")
        : word
    ));
}

function normalizeLeadingInvertedInitialAuthorHeading(text) {
  const cleaned = cleanCitationText(text);
  const leading = splitLeadingInvertedInitialAuthor(cleaned);
  if (!leading) {
    return cleaned;
  }

  return cleanCitationText(`${leading.author} ${leading.rest}`);
}

function splitLeadingInvertedInitialAuthor(text) {
  const cleaned = cleanCitationText(text);
  const match = cleaned.match(/^([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){0,3}),\s*(?:and\s+)?(((?:[\p{Lu}][\p{L}'’-]*\.?\s+){0,3}[A-Z]\.))\s+(.+)$/u);
  if (!match) {
    return null;
  }

  const rest = cleanCitationText(match[4]);
  if (!/^[`'‘’"“”]?\p{Lu}/u.test(rest)) {
    return null;
  }

  return {
    author: cleanCitationText(`${match[1]}, ${match[2]}`),
    rest,
  };
}

function stripNameCredentials(text) {
  let cleaned = cleanCitationText(text)
    .replace(/^[`'‘’"“”]+/g, "")
    .replace(new RegExp(`\\s*,\\s*${COMMA_NAME_CREDENTIAL_PATTERN}\\.?\\s*(?=,)`, "giu"), "")
    .replace(new RegExp(`\\s+${NAME_CREDENTIAL_PATTERN}\\.?\\s*(?=,)`, "giu"), "");

  let previous = "";
  while (cleaned && cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned
      .replace(new RegExp(`\\s*,\\s*${COMMA_NAME_CREDENTIAL_PATTERN}\\.?\\s*$`, "iu"), "")
      .replace(new RegExp(`\\s+${NAME_CREDENTIAL_PATTERN}\\.?\\s*$`, "iu"), "")
      .replace(/[,\s]+$/g, "")
      .trim();
  }

  if (new RegExp(`^(?:${COMMA_NAME_CREDENTIAL_PATTERN}|${NAME_CREDENTIAL_PATTERN})\\.?$`, "iu").test(cleaned)) {
    return "";
  }

  return cleaned;
}

function looksLikeContributorName(text) {
  const cleaned = cleanCitationText(text);
  if (!cleaned || cleaned.length > 80) return false;
  if (/[0-9]/.test(cleaned)) return false;
  if (/\b(directeur|director|professor|universit|école|school|press|publisher)\b/i.test(cleaned)) return false;
  if (containsNonLatinScript(cleaned) && /^[\p{L}\s,.·-]{2,20}$/u.test(cleaned)) return true;
  return cleaned.split(/\s+/).length >= 2;
}

function sentenceCaseText(text) {
  const cleaned = cleanCitationText(text).toLocaleLowerCase("fr");
  return cleaned ? cleaned.charAt(0).toLocaleUpperCase("fr") + cleaned.slice(1) : "";
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUsefulFrontMatterLine(text) {
  if (!text || text.length < 3 || text.length > 140) return false;
  if (/^\d+$/.test(text)) return false;
  if (looksLikeCatalogControlLine(text)) return false;
  if (/^(copyright|all rights reserved|printed in|library of congress|isbn|issn|doi|www\.|http|publisher|published by|contents|table of contents)$/i.test(text)) return false;
  if (/(copyright|all rights reserved|library of congress|isbn|issn|cataloging|cataloguing|manufactured in|printed in|permission|rights reserved)/i.test(text)) return false;
  if (/^[.\-_/\\|]+$/.test(text)) return false;
  return true;
}

function cleanFrontMatterLine(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\((?:p(?:age)?\.?\s*)?\d+\)\s*(?=[,.;:]|$)/ig, "")
    .replace(/\s*\[\s*(?:p(?:age)?\.?\s*)?\d+\s*\]\s*(?=[,.;:]|$)/ig, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([(["'])\s+/g, "$1")
    .replace(/\s+([)\]"'])/g, "$1")
    .trim();
}

function cleanAuthorLine(text) {
  return stripNameCredentials(repairSplitInitialSurname(cleanFrontMatterLine(text)
    .replace(/^by\s+/i, "")
    .replace(/^author\s*:\s*/i, "")
    .replace(/^(?:지은이|저자|글쓴이|옮긴이|역자|번역)\s*[:：]?\s*/u, "")
    .replace(/\s+(?:지음|저|著)\s*$/u, "")))
    .trim();
}

function repairSplitInitialSurname(text) {
  return cleanFrontMatterLine(text)
    .replace(/\b([A-Z]\.?)\s+(?:and|&)\s+(\p{Lu}[\p{L}'’-]+)(?=\s*(?:$|[,.;:)]))/gu, "$1 $2");
}

function cleanCitationText(text) {
  return cleanFrontMatterLine(text)
    .replace(/\s*,\s*,/g, ",")
    .replace(/\s+,\s+/g, ", ")
    .trim();
}

function isMostlyAllCaps(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return false;
  const uppercase = letters.replace(/[^A-Z]/g, "").length;
  return uppercase / letters.length > 0.85;
}
