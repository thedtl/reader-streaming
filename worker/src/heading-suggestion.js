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
      downloadVolume: null,
      source: "none",
      note: "No usable front-matter text was provided.",
    }, request, env);
  }

  if (!env.GEMINI_API_KEY) {
    return helpers.json({
      heading: "", downloadVolume: null, source: "unavailable",
      note: "The metadata reader is not configured. Enter the citation manually; chapter links can still be generated.",
    }, request, env);
  }

  try {
    const suggestion = await suggestHeadingWithGemini(lines, images, { sourceAuthorHint, sourceTitleHint }, env);
    return helpers.json({
      ...suggestion,
      source: suggestion.heading ? "ai" : "none",
      note: suggestion.heading
        ? "Read from the supplied pages. Please review the citation."
        : "The scan could not establish a title and contributor. Enter the citation manually; chapter links can still be generated.",
    }, request, env);
  } catch (error) {
    // Fetch exceptions may include a URL bearing the API key. Log only safe
    // diagnostic fields, never provider bodies or the exception's raw message.
    console.warn("Gemini heading suggestion failed", {
      name: error.name, status: error.status || null,
      finishReason: error.finishReason || null,
    });
    return helpers.json({
      heading: "", downloadVolume: null, source: "unavailable",
      note: "The metadata scan failed. Try the scan again or enter the citation manually; chapter links can still be generated.",
    }, request, env);
  }
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
    "For every script, the rendered page image is primary; the selectable PDF text below is unverified and may be badly corrupted OCR. Read the visible title page and imprint, not just the cover or text excerpts. Never copy a garbled text-layer spelling over clearly visible image text. If the image is unreadable, leave the field blank rather than guessing.",
    "Read the complete title block across stacked lines, including its subtitle. Distinguish an honoree or dedication from the book's authors/editors. Read names together with their visible responsibility labels; 'Edited by' is not a person's name.",
    "Use the author name exactly as it appears on the title page. Do not expand, correct, or formalize it from copyright text; for example, if the title page says Tim Arnold and the copyright page says Timothy Arnold, use Tim Arnold.",
    "For non-Latin-script contributor names or titles, keep the visible non-Latin text first. If a visible English or Latin-script equivalent is also present, add it immediately after in square brackets, for example: 해돈 W. 로빈슨 [Haddon W. Robinson]. 성경 강해설교 강해설교 전개와 전달 [Biblical Preaching The Development and Delivery of Expository Messages].",
    "For non-Latin-script contributor names, include only a romanized contributor name in square brackets. Do not use a translated title, filename, URL slug, MMS ID, or other source identifier as the bracketed contributor form.",
    "For titles, never put a romanization or transliteration in the square brackets. Use the translated title in square brackets instead, for example: 영성 목회와 영적 지도 [The Pastor as Spiritual Guide], not 영성 목회와 영적 지도 [Yeongseong Mokhoe wa Yeongjeok Jido]: The Pastor as Spiritual Guide.",
    "For non-Latin-script titles, always include one English translated title in square brackets. If a filename/title hint is provided below, use it only for this bracketed English title; do not use it to replace the visible original-script title or contributor.",
    "For any non-Latin-script title/subtitle pair, do not bracket the main title and subtitle separately. Use one bracketed English equivalent after the full non-Latin title/subtitle, for example: 성경 강해설교: 강해설교 전개와 전달 [Biblical Preaching: The Development and Delivery of Expository Messages].",
    "Do not translate, romanize, or bracket equivalents for series titles, place names, publisher names, or responsibility names. Keep those fields in the full visible original form unless the source only shows a Latin-script form.",
    "For multiple authors, include them in Chicago bibliography order. For editors with no author, use ed. or eds. in the contributor field.",
    "For collected works, letters, journals or diaries of an explicitly identified original author, cite that original author first; put the observed editors and translators in responsibilityStatement after the title. 'Works of [person]' can identify authorship; merely naming a person as a biography's subject cannot. Do not replace the original author with this edition's editors.",
    "Reconcile the series/half-title and volume title pages before choosing the citation: distinguish the original author, volume editors, and general/series editors. A general editor of the set is not automatically the editor of this volume. Preserve the collective work title, this volume's specific title, volume number and title date span when visible; a series name or volume number alone is not the book title.",
    "Keep personal initials attached to the same name, including initials before a spelled-out given name and multiple editors. Preserve parenthetical dates and numbers that belong to titles; only explicit source locators such as '(Page 4)' are to be omitted.",
    "For an editor who belongs in this volume's citation, format role labels such as General Editor as ed. or eds., not the words General Editor. This formatting rule does not establish contributor identity or override a distinct original author.",
    "If the title page identifies a book-level editor with phrases such as edited by, ouvrage édité par, edited and introduced by, or texte établi par, cite the whole book under that editor with ed. or eds. unless a distinct author is clearly identified.",
    "Do not treat names introduced only by with the collaboration of, avec la collaboration de, contributors, chapter authors, article authors, or table-of-contents entries as book-level authors/editors. Omit those names from the whole-book heading unless the request is for that specific chapter or article.",
    "Never omit named title-page contributors who supply a specific book-level responsibility. If the title page says a person supplied introduction, bibliography, translation, notes, commentary, edition, Latin text, or similar book-level work, capture that as responsibilityStatement and include it after the title.",
    "For translator or responsibility statements, use Chicago-style natural order after the role, such as Translated by 최대형. Prefer the visible original-script name when present; do not invert it as Choi, Dae-Hyung and do not add a bracketed romanization.",
    "For French title-page statements such as 'TEXTE LATIN / INTRODUCTION, BIBLIOGRAPHIE / TRADUCTION ET NOTES / par / René Roques', include: Texte latin, introduction, bibliographie, traduction et notes par René Roques.",
    "Normalize OCR all-caps surnames in responsibility names, such as Laure SOLIGNAC, to normal name capitalization. Omit trailing credential initials and religious/order credentials such as Ph.D., S.J., O.P., and OFM Cap. from all contributor names unless the credential is part of a title.",
    "Do not put title, subtitle, series, or edition text in contributor. For example, if a title page says 'ADULT LEARNING / Linking Theory and Practice / Second Edition / Laura L. Bierema, Monica Fedeli, Sharan B. Merriam', contributor is the three named people, title is Adult Learning: Linking Theory and Practice, and edition is Second Edition.",
    "An edition statement such as Second Edition is never the title by itself; put it in edition and keep looking for the actual title.",
    "Extract series title and series volume/number when they are clearly visible as a separate series statement, especially for commentary series or multi-volume sets. Do not move words from the displayed title block into series.",
    "Separately, fill multiVolumeWorkTitle and workVolume only when this is a numbered volume of the same multi-volume work under a common collective title. A publisher's academic series containing distinct books is not a multi-volume work, even when its books have series numbers; leave both fields blank for such series or an uncertain relationship. Keep ordinary series details in the citation fields above.",
    "multiVolumeWorkTitle is the visibly stated common work title; workVolume is this volume's complete observed designation, preserving its language and numeral form. Copy both verbatim apart from whitespace, with the exact supporting words in the same visibleEvidence fields. Do not infer either from filenames, hints, order, or a bare series number. Leave both blank if either is not visible. These download fields do not replace or shorten the full bibliographic heading.",
    "Look for publication facts on copyright/title-page verso pages and final imprint/copyright pages: publisher name, publication place, and publication year.",
    "Use the copyright/publication statement for this book, not the copyright year of quoted scripture, licensed translations, illustrations, or other reproduced material. Read the full statement to identify whose date it is; do not select a year merely because it is the first, last, or largest number. A street address or postal district is not a person's name or part of the publication city.",
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
    "Return JSON only, with this shape: {\"contributor\":\"...\",\"title\":\"...\",\"responsibilityStatement\":\"...\",\"series\":\"...\",\"seriesNumber\":\"...\",\"multiVolumeWorkTitle\":\"...\",\"workVolume\":\"...\",\"edition\":\"...\",\"city\":\"...\",\"publisher\":\"...\",\"year\":\"...\",\"heading\":\"...\",\"visibleEvidence\":{\"contributor\":\"...\",\"title\":\"...\",\"responsibilityStatement\":\"...\",\"series\":\"...\",\"seriesNumber\":\"...\",\"multiVolumeWorkTitle\":\"...\",\"workVolume\":\"...\",\"edition\":\"...\",\"city\":\"...\",\"publisher\":\"...\",\"year\":\"...\",\"heading\":\"...\"},\"warnings\":[\"...\"]}.",
    "",
    sourceAuthorHint ? `Filename/author hint for bracketed contributor form only: ${sourceAuthorHint}` : "",
    sourceTitleHint ? `Filename/title hint for bracketed English title only: ${sourceTitleHint}` : "",
    excerpts ? `Unverified selectable text (may contain OCR errors):\n${excerpts}` : "No selectable text was extracted. Read the attached front-matter page images.",
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
    throw Object.assign(new Error("Metadata provider request failed"), { status: response.status });
  }

  const data = JSON.parse(text || "{}");
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason !== "STOP") {
    throw Object.assign(new Error("Metadata response did not complete"), {
      finishReason: candidate?.finishReason || null,
    });
  }
  const responseText = (candidate?.content?.parts || [])
    .filter(part => !part.thought && typeof part.text === "string")
    .map(part => part.text).join("");
  const parsed = JSON.parse(responseText || "{}");
  logAiCitationSummary(parsed);
  const heading = buildAiCitation(parsed, hints);
  return {
    heading,
    downloadVolume: heading ? buildDownloadVolume(parsed) : null,
  };
}

function buildDownloadVolume(parsed) {
  const evidence = parsed.visibleEvidence;
  const [title, designation] = ["multiVolumeWorkTitle", "workVolume"].map(key => {
    if (typeof parsed[key] !== "string" || typeof evidence?.[key] !== "string") return "";
    const value = parsed[key].replace(/\s+/g, " ").trim();
    return supportedAiField(parsed, evidence, key) && evidence[key].replace(/\s+/g, " ").trim() === value
      ? value
      : "";
  });
  return title && designation ? { title, designation } : null;
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

function buildAiCitation(parsed, hints = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const { sourceAuthorHint = "", sourceTitleHint = "" } = hints || {};
  const evidence = normalizeEvidenceMap(parsed.visibleEvidence || parsed.evidence || {});
  const supportedContributor = supportedAiField(parsed, evidence, "contributor");
  const supportedTitle = supportedAiField(parsed, evidence, "title");
  // Missing or misassigned core fields need review, never reconstruction from
  // the PDF's hidden OCR layer. In particular an edition is not a book title.
  if (!supportedContributor || !supportedTitle || looksLikeEditionLine(supportedTitle)) return "";
  const publicationFields = extractSupportedPublicationFields(parsed, evidence);
  const fallbackHeading = normalizeAiCitationText(
    reconcileAiHeadingPublication(supportedAiHeading(parsed, evidence), publicationFields)
  );

  if (fallbackHeading) {
    return cleanCitationText(fallbackHeading);
  }

  const contributor = normalizeContributorField(
    normalizeContributorFromEvidence(supportedContributor, evidence.contributor),
    sourceAuthorHint
  );
  const title = normalizeTitleField(supportedTitle, sourceTitleHint);
  const responsibilityEvidence = evidence.responsibilityStatement || evidence.responsibility || "";
  const responsibilityStatement = normalizeResponsibilityStatement(
    supportedAiField(parsed, evidence, "responsibilityStatement", ["responsibility"]),
    responsibilityEvidence
  );
  const series = stripNonTitleLatinBracketedEquivalents(supportedAiField(parsed, evidence, "series"));
  const seriesNumber = supportedAiField(parsed, evidence, "seriesNumber");
  const edition = normalizeEditionStatement(supportedAiField(parsed, evidence, "edition"));
  const { city, publisher, year } = publicationFields;

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

function looksLikeEditionLine(text) {
  const cleaned = cleanFrontMatterLine(text);
  return /^(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?|premi[èe]re|deuxi[èe]me|troisi[èe]me|revised|expanded|new)\s+)?(?:edition|ed|édition|réimpression)\.?$/i.test(cleaned);
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

function sentenceCaseText(text) {
  const cleaned = cleanCitationText(text).toLocaleLowerCase("fr");
  return cleaned ? cleaned.charAt(0).toLocaleUpperCase("fr") + cleaned.slice(1) : "";
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanFrontMatterLine(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\(p(?:age)?\.?\s*\d+\)\s*(?=[,.;:]|$)/ig, "")
    .replace(/\s*\[\s*p(?:age)?\.?\s*\d+\s*\]\s*(?=[,.;:]|$)/ig, "")
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
