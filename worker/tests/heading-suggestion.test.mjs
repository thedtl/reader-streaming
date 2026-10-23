import assert from "node:assert/strict";
import test from "node:test";

import { handleSuggestHeading } from "../src/heading-suggestion.js";

const EXPECTED_BIEREMA_HEADING = "Bierema, Laura L., Monica Fedeli, and Sharan B. Merriam. Adult Learning: Linking Theory and Practice. Second edition. Hoboken, New Jersey: John Wiley & Sons, Inc., 2025.";
const BIEREMA_CORE = {
  contributor: "Laura L. Bierema, Monica Fedeli, Sharan B. Merriam",
  title: "Adult Learning: Linking Theory and Practice",
};

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

async function requestSuggestion({ parsedAiResponse, responseEnvelope, fetchError, env = {}, lines = BIEREMA_LINES, images = [], sourceAuthorHint = "", sourceTitleHint = "" } = {}) {
  const originalFetch = globalThis.fetch;
  let geminiRequestBody = null;
  let geminiCallCount = 0;
  let geminiRequestPath = "";
  globalThis.fetch = async (url, init) => {
    geminiCallCount += 1;
    geminiRequestPath = new URL(url).pathname;
    geminiRequestBody = JSON.parse(init?.body || "{}");
    if (fetchError) throw fetchError;
    if (!parsedAiResponse && !responseEnvelope) throw new Error("Unexpected provider request in test");
    return new Response(JSON.stringify(responseEnvelope || {
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [{ text: JSON.stringify(parsedAiResponse) }],
        },
      }],
    }), { status: 200 });
  };

  try {
    const request = new Request("https://example.test/suggest-heading", {
      method: "POST",
      body: JSON.stringify({ password: "test", lines, images, sourceAuthorHint, sourceTitleHint }),
    });
    const response = await handleSuggestHeading(request, env, helpers);
    return { ...(await response.json()), geminiRequestBody, geminiCallCount, geminiRequestPath };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("missing AI key leaves citation unfilled even with clean embedded text", async () => {
  const result = await requestSuggestion();

  assert.equal(result.source, "unavailable");
  assert.equal(result.heading, "");
  assert.equal(result.title, "");
  assert.equal(result.firstContributor, null);
  assert.equal(result.geminiCallCount, 0);
});

test("bad AI heading-only citation is unfilled instead of repaired from embedded text", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      heading: "Learning, Adult. Second Edition.",
      visibleEvidence: {
        heading: "ADULT LEARNING Second Edition",
      },
    },
  });

  assert.equal(result.source, "none");
  assert.equal(result.heading, "");
});

test("edition mistaken for title is unfilled instead of repaired from embedded text", async () => {
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

  assert.equal(result.source, "none");
  assert.equal(result.heading, "");
});

test("a genuine title about an edition remains valid without publication facts", async () => {
  const title = "The First Edition of Paradise Lost";
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "Smith, Jane", title,
      visibleEvidence: { contributor: "Jane Smith", title },
    },
  });
  assert.equal(result.source, "ai");
  assert.equal(result.heading, `Smith, Jane. ${title}.`);
});

test("complete AI heading passes with separately supported contributor and title", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      ...BIEREMA_CORE,
      heading: EXPECTED_BIEREMA_HEADING,
      visibleEvidence: {
        ...BIEREMA_CORE,
        heading: "Laura L. Bierema, Monica Fedeli, Sharan B. Merriam ADULT LEARNING Linking Theory and Practice Second Edition Published by John Wiley & Sons, Inc., Hoboken, New Jersey",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
  assert.equal(result.title, BIEREMA_CORE.title);
});

test("returned title reuses supported field display, including subtitles and non-Latin text", async () => {
  for (const [title, displayedTitle] of [
    ["A Title: Its Subtitle?", "A Title: Its Subtitle?"],
    ["THE TEXT'S WORLD: A STUDY", "The Text's World: A Study"],
    ["성경 강해설교 [Biblical Preaching]: 전달 [Delivery]", "성경 강해설교: 전달 [Biblical Preaching: Delivery]"],
  ]) {
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      parsedAiResponse: {
        contributor: "Smith, Jane", title,
        visibleEvidence: { contributor: "Jane Smith", title },
      },
    });
    assert.equal(result.title, displayedTitle);
    assert.equal(result.heading, `Smith, Jane. ${displayedTitle}.`);
    assert.equal(result.geminiCallCount, 1);
  }
});

test("returned title never comes from the final heading or unsupported/non-string fields", async () => {
  for (const title of [undefined, "", { text: "A Test Work" }, ["A Test Work"], 123]) {
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      parsedAiResponse: {
        contributor: "Smith, Jane", title, heading: "Smith, Jane. A Test Work.",
        visibleEvidence: { contributor: "Jane Smith", title: "A Test Work" },
      },
    });
    assert.equal(result.title, "");
    assert.equal(result.geminiCallCount, 1);
  }
  for (const visibleEvidence of [{ contributor: "Jane Smith" }, { title: "A Test Work" }]) {
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      parsedAiResponse: {
        contributor: "Smith, Jane", title: "A Test Work", heading: "Smith, Jane. A Test Work.", visibleEvidence,
      },
    });
    assert.equal(result.heading, "");
    assert.equal(result.title, "");
  }
});

test("a primary full heading stays authoritative while title is independently returned", async () => {
  const heading = "Smith, Jane. A Different Display Title. Example Press, 2026.";
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "Smith, Jane", title: "The Separately Read Title: With Its Subtitle", heading,
      visibleEvidence: { contributor: "Jane Smith", title: "The Separately Read Title With Its Subtitle" },
    },
  });
  assert.equal(result.heading, heading);
  assert.equal(result.title, "The Separately Read Title: With Its Subtitle");
  assert.equal(result.geminiCallCount, 1);
});

test("first contributor name components reuse the existing scan without rewriting the heading", async () => {
  for (const [contributor, firstContributor] of [
    ["Scott J. Hafemann and Paul R. House, eds.", { givenNames: "Scott J.", familyName: "Hafemann", suffix: "" }],
    ["García Márquez, Gabriel", { givenNames: "Gabriel", familyName: "García Márquez", suffix: "" }],
    ["de la Cruz, Juana Inés", { givenNames: "Juana Inés", familyName: "de la Cruz", suffix: "" }],
    ["Smith, John, Jr.", { givenNames: "John", familyName: "Smith", suffix: "Jr." }],
  ]) {
    const heading = `${contributor.replace(/\.$/, "")}. A Test Work: Its Subtitle.`;
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      parsedAiResponse: {
        contributor, firstContributor, title: "A Test Work: Its Subtitle", heading,
        visibleEvidence: { contributor, title: "A Test Work Its Subtitle" },
      },
    });
    assert.deepEqual(result.firstContributor, firstContributor);
    assert.equal(result.heading, heading);
    assert.equal(result.title, "A Test Work: Its Subtitle");
    assert.equal(result.geminiCallCount, 1);
  }
});

test("missing, uncertain, malformed or unsupported name components stay absent", async () => {
  const valid = { givenNames: "Jane", familyName: "Smith", suffix: "" };
  for (const firstContributor of [
    undefined, null, "Jane Smith", [valid], {}, { ...valid, givenNames: "" },
    { ...valid, familyName: " " }, { ...valid, givenNames: 123 },
    { ...valid, familyName: ["Smith"] }, { givenNames: "Jane", familyName: "Smith" },
    { ...valid, suffix: null }, { ...valid, givenNames: "수인", familyName: "이" },
  ]) {
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      parsedAiResponse: {
        contributor: "Jane Smith", firstContributor, title: "A Test Work",
        visibleEvidence: { contributor: "Jane Smith", title: "A Test Work" },
      },
    });
    assert.equal(result.firstContributor, null);
    assert.equal(result.geminiCallCount, 1);
  }
  const unsupported = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "Jane Smith", firstContributor: valid, title: "A Test Work",
      visibleEvidence: { title: "A Test Work" },
    },
  });
  assert.equal(unsupported.firstContributor, null);
  assert.equal(unsupported.heading, "");
});

test("first-contributor structure is normalized once and historical names remain unsplit", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "Jane M. Smith", title: "A Test Work",
      firstContributor: { givenNames: " Jane  M. ", familyName: " Smith ", suffix: " ", unused: "ignored" },
      visibleEvidence: { contributor: "Jane M. Smith", title: "A Test Work" },
    },
  });
  assert.deepEqual(result.firstContributor, { givenNames: "Jane M.", familyName: "Smith", suffix: "" });
  for (const contributor of ["Clement of Alexandria", "St. Augustine of Hippo", "A Scholarly Society"]) {
    const historical = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      parsedAiResponse: {
        contributor, title: "A Test Work", firstContributor: null,
        visibleEvidence: { contributor, title: "A Test Work" },
      },
    });
    assert.equal(historical.firstContributor, null);
    assert.equal(historical.heading, `${contributor}. A Test Work.`);
  }
  const prompt = result.geminiRequestBody.contents[0].parts[0].text;
  assert.match(prompt, /first leading modern Latin-script personal contributor/);
  assert.match(prompt, /visibleEvidence\.contributor as support/);
  assert.match(prompt, /compound\/double family name and its particles whole/);
  assert.match(prompt, /Return null for historical\/locative names, corporate contributors, non-Latin names/);
  assert.match(prompt, /Never use a later editor\/translator or expand initials/);
  assert.match(prompt, /complete title INCLUDING its subtitle, identical in wording and punctuation/);
  assert.match(prompt, /Exclude separate series, contributor credits, edition and imprint/);
  assert.doesNotMatch(prompt, /Hafemann|House|García Márquez/);
});

test("name structure belongs to the page reader, not a last-word surname fallback", async () => {
  const title = "A Test Work";
  const names = [
    "García Márquez, Gabriel",
    "de la Cruz, Juana Inés",
    "García Márquez, Gabriel, and María López García",
    "Smith, Jane, and John Doe",
    "Clement of Alexandria",
    "St. Augustine of Hippo",
    "Bonaventure",
    "María López García", // Unresolved boundary: preserving it beats guessing García.
  ];
  for (const contributor of names) {
    for (const heading of ["", `${contributor}. ${title}.`]) {
      const result = await requestSuggestion({
        env: { GEMINI_API_KEY: "fake" },
        parsedAiResponse: {
          contributor, title, heading,
          visibleEvidence: { contributor, title },
        },
      });
      assert.equal(result.heading, `${contributor}. ${title}.`);
      assert.equal(result.geminiCallCount, 1);
    }
  }
});

test("scanner prompt preserves observed name boundaries without another request", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "Clement of Alexandria", title: "A Test Work",
      visibleEvidence: { contributor: "CLEMENT OF ALEXANDRIA", title: "A TEST WORK" },
    },
  });
  const prompt = result.geminiRequestBody.contents[0].parts[0].text;
  assert.match(prompt, /complete compound\/double surnames/);
  assert.match(prompt, /final word is not automatically the surname/);
  assert.match(prompt, /single historical name, epithet or locative/);
  assert.match(prompt, /preserve the visible name order and state the uncertainty/);
  assert.doesNotMatch(prompt, /shown as First Name Last Name, invert/);
  assert.equal(result.geminiCallCount, 1);
});

test("scanner uses cataloging selectively for current-volume facts, not contributor identity", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "Smith, Jane", title: "A Test Work", series: "A Commentary Series", seriesNumber: "40B",
      visibleEvidence: { contributor: "Jane Smith", title: "A Test Work", series: "A Commentary Series", seriesNumber: "40B" },
    },
  });
  const prompt = result.geminiRequestBody.contents[0].parts[0].text;
  assert.match(prompt, /title page for title, contributor identity and responsibility/);
  assert.match(prompt, /imprint for this scanned edition's publication facts/);
  assert.match(prompt, /cataloging block for the current volume may corroborate its series name and exact volume designation/);
  assert.match(prompt, /including an observed letter suffix/);
  assert.match(prompt, /Do not use catalogue access headings as authors/);
  assert.match(prompt, /classification\/ISBN numbers as volumes/);
  assert.match(prompt, /must not override a conflicting visible title-page name/);
  assert.doesNotMatch(prompt, /Ignore[^\n]*library-cataloging blocks/);
  assert.match(result.heading, /A Commentary Series, 40B\./);
  assert.equal(result.geminiCallCount, 1);
});

test("successful scan surfaces bounded text warnings through the existing note", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    parsedAiResponse: {
      contributor: "María López García", title: "A Test Work",
      visibleEvidence: { contributor: "María López García", title: "A Test Work" },
      warnings: [
        null, { message: "not a string" }, "  ",
        "Surname boundary is uncertain; visible order retained.",
        "Check the publication date.",
        "x".repeat(500),
        "<b>Check the publisher.</b>",
        "Fifth warning must be omitted.",
      ],
    },
  });
  assert.equal(result.source, "ai");
  assert.equal(result.heading, "María López García. A Test Work.");
  assert.equal(result.note, "Please review the citation: Surname boundary is uncertain; visible order retained. Check the publication date. " + "x".repeat(177) + "... <b>Check the publisher.</b>");
  assert.equal(result.geminiCallCount, 1);
});

test("successful scans without usable warnings retain the normal review note", async () => {
  for (const warnings of [undefined, [], [null, {}, " "], "not an array"]) {
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      parsedAiResponse: {
        ...BIEREMA_CORE, heading: EXPECTED_BIEREMA_HEADING,
        visibleEvidence: BIEREMA_CORE, warnings,
      },
    });
    assert.equal(result.note, "Read from the supplied pages. Please review the citation.");
    assert.equal(result.geminiCallCount, 1);
  }
});

test("garbled hidden text never overwrites the supported image reading", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [
      { text: "CREATES", pageNumber: 3, fontSize: 30 },
      { text: "P. BBovx", pageNumber: 3, fontSize: 16 },
      { text: "Edited by", pageNumber: 3, fontSize: 14 },
      { text: "S. E.", pageNumber: 3, fontSize: 14 },
      { text: "o Wm. B. Eerdmans Publishing Co, Grand RaPids", pageNumber: 4, fontSize: 10 },
      { text: "New Revised Standard Version Copyright 1989", pageNumber: 4, fontSize: 10 },
    ],
    images: [{ pageNumber: 3, mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Brown, William P., and S. Dean McBride Jr., eds.",
      title: "God Who Creates: Essays in Honor of W. Sibley Towner",
      city: "Grand Rapids", publisher: "William B. Eerdmans Publishing Company", year: "2000",
      visibleEvidence: {
        contributor: "Edited by William P. Brown and S. Dean McBride Jr.",
        title: "GOD WHO CREATES Essays in Honor of W. Sibley Towner",
        city: "GRAND RAPIDS", publisher: "WILLIAM B. EERDMANS PUBLISHING COMPANY",
        year: "Copyright © 2000",
      },
    },
  });
  assert.equal(result.source, "ai");
  assert.match(result.heading, /^Brown, William P\., and S\. Dean McBride Jr\., eds\./);
  assert.match(result.heading, /God Who Creates: Essays in Honor of W\. Sibley Towner/);
  assert.match(result.heading, /2000\.$/);
  assert.doesNotMatch(result.heading, /BBovx|1989|Edited by\./);
  assert.equal(result.geminiCallCount, 1);
});

test("empty or unsupported AI core leaves citation unfilled without text fallback", async () => {
  for (const parsedAiResponse of [
    {},
    { heading: "", visibleEvidence: {} },
    { contributor: BIEREMA_CORE.contributor, visibleEvidence: { contributor: BIEREMA_CORE.contributor } },
    { title: BIEREMA_CORE.title, visibleEvidence: { title: BIEREMA_CORE.title } },
    { ...BIEREMA_CORE, heading: EXPECTED_BIEREMA_HEADING, visibleEvidence: { title: BIEREMA_CORE.title } },
    { ...BIEREMA_CORE, heading: EXPECTED_BIEREMA_HEADING, visibleEvidence: { contributor: BIEREMA_CORE.contributor } },
  ]) {
    const result = await requestSuggestion({ env: { GEMINI_API_KEY: "fake" }, parsedAiResponse });
    assert.equal(result.heading, "");
    assert.equal(result.source, "none");
    assert.equal(result.geminiCallCount, 1);
  }
});

test("transport failure is unavailable, never a heuristic citation", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" }, fetchError: new Error("Simulated transport failure"),
  });
  assert.equal(result.heading, "");
  assert.equal(result.source, "unavailable");
  assert.equal(result.geminiCallCount, 1);
});

test("response assembly joins text parts and excludes thinking content", async () => {
  const answer = JSON.stringify({ ...BIEREMA_CORE, heading: EXPECTED_BIEREMA_HEADING, visibleEvidence: BIEREMA_CORE });
  const split = Math.floor(answer.length / 2);
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    responseEnvelope: {
      candidates: [{ finishReason: "STOP", content: { parts: [
        { thought: true, text: "Internal reasoning is not the JSON answer." },
        { text: answer.slice(0, split) }, { text: answer.slice(split) },
      ] } }],
    },
  });
  assert.equal(result.source, "ai");
  assert.equal(result.heading, EXPECTED_BIEREMA_HEADING);
  assert.equal(result.geminiCallCount, 1);
});

test("nonterminal response is rejected even when its partial JSON parses", async () => {
  for (const finishReason of ["MAX_TOKENS", "FINISH_REASON_UNSPECIFIED", undefined]) {
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      responseEnvelope: {
        candidates: [{ finishReason, content: { parts: [{
          text: JSON.stringify({ ...BIEREMA_CORE, heading: EXPECTED_BIEREMA_HEADING, visibleEvidence: BIEREMA_CORE }),
        }] } }],
      },
    });
    assert.equal(result.heading, "");
    assert.equal(result.source, "unavailable");
    assert.equal(result.geminiCallCount, 1);
  }
});

test("AI responsibility text normalizes all-caps names and removes order credentials", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Bonaventure",
      title: "Itinéraire de l'esprit jusqu'en Dieu",
      heading: "Bonaventure, Itinéraire de l'esprit jusqu'en Dieu, Introduction, notes et glossaire par Laure SOLIGNAC, traduction par André MÉNARD ofmcap, Translatio Philosophies Médiévales (Paris: Librairie Philosophique J. Vrin, 2019).",
      visibleEvidence: {
        contributor: "Bonaventure",
        title: "Itinéraire de l'esprit jusqu'en Dieu",
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

test("credential initials are removed without changing supplied contributor order", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Arnold, Tim, Ph.D., and Maya Rao, M.D.",
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

test("malformed AI name text is retained for review rather than guessing a repair", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Haddon W. Robinson",
      title: "Biblical Preaching: The Development and Delivery of Expository Messages",
      heading: "Robinson, and Haddon W. Biblical Preaching: The Development and Delivery of Expository Messages. Fourth Edition. Bible Baptist Theological Seminary Press, 2025.",
      visibleEvidence: {
        contributor: "Haddon W. Robinson",
        title: "Biblical Preaching: The Development and Delivery of Expository Messages",
        heading: "Haddon W. Robinson Biblical Preaching The Development and Delivery of Expository Messages Fourth Edition Bible Baptist Theological Seminary Press 2025",
      },
    },
  });

  assert.equal(result.source, "ai");
  assert.equal(
    result.heading,
    "Robinson, and Haddon W. Biblical Preaching: The Development and Delivery of Expository Messages. Fourth Edition. Bible Baptist Theological Seminary Press, 2025."
  );
  assert.match(result.heading, /Robinson,\s+and\s+Haddon/);
});

test("structured contributors retain conjunctions instead of joining adjacent name tokens", async () => {
  for (const contributor of ["A. and Smith", "J. & Lee", "Smith, A. and Jones"]) {
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" },
      parsedAiResponse: {
        contributor, title: "A Test Work",
        visibleEvidence: { contributor, title: "A Test Work" },
      },
    });
    assert.equal(result.heading, `${contributor}. A Test Work.`);
    assert.equal(result.geminiCallCount, 1);
  }
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
      contributor: "Author, Example",
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
      contributor: "Rice, Howard",
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
      contributor: "Rice, Howard",
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
    env: { GEMINI_API_KEY: "fake" },
    lines: [
      { text: "이수인", pageNumber: 1, fontSize: 16, index: 1 },
      { text: "미디어 리터러시 수업", pageNumber: 1, fontSize: 28, index: 2 },
      { text: "인포데믹 시대의 그리스도인을 위한", pageNumber: 1, fontSize: 18, index: 3 },
      { text: "꾸밈: 홍길동", pageNumber: 4, fontSize: 10, index: 4 },
      { text: "발행처 도서출판 꿈미", pageNumber: 332, fontSize: 10, index: 5 },
      { text: "주소 서울시 강동구 양재대로81길 39, 202호", pageNumber: 332, fontSize: 10, index: 6 },
      { text: "초판 2쇄 발행일 2023년 7월 18일", pageNumber: 332, fontSize: 10, index: 7 },
    ],
    images: [{ pageNumber: 332, mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "이수인", title: "미디어 리터러시 수업: 인포데믹 시대의 그리스도인을 위한",
      city: "서울시", publisher: "도서출판 꿈미", year: "2023",
      visibleEvidence: {
        contributor: "이수인", title: "미디어 리터러시 수업 인포데믹 시대의 그리스도인을 위한",
        city: "주소 서울시 강동구 양재대로81길 39, 202호",
        publisher: "발행처 도서출판 꿈미",
        year: "초판 2쇄 발행일 2023년 7월 18일",
      },
    },
  });

  assert.equal(result.source, "ai");
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
      contributor: "Beitzel, Barry J., General Editor",
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
  assert.equal(result.geminiCallCount, 1);
  assert.equal(result.geminiRequestPath, "/v1beta/models/gemini-2.5-flash:generateContent");
  assert.deepEqual(result.geminiRequestBody.generationConfig, { temperature: 0.1, responseMimeType: "application/json" });
  assert.deepEqual(parts.filter(part => part.inlineData).map(part => part.inlineData), images.slice(0, 18).map(({ mimeType, data }) => ({ mimeType, data })));
  assert(parts.some(part => part.text === "Rendered PDF page 332"));
  assert.match(prompt, /Do not split a single stacked title block into title plus series/);
  assert.match(prompt, /For an editor who belongs in this volume's citation, format role labels such as General Editor as ed\. or eds\./);
  assert.match(prompt, /Do not treat names introduced only by with the collaboration of/);
  assert.match(prompt, /박성덕 \[Park Sung-deok\]/);
  assert.match(prompt, /Do not use a translated title, filename, URL slug, MMS ID, or other source identifier as the bracketed contributor form/);
  assert.match(prompt, /cite that original author first/);
  assert.match(prompt, /general editor of the set is not automatically the editor of this volume/);
  assert.match(prompt, /Preserve the collective work title, this volume's specific title/);
  assert.match(prompt, /Distinguish a scholarly commentary from a translated edition/);
  assert.match(prompt, /do not require or invent an original author/);
  assert.match(prompt, /retain the complete printed credit in visibleEvidence\.contributor/);
  assert.match(prompt, /an absent volume is simply omitted, not announced/);
  assert.match(prompt, /A translation-only edition keeps its explicit translator role/);
  assert.match(prompt, /Preserve combined responsibilities in full/);
});

test("commentary author and series survive both heading and field assembly without a translator suffix", async () => {
  // Reviewer-supplied title-page credit; mocked response, not an AI accuracy test.
  const heading = "Moore, Carey A. Esther. The Anchor Bible.";
  for (const returnedHeading of [heading, ""]) {
    const result = await requestSuggestion({
      env: { GEMINI_API_KEY: "fake" }, lines: [],
      images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
      parsedAiResponse: {
        contributor: "Moore, Carey A.", title: "Esther", series: "The Anchor Bible",
        seriesNumber: "", responsibilityStatement: "", heading: returnedHeading,
        visibleEvidence: {
          contributor: "INTRODUCTION, TRANSLATION, AND NOTES BY CAREY A. MOORE",
          title: "ESTHER", series: "THE ANCHOR BIBLE",
        },
      },
    });
    assert.equal(result.heading, heading);
    assert.equal(result.geminiCallCount, 1);
  }
});

test("existing metadata read requests consistent Chicago display without changing observed facts", async () => {
  // Prompt transport only: a mocked response cannot prove model style adherence.
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" }, lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: { heading: "", visibleEvidence: {} },
  });
  const prompt = result.geminiRequestBody.contents[0].parts[0].text;
  assert.match(prompt, /Chicago notes-and-bibliography entry/);
  assert.match(prompt, /vol\. \(Vol\. at the start of a sentence\), not volume/);
  assert.match(prompt, /complete observed number, including any letter suffix/);
  assert.match(prompt, /observed ordinal for a numbered edition and abbreviate edition as ed\., preserving revision, anniversary/);
  assert.match(prompt, /Do not invent an edition number/);
  assert.match(prompt, /not permission to abbreviate genuine title words/);
  assert.match(prompt, /exact supporting words in visibleEvidence/);
  assert.match(prompt, /For an explicitly observed series volume use Series Title, vol\. N/);
  assert.match(prompt, /for a bare series number use Series Title N, without inventing a volume label/);
  assert.match(prompt, /Do not invent a number, contributor role, or series\/work relationship/);
  assert.match(prompt, /Omit absent details silently/);
  assert.doesNotMatch(prompt, /downloadVolume|multiVolumeWorkTitle|workVolume/);
  assert.equal(result.geminiCallCount, 1);
  assert.equal(result.geminiRequestBody.contents[0].parts.filter(part => part.inlineData).length, 1);
  assert.equal(result.heading, "");
  assert.equal(Object.hasOwn(result, "downloadVolume"), false);
});

test("citation cleanup preserves title dates and bracketed publication dates, not page locators", async () => {
  const heading = "Ward, W. Reginald, and Richard P. Heitzenrater, eds. Collected Letters (1848). Vol. 2. London: Example Press, [1990].";
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "W. Reginald Ward and Richard P. Heitzenrater, eds.",
      title: "Collected Letters (1848)",
      heading: heading.replace("(1848).", "(1848) (Page 4).").replace("[1990].", "[1990] [p. 5]."),
      visibleEvidence: {
        contributor: "W. Reginald Ward and Richard P. Heitzenrater, eds.",
        title: "Collected Letters (1848)", heading,
      },
    },
  });
  assert.equal(result.heading, heading);
});

test("collected-work author, volume title and edition editors survive heading assembly", async () => {
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" },
    lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Wesley, John",
      title: "The Works of John Wesley, Volume 19: Journal and Diaries II (1738–43)",
      responsibilityStatement: "Edited by W. Reginald Ward and Richard P. Heitzenrater",
      city: "Nashville", publisher: "Abingdon Press", year: "1990",
      visibleEvidence: {
        contributor: "THE WORKS OF JOHN WESLEY",
        title: "THE WORKS OF JOHN WESLEY VOLUME 19 JOURNAL AND DIARIES II (1738–43)",
        responsibilityStatement: "EDITED BY W. REGINALD WARD (JOURNAL) AND RICHARD P. HEITZENRATER (DIARIES)",
        city: "NASHVILLE", publisher: "ABINGDON PRESS", year: "1990",
      },
    },
  });
  assert.equal(result.heading, "Wesley, John. The Works of John Wesley, Volume 19: Journal and Diaries II (1738–43). Edited by W. Reginald Ward and Richard P. Heitzenrater. Nashville: Abingdon Press, 1990.");
  assert.equal(result.geminiRequestBody.contents[0].parts.filter(part => part.inlineData).length, 1);
  assert.equal(result.geminiCallCount, 1);
});

test("publisher academic series stays in the citation without download volume metadata", async () => {
  const heading = "Smith, Jane. A Distinct Book Title. Wissenschaftliche Untersuchungen zum Neuen Testament, 421. Tübingen: Example Press, 2020.";
  const result = await requestSuggestion({
    env: { GEMINI_API_KEY: "fake" }, lines: [],
    images: [{ mimeType: "image/jpeg", data: "ZmFrZQ==" }],
    parsedAiResponse: {
      contributor: "Jane Smith", title: "A Distinct Book Title",
      heading, series: "Wissenschaftliche Untersuchungen zum Neuen Testament", seriesNumber: "421",
      visibleEvidence: { contributor: "Jane Smith", title: "A Distinct Book Title", heading, series: "Wissenschaftliche Untersuchungen zum Neuen Testament", seriesNumber: "421" },
    },
  });
  assert.equal(result.heading, heading);
  assert.equal(Object.hasOwn(result, "downloadVolume"), false);
});
