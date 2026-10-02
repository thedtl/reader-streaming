import assert from "node:assert/strict";
import test from "node:test";

import { handleSuggestHeading } from "../src/heading-suggestion.js";

const EXPECTED_BIEREMA_HEADING = "Bierema, Laura L., Monica Fedeli, and Sharan B. Merriam. Adult Learning: Linking Theory and Practice. Second edition. Hoboken, New Jersey: John Wiley & Sons, Inc., 2025.";

const BIEREMA_LINES = [
  { text: "ADULT LEARNING", pageNumber: 1, fontSize: 30 },
  { text: "Linking Theory and Practice", pageNumber: 1, fontSize: 20 },
  { text: "Second Edition", pageNumber: 1, fontSize: 15 },
  { text: "Laura L. Bierema, Monica Fedeli,", pageNumber: 1, fontSize: 14 },
  { text: "Sharan B. Merriam", pageNumber: 1, fontSize: 14 },
  { text: "JOSSEY-BASS", pageNumber: 1, fontSize: 12 },
  { text: "A Wiley Brand", pageNumber: 1, fontSize: 8 },
  { text: "Copyright © 2025 by John Wiley & Sons, Inc. All rights reserved", pageNumber: 2, fontSize: 10 },
  { text: "Published by John Wiley & Sons, Inc., Hoboken, New Jersey", pageNumber: 2, fontSize: 10 },
  { text: "Published simultaneously in Canada.", pageNumber: 2, fontSize: 10 },
  { text: "Names: Bierema, Laura L. (Laura Lee), 1964- author | Fedeli, Monica author | Merriam, Sharan B. author", pageNumber: 2, fontSize: 10 },
  { text: "Title: Adult learning: linking theory and practice / Laura L. Bierema, Monica Fedeli, Sharan B. Merriam.", pageNumber: 2, fontSize: 10 },
  { text: "Description: Second edition. | Hoboken, New Jersey : Jossey-Bass, [2025]", pageNumber: 2, fontSize: 10 },
];

const helpers = {
  requireStaffPasswordValue() {},
  json(data, request, env, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  },
};

async function requestSuggestion({ parsedAiResponse, env = {}, lines = BIEREMA_LINES, images = [], sourceAuthorHint = "", sourceTitleHint = "" } = {}) {
  const originalFetch = globalThis.fetch;
  let geminiRequestBody = null;
  if (parsedAiResponse) {
    globalThis.fetch = async (url, init) => {
      geminiRequestBody = JSON.parse(init?.body || "{}");
      return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: JSON.stringify(parsedAiResponse) }],
        },
      }],
      }), { status: 200 });
    };
  }

  try {
    const request = new Request("https://example.test/suggest-heading", {
      method: "POST",
      body: JSON.stringify({ password: "test", lines, images, sourceAuthorHint, sourceTitleHint }),
    });
    const response = await handleSuggestHeading(request, env, helpers);
    return { ...(await response.json()), geminiRequestBody };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("heuristic fallback extracts full Bierema citation", async () => {
  const result = await requestSuggestion();

  assert.equal(result.source, "heuristic");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
});

test("bad AI heading-only citation is rejected in favor of extracted fields", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      heading: "Learning, Adult. Second Edition.",
      visibleEvidence: {
        heading: "ADULT LEARNING Second Edition",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.notEqual(result.heading, "Learning, Adult. Second Edition.");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
});

test("bad AI structured citation is rejected in favor of extracted fields", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "Adult Learning",
      title: "Second Edition",
      visibleEvidence: {
        contributor: "ADULT LEARNING",
        title: "Second Edition",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
});

test("complete AI heading-only citation can pass when it includes extracted core facts", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      heading: EXPECTED_BIEREMA_HEADING,
      visibleEvidence: {
        heading: "Laura L. Bierema, Monica Fedeli, Sharan B. Merriam ADULT LEARNING Linking Theory and Practice Second Edition Published by John Wiley & Sons, Inc., Hoboken, New Jersey",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
});

test("AI responsibility text normalizes all-caps names and removes order credentials", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      heading: "Bonaventure, Itinéraire de l'esprit jusqu'en Dieu, Introduction, notes et glossaire par Laure SOLIGNAC, traduction par André MÉNARD ofmcap, Translatio Philosophies Médiévales (Paris: Librairie Philosophique J. Vrin, 2019).",
      visibleEvidence: {
        heading: "Bonaventure Itinéraire de l'esprit jusqu'en Dieu Introduction, notes et glossaire par Laure SOLIGNAC traduction par André MÉNARD ofmcap Translatio Philosophies Médiévales Paris Librairie Philosophique J. Vrin 2019",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.match(result.heading, /Laure Solignac/);
  assert.match(result.heading, /André Ménard/);
  assert.doesNotMatch(result.heading, /SOLIGNAC|MÉNARD/);
  assert.doesNotMatch(result.heading, /ofmcap/i);
});

test("AI structured responsibility field is normalized before citation assembly", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Bonaventure",
      title: "Itinéraire de l'esprit jusqu'en Dieu",
      responsibilityStatement: "Introduction, notes et glossaire par Laure SOLIGNAC, traduction par André MÉNARD ofmcap",
      series: "Translatio Philosophies Médiévales",
      city: "Paris",
      publisher: "Librairie Philosophique J. Vrin",
      year: "2019",
      visibleEvidence: {
        contributor: "Bonaventure",
        title: "Itinéraire de l'esprit jusqu'en Dieu",
        responsibilityStatement: "Introduction, notes et glossaire par Laure SOLIGNAC, traduction par André MÉNARD ofmcap",
        series: "Translatio Philosophies Médiévales",
        city: "Paris",
        publisher: "Librairie Philosophique J. Vrin",
        year: "2019",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Bonaventure. Itinéraire de l'esprit jusqu'en Dieu. Introduction, notes et glossaire par Laure Solignac, traduction par André Ménard. Translatio Philosophies Médiévales. Paris: Librairie Philosophique J. Vrin, 2019."
  );
});

test("credential initials are removed before author splitting", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Tim Arnold, Ph.D., Maya Rao, M.D.",
      title: "Credential Test",
      publisher: "Example Press",
      year: "2026",
      visibleEvidence: {
        contributor: "Tim Arnold, Ph.D., Maya Rao, M.D.",
        title: "Credential Test",
        publisher: "Example Press",
        year: "2026",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(result.heading, "Arnold, Tim, and Maya Rao. Credential Test. Example Press, 2026.");
  assert.doesNotMatch(result.heading, /Ph\.?D|M\.?D/i);
});

test("AI heading-only citation repairs malformed inverted initial author", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      heading: "Robinson, and Haddon W. Biblical Preaching: The Development and Delivery of Expository Messages. Fourth Edition. Bible Baptist Theological Seminary Press, 2025.",
      visibleEvidence: {
        heading: "Haddon W. Robinson Biblical Preaching The Development and Delivery of Expository Messages Fourth Edition Bible Baptist Theological Seminary Press 2025",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Robinson, Haddon W. Biblical Preaching: The Development and Delivery of Expository Messages. Fourth Edition. Bible Baptist Theological Seminary Press, 2025."
  );
  assert.doesNotMatch(result.heading, /Robinson,\s+and\s+Haddon/);
});

test("non-Latin title and subtitle use one combined bracketed English equivalent", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "해돈 W. 로빈슨 [Haddon W. Robinson]",
      title: "성경 강해설교 [Biblical Preaching]: 강해설교 전개와 전달 [The Development and Delivery of Expository Messages]",
      visibleEvidence: {
        contributor: "해돈 W. 로빈슨 Haddon W. Robinson",
        title: "성경 강해설교 Biblical Preaching 강해설교 전개와 전달 The Development and Delivery of Expository Messages",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "해돈 W. 로빈슨 [Haddon W. Robinson]. 성경 강해설교: 강해설교 전개와 전달 [Biblical Preaching: The Development and Delivery of Expository Messages]."
  );
  assert.doesNotMatch(result.heading, /\[Biblical Preaching\]:/);
});

test("split bracket repair applies to non-Latin scripts beyond Korean", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Example Author",
      title: "عنوان رئيسي [Main Title]: عنوان فرعي [Subtitle]",
      visibleEvidence: {
        contributor: "Example Author",
        title: "عنوان رئيسي Main Title عنوان فرعي Subtitle",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Author, Example. عنوان رئيسي: عنوان فرعي [Main Title: Subtitle]."
  );
  assert.doesNotMatch(result.heading, /\[Main Title\]:/);
});

test("non-Latin title uses translated title in brackets instead of romanization", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Howard Rice",
      title: "영성 목회와 영적 지도 [Yeongseong Mokhoe wa Yeongjeok Jido]: The Pastor as Spiritual Guide",
      visibleEvidence: {
        contributor: "Howard Rice",
        title: "영성 목회와 영적 지도 Yeongseong Mokhoe wa Yeongjeok Jido The Pastor as Spiritual Guide",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Rice, Howard. 영성 목회와 영적 지도 [The Pastor as Spiritual Guide]."
  );
  assert.doesNotMatch(result.heading, /Yeongseong|Mokhoe|Yeongjeok|Jido/);
});

test("non-title citation fields keep original script without bracketed romanization", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Howard Rice",
      title: "영성 목회와 영적 지도 [The Pastor as Spiritual Guide]",
      responsibilityStatement: "Translated by Choi, Dae-Hyung",
      series: "영성 목회 시리즈 [Spiritual Pastoral Care Series]",
      seriesNumber: "2",
      city: "서울 [Seoul]",
      publisher: "발행처 도서출판 은성 (Page 4)",
      year: "2000",
      visibleEvidence: {
        contributor: "Howard Rice",
        title: "영성 목회와 영적 지도 The Pastor as Spiritual Guide",
        responsibilityStatement: "최대형 옮김 translated by Choi, Dae-Hyung",
        series: "영성 목회 시리즈 2",
        seriesNumber: "2",
        city: "서울",
        publisher: "도서출판 은성",
        year: "초판발행 2000년 7월 20일 2쇄 발행 2011년 3월 20일",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Rice, Howard. 영성 목회와 영적 지도 [The Pastor as Spiritual Guide]. Translated by 최대형. 영성 목회 시리즈, 2. 서울: 도서출판 은성, 2011."
  );
  assert.doesNotMatch(result.heading, /Choi|Dae-Hyung|Doseochulpan|Spiritual Pastoral Care Series|Page 4|발행처|2000/);
});

test("non-Latin comma author is kept as one author without added and", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "이, 수인",
      title: "미디어 리터러시 수업 [Media Literacy Class]: 인포데믹 시대의 그리스도인을 위한 [For Christians in the Infodemic Era]",
      publisher: "꾸밈",
      visibleEvidence: {
        contributor: "이수인",
        title: "미디어 리터러시 수업 Media Literacy Class 인포데믹 시대의 그리스도인을 위한 For Christians in the Infodemic Era",
        publisher: "꾸밈",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "이수인. 미디어 리터러시 수업: 인포데믹 시대의 그리스도인을 위한 [Media Literacy Class: For Christians in the Infodemic Era]."
  );
  assert.doesNotMatch(result.heading, /,\s+and\s+수인|꾸밈/);
});

test("Korean publication labels are accepted while production credits are ignored", async () => {
  const result = await requestSuggestion({
    lines: [
      { text: "이수인", pageNumber: 1, fontSize: 16, index: 1 },
      { text: "미디어 리터러시 수업", pageNumber: 1, fontSize: 28, index: 2 },
      { text: "인포데믹 시대의 그리스도인을 위한", pageNumber: 1, fontSize: 18, index: 3 },
      { text: "꾸밈: 홍길동", pageNumber: 4, fontSize: 10, index: 4 },
      { text: "발행처 도서출판 꿈미", pageNumber: 332, fontSize: 10, index: 5 },
      { text: "주소 서울시 강동구 양재대로81길 39, 202호", pageNumber: 332, fontSize: 10, index: 6 },
      { text: "초판 2쇄 발행일 2023년 7월 18일", pageNumber: 332, fontSize: 10, index: 7 },
    ],
  });

  assert.equal(result.source, "heuristic");
  assert.match(result.heading, /서울시: 도서출판 꿈미, 2023\./);
  assert.doesNotMatch(result.heading, /꾸밈/);
});

test("clean AI heading wins over noisy support fields", async () => {
  const cleanHeading = "이수인 [Lee Su-in]. 미디어 리터러시 수업: 인포데믹 시대의 그리스도인을 위한 [Media Literacy Class: For Christians in the Infodemic Era]. 서울시: 도서출판 꿈미, 2023.";
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ pageNumber: 332, mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    sourceAuthorHint: "Lee Su-in",
    sourceTitleHint: "Media Literacy Class: For Christians in the Infodemic Era",
    parsedAiResponse: {
      contributor: "이수민 지음, 이수민, 지은이 이수민",
      title: "인포데믹 시대의 그리스도인을 위한 미디어 리터러시 수업",
      edition: "초판 2쇄",
      city: "서울시",
      publisher: "꾸밈, 발행처 도서출판 꾸밈",
      year: "2023",
      heading: cleanHeading,
      visibleEvidence: {
        contributor: "이수인",
        title: "인포데믹 시대의 그리스도인을 위한 미디어 리터러시 수업",
        edition: "초판 2쇄 발행일 2023년 7월 18일",
        city: "주소 서울시 강동구 양재대로81길 39, 202호",
        publisher: "발행처 도서출판 꿈미",
        year: "초판 2쇄 발행일 2023년 7월 18일",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(result.heading, cleanHeading);
  assert.doesNotMatch(result.heading, /이수민|초판 2쇄|꾸밈|발행처/);
});

test("AI heading publication tail is reconciled with visible publisher evidence", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ pageNumber: 332, mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    sourceAuthorHint: "Lee Su-in",
    sourceTitleHint: "Media Literacy Class: For Christians in the Infodemic Era",
    parsedAiResponse: {
      contributor: "이수인",
      title: "미디어 리터러시 수업: 인포데믹 시대의 그리스도인을 위한 [Media Literacy Class: For Christians in the Infodemic Era]",
      city: "서울시",
      publisher: "꾸밈",
      year: "2023",
      heading: "이수인 [Lee Su-in]. 미디어 리터러시 수업: 인포데믹 시대의 그리스도인을 위한 [Media Literacy Class: For Christians in the Infodemic Era]. 서울시: 꾸밈, 2023.",
      visibleEvidence: {
        contributor: "이수인 지음",
        title: "미디어 리터러시 수업 인포데믹 시대의 그리스도인을 위한",
        city: "주소 서울시 강동구 양재대로81길 39, 202호",
        publisher: "발행처 도서출판 꿈미",
        year: "초판 2쇄 발행일 2023년 7월 18일",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "이수인 [Lee Su-in]. 미디어 리터러시 수업: 인포데믹 시대의 그리스도인을 위한 [Media Literacy Class: For Christians in the Infodemic Era]. 서울시: 도서출판 꿈미, 2023."
  );
  assert.doesNotMatch(result.heading, /서울시: 꾸밈/);
});

test("AI editor role labels are normalized in final headings", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ pageNumber: 1, mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Barry J. Beitzel, General Editor",
      title: "Volume 2: 1 Samuel-Esther",
      series: "Lexham Geographic Commentary on the Historical Books",
      city: "Bellingham",
      publisher: "Lexham Press",
      year: "2016",
      heading: "Beitzel, Barry J., General Editor. Volume 2: 1 Samuel-Esther. Lexham Geographic Commentary on the Historical Books, 2. Bellingham: Lexham Press, 2016.",
      visibleEvidence: {
        contributor: "Barry J. Beitzel, General Editor",
        title: "Volume 2: 1 Samuel-Esther",
        series: "Lexham Geographic Commentary on the Historical Books",
        city: "Bellingham",
        publisher: "Lexham Press",
        year: "2016",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.match(result.heading, /^Beitzel, Barry J\., ed\./);
  assert.doesNotMatch(result.heading, /General Editor|and ed\./);
});

test("structured editor contributors keep ed. with the author name", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ pageNumber: 1, mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Barry J. Beitzel, General Editor",
      title: "Lexham Geographic Commentary on the Historical Books: Volume 2, 1 Samuel-Esther",
      city: "Bellingham",
      publisher: "Lexham Press",
      year: "2016",
      visibleEvidence: {
        contributor: "Barry J. Beitzel, General Editor",
        title: "Lexham Geographic Commentary on the Historical Books Volume 2: 1 Samuel-Esther",
        city: "Bellingham",
        publisher: "Lexham Press",
        year: "2016",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Beitzel, Barry J., ed. Lexham Geographic Commentary on the Historical Books: Volume 2, 1 Samuel-Esther. Bellingham: Lexham Press, 2016."
  );
  assert.doesNotMatch(result.heading, /Barry J\. Beitzel, ed\.|and ed\.|General Editor/);
});

test("prompt tells AI to omit collaborator and ToC article names for whole edited books", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [
      { text: "HUGUES COUSIN, JEAN-PIERRE LÉMONON, JEAN MASSONNET", pageNumber: 1, fontSize: 16 },
      { text: "avec la collaboration de", pageNumber: 1, fontSize: 12 },
      { text: "PHILIPPE ABADIE, JEAN COMBY, ANITA MÉASSON, FRANÇOIS RICHARD", pageNumber: 1, fontSize: 13 },
      { text: "LE MONDE OÙ VIVAIT JÉSUS", pageNumber: 1, fontSize: 30 },
      { text: "Ouvrage édité par HUGUES COUSIN", pageNumber: 1, fontSize: 14 },
      { text: "Les Sadducéens Jean-Pierre Lémonon", pageNumber: 8, fontSize: 11 },
      { text: "Les Samaritains Jean Massonnet", pageNumber: 8, fontSize: 11 },
    ],
    images: [{ pageNumber: 1, mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Hugues Cousin, ed.",
      title: "Le monde où vivait Jésus",
      city: "Paris",
      publisher: "Les Éditions du Cerf",
      year: "1998",
      heading: "Cousin, Hugues, ed. Le monde où vivait Jésus. Paris: Les Éditions du Cerf, 1998.",
      visibleEvidence: {
        contributor: "Ouvrage édité par HUGUES COUSIN",
        title: "LE MONDE OÙ VIVAIT JÉSUS",
        city: "PARIS",
        publisher: "LES ÉDITIONS DU CERF",
        year: "1998",
      },
    },
  });

  const prompt = result.geminiRequestBody.contents[0].parts[0].text;
  assert.equal(
    result.heading,
    "Cousin, Hugues, ed. Le monde où vivait Jésus. Paris: Les Éditions du Cerf, 1998."
  );
  assert.doesNotMatch(result.heading, /Lémonon|Massonnet|Abadie|Comby|Méasson|Richard|collaboration/i);
  assert.match(prompt, /cite the whole book under that editor with ed\. or eds\./);
  assert.match(prompt, /avec la collaboration de/);
  assert.match(prompt, /chapter authors, article authors, or table-of-contents entries/);
});

test("supported AI heading wins over noisy OCR title extraction", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [
      { text: "Fam Ily TH Erapies", pageNumber: 1, fontSize: 30 },
      { text: "A Comprehensive Christian Appraisal", pageNumber: 1, fontSize: 18 },
      { text: "Second edition", pageNumber: 1, fontSize: 12 },
      { text: "Yarhouse, Mark A.", pageNumber: 1, fontSize: 14 },
      { text: "ABPR professor ofpsychology, George Fox Universiry", pageNumber: 1, fontSize: 10 },
      { text: "an integrative model of family therapy. This is a significant book that", pageNumber: 2, fontSize: 10 },
      { text: "2008", pageNumber: 2, fontSize: 10 },
    ],
    images: [{ pageNumber: 1, mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Yarhouse, Mark A., and James N. Sells",
      title: "Family Therapies: A Comprehensive Christian Appraisal",
      edition: "Second Edition",
      city: "Downers Grove",
      publisher: "InterVarsity Press",
      year: "2017",
      heading: "Yarhouse, Mark A., and James N. Sells. Family Therapies: A Comprehensive Christian Appraisal. Second Edition. Downers Grove: InterVarsity Press, 2017.",
      visibleEvidence: {
        contributor: "Mark A. Yarhouse and James N. Sells",
        title: "FAMILY THERAPIES A Comprehensive Christian Appraisal",
        edition: "SECOND EDITION",
        city: "Downers Grove, Illinois",
        publisher: "IVP Academic An imprint of InterVarsity Press",
        year: "©2017",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Yarhouse, Mark A., and James N. Sells. Family Therapies: A Comprehensive Christian Appraisal. Second Edition. Downers Grove: InterVarsity Press, 2017."
  );
  assert.doesNotMatch(result.heading, /Fam Ily|TH Erapies|ABPR|ofpsychology|Universiry|2008/);
});

test("Worker forwards rendered front and imprint images to Gemini", async () => {
  const images = Array.from({ length: 20 }, (_, index) => ({
    pageNumber: index < 12 ? index + 1 : 320 + index,
    mimeType: "image/jpeg",
    data: "ZmFrZQ==",
  }));

  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images,
    parsedAiResponse: {
      heading: "",
      visibleEvidence: {},
    },
  });

  const parts = result.geminiRequestBody.contents[0].parts;
  const prompt = parts[0].text;
  assert.equal(parts.filter(part => part.inlineData).length, 18);
  assert(parts.some(part => part.text === "Rendered PDF page 332"));
  assert.match(prompt, /Do not split a single stacked title block into title plus series/);
  assert.match(prompt, /For editor labels such as General Editor, cite the role as ed\. or eds\./);
  assert.match(prompt, /Do not treat names introduced only by with the collaboration of/);
  assert.match(prompt, /박성덕 \[Park Sung-deok\]/);
  assert.match(prompt, /Do not use a translated title, filename, URL slug, MMS ID, or other source identifier as the bracketed contributor form/);
});
