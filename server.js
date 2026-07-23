const express = require("express");
const path = require("path");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
let pipelineFactory = null;
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// Serve frontend files from frontend folder
app.use(express.static(path.join(__dirname, "frontend")));

// Homepage should open login.html first
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "login.html"));
});

// Direct routes for pages
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "login.html"));
});

app.get("/index", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "home.html"));
});

app.get("/reference", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "reference.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "admin.html"));
});

// Supabase backend client
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);


// Use either key name
// Your old code uses SCOPUS_API_KEY.
// New citation checking can also use ELSEVIER_API_KEY.
function getScopusApiKey() {
  return process.env.SCOPUS_API_KEY || process.env.ELSEVIER_API_KEY;
}

const SCOPUS_API_URL = "https://api.elsevier.com/content/search/scopus";
const SCOPUS_ABSTRACT_API_URL = "https://api.elsevier.com/content/abstract";

// 200 is enough for your current lecturers because the highest is around 179.
const MAX_PUBLICATIONS_PER_RESEARCHER = 200;
const SCOPUS_BATCH_SIZE = 25;

// Helper: normalize object/array/null into array
function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// Check keys
app.get("/api/test-key", (req, res) => {
  res.json({
    scopusKeyLoaded: !!process.env.SCOPUS_API_KEY,
    elsevierKeyLoaded: !!process.env.ELSEVIER_API_KEY,
    usableScopusKeyLoaded: !!getScopusApiKey(),
    supabaseUrlLoaded: !!process.env.SUPABASE_URL,
    supabaseServiceKeyLoaded: !!process.env.SUPABASE_SERVICE_KEY,
  });
});

// Format Scopus paper data
function formatPapers(entries, startIndex = 0) {
  return entries.map((item, index) => {
    const scopusLink =
      item.link?.find((l) => l["@ref"] === "scopus")?.["@href"] || "#";

    const scopusDocumentId =
      item["dc:identifier"]?.replace("SCOPUS_ID:", "") ||
      item["eid"] ||
      scopusLink.match(/scp=([^&]+)/)?.[1] ||
      "Not available";

    return {
      no: startIndex + index + 1,
      title: item["dc:title"] || "No title",
      doi: item["prism:doi"] || "No DOI",
      scopus_document_id: scopusDocumentId,
      eid: item["eid"] || null,
      journal: item["prism:publicationName"] || "No journal",
      publication_date: item["prism:coverDate"] || "No date",
      cited_by_count: item["citedby-count"] || null,
      scopus_link: scopusLink,
    };
  });
}

// Fetch all Scopus publications using pagination
async function fetchAllScopusPublications(scopusQuery) {
  const apiKey = getScopusApiKey();

  if (!apiKey) {
    throw new Error("Missing SCOPUS_API_KEY or ELSEVIER_API_KEY in .env");
  }

  let allEntries = [];
  let start = 0;
  let totalResults = null;

  while (allEntries.length < MAX_PUBLICATIONS_PER_RESEARCHER) {
    const response = await axios.get(SCOPUS_API_URL, {
      headers: {
        "X-ELS-APIKey": apiKey,
        Accept: "application/json",
      },
      params: {
        query: scopusQuery,
        view: "STANDARD",
        count: SCOPUS_BATCH_SIZE,
        start: start,
        sort: "-coverDate",
      },
    });

    const searchResults = response.data["search-results"] || {};
    const entries = searchResults.entry || [];

    if (totalResults === null) {
      totalResults = Number(searchResults["opensearch:totalResults"] || 0);
    }

    if (entries.length === 0) {
      break;
    }

    allEntries = allEntries.concat(entries);
    start += entries.length;

    if (start >= totalResults) {
      break;
    }
  }

  return {
    totalResults: totalResults || 0,
    entries: allEntries.slice(0, MAX_PUBLICATIONS_PER_RESEARCHER),
  };
}

// NEW ROUTE: Test one Scopus paper metadata for citation feature
// Default test:
// http://localhost:5000/api/test-scopus-paper?eid=2-s2.0-105041663443
//
// META_ABS test:
// http://localhost:5000/api/test-scopus-paper?eid=2-s2.0-105041663443&view=META_ABS
app.get("/api/test-scopus-paper", async (req, res) => {
  try {
    const { eid, doi, view } = req.query;

    if (!eid && !doi) {
      return res.status(400).json({
        success: false,
        error: "Please provide either ?eid=... or ?doi=...",
      });
    }

    const apiKey = getScopusApiKey();

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error:
          "Missing SCOPUS_API_KEY or ELSEVIER_API_KEY in environment variables",
      });
    }

    let url;

    if (eid) {
      url = `${SCOPUS_ABSTRACT_API_URL}/eid/${encodeURIComponent(eid)}`;
    } else {
      url = `${SCOPUS_ABSTRACT_API_URL}/doi/${encodeURIComponent(doi)}`;
    }

    const params = {};

    // Example:
    // /api/test-scopus-paper?eid=2-s2.0-105041663443&view=META_ABS
    if (view) {
      params.view = view;
    }

    const response = await axios.get(url, {
      headers: {
        "X-ELS-APIKey": apiKey,
        Accept: "application/json",
      },
      params,
      validateStatus: () => true,
    });

    const data = response.data;

    if (response.status < 200 || response.status >= 300) {
      return res.status(response.status).json({
        success: false,
        status: response.status,
        message: "Elsevier API returned an error",
        requestedView: view || "default",
        error: data,
      });
    }

    const abstractData = data["abstracts-retrieval-response"];
    const coredata = abstractData?.coredata || {};

    // Scopus link can appear as @rel or @ref depending on endpoint/view
    const links = normalizeArray(coredata.link);

    const scopusLink =
      links.find((l) => l["@rel"] === "scopus" || l["@ref"] === "scopus")?.[
        "@href"
      ] || null;

    // Authors may appear in different places depending on view
    const authorsFromTop = abstractData?.authors?.author;
    const authorsFromCreator = coredata?.["dc:creator"]?.author;

    const authorsRaw = [
      ...normalizeArray(authorsFromTop),
      ...normalizeArray(authorsFromCreator),
    ];

    const authors = authorsRaw.map((a) => ({
      name:
        a["ce:indexed-name"] ||
        a["preferred-name"]?.["ce:indexed-name"] ||
        null,
      givenName:
        a["ce:given-name"] ||
        a["preferred-name"]?.["ce:given-name"] ||
        null,
      surname:
        a["ce:surname"] ||
        a["preferred-name"]?.["ce:surname"] ||
        null,
      auid: a["@auid"] || null,
      authorUrl: a["author-url"] || null,
    }));

    // Author keywords can appear in different structures
    const authKeywordsRaw =
      abstractData?.authkeywords?.["author-keyword"] ||
      abstractData?.item?.bibrecord?.head?.["citation-info"]?.[
        "author-keywords"
      ]?.["author-keyword"];

    const keywords = normalizeArray(authKeywordsRaw)
      .map((k) => {
        if (typeof k === "string") return k;
        if (k?.["$"]) return k["$"];
        if (k?._) return k._;
        return null;
      })
      .filter(Boolean);

    // Index terms can appear in different structures
    const indexTermsRaw =
      abstractData?.idxterms?.mainterm ||
      abstractData?.item?.bibrecord?.head?.enhancement?.descriptorgroup
        ?.descriptors?.descriptor;

    const indexTerms = normalizeArray(indexTermsRaw)
      .map((t) => {
        if (typeof t === "string") return t;
        if (t?.mainterm?.["$"]) return t.mainterm["$"];
        if (t?.mainterm?._) return t.mainterm._;
        if (t?.["$"]) return t["$"];
        if (t?._) return t._;
        return null;
      })
      .filter(Boolean);

    const cleaned = {
      status: response.status,
      requestedView: view || "default",

      title: coredata["dc:title"] || null,
      abstract: coredata["dc:description"] || null,
      doi: coredata["prism:doi"] || null,
      sourceTitle: coredata["prism:publicationName"] || null,
      coverDate: coredata["prism:coverDate"] || null,
      publicationYear: coredata["prism:coverDate"]
        ? String(coredata["prism:coverDate"]).slice(0, 4)
        : null,
      citedByCount: coredata["citedby-count"] || null,
      volume: coredata["prism:volume"] || null,
      issue: coredata["prism:issueIdentifier"] || null,
      pageRange: coredata["prism:pageRange"] || null,
      startingPage: coredata["prism:startingPage"] || null,
      endingPage: coredata["prism:endingPage"] || null,
      issn: coredata["prism:issn"] || null,
      publisher: coredata["dc:publisher"] || null,
      openAccess: coredata["openaccessFlag"] || coredata["openaccess"] || null,

      eid: coredata["eid"] || eid || null,
      scopusDocumentId:
        coredata["dc:identifier"]?.replace("SCOPUS_ID:", "") || null,
      scopusLink,

      authors,
      authorNames: authors.map((a) => a.name).filter(Boolean),
      keywords,
      indexTerms,
    };

    res.json({
      success: true,
      message: "Scopus paper metadata test completed",
      extracted: cleaned,
      full_response: data,
    });
  } catch (error) {
    console.error(
      "Test Scopus paper error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error: "Failed to test Scopus paper metadata",
      details: error.response?.data || error.message,
    });
  }
});

function buildPaperEmbeddingText(paper) {
  return `
Title: ${paper.title || ""}
Abstract: ${paper.abstract || ""}
Keywords: ${paper.keywords || ""}
Index Terms: ${paper.index_terms || ""}
Journal: ${paper.journal || ""}
  `.trim();
}

function buildTitleEmbeddingText(paper) {
  return `
Title: ${paper.title || ""}
Journal: ${paper.journal || ""}
DOI: ${paper.doi || ""}
Year: ${paper.publication_date ? String(paper.publication_date).slice(0, 4) : ""}
  `.trim();
}

let embeddingPipeline = null;

async function getEmbeddingPipeline() {
  if (!pipelineFactory) {
    const transformers = await import("@xenova/transformers");
    pipelineFactory = transformers.pipeline;
  }

  if (!embeddingPipeline) {
    embeddingPipeline = await pipelineFactory(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
  }

  return embeddingPipeline;
}

async function createEmbedding(text) {
  const extractor = await getEmbeddingPipeline();

  const output = await extractor(text, {
    pooling: "mean",
    normalize: true,
  });

  return Array.from(output.data);
}

function cosineSimilarity(vectorA, vectorB) {
  if (!Array.isArray(vectorA) || !Array.isArray(vectorB)) return 0;
  if (vectorA.length !== vectorB.length) return 0;

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vectorA.length; i++) {
    dotProduct += vectorA[i] * vectorB[i];
    magnitudeA += vectorA[i] * vectorA[i];
    magnitudeB += vectorB[i] * vectorB[i];
  }

  if (magnitudeA === 0 || magnitudeB === 0) return 0;

  return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

app.post("/api/generate-paper-embeddings", async (req, res) => {
  try {
    const { data: papers, error } = await supabaseAdmin
      .from("publications")
      .select(`
        id,
        title,
        abstract,
        keywords,
        index_terms,
        journal,
        is_selected,
        embedding_json
      `)
      .eq("is_selected", true)
      .not("abstract", "is", null);

    if (error) {
      return res.status(500).json({
        success: false,
        error: "Failed to load selected papers",
        details: error,
      });
    }

    const enrichedPapers = (papers || []).filter((paper) => {
      return paper.abstract && String(paper.abstract).trim() !== "";
    });

    const results = [];

    for (const paper of enrichedPapers) {
      try {
        const textForEmbedding = buildPaperEmbeddingText(paper);
        const embedding = await createEmbedding(textForEmbedding);

        const { error: updateError } = await supabaseAdmin
          .from("publications")
          .update({
            embedding_json: embedding,
          })
          .eq("id", paper.id);

        if (updateError) {
          results.push({
            id: paper.id,
            title: paper.title,
            status: "failed",
            error: updateError.message,
          });
          continue;
        }

        results.push({
          id: paper.id,
          title: paper.title,
          status: "success",
        });
      } catch (singleError) {
        results.push({
          id: paper.id,
          title: paper.title,
          status: "failed",
          error: singleError.message,
        });
      }
    }

    res.json({
      success: true,
      message: "Paper embeddings generated",
      total: enrichedPapers.length,
      results,
    });
  } catch (error) {
    console.error("Generate embeddings error:", error.message);

    res.status(500).json({
      success: false,
      error: "Failed to generate paper embeddings",
      details: error.message,
    });
  }
});

app.post("/api/generate-title-embeddings", async (req, res) => {
  try {
    const { data: papers, error } = await supabaseAdmin
      .from("publications")
      .select(`
        id,
        title,
        doi,
        journal,
        publication_date,
        is_selected,
        title_embedding_json
      `)
      .not("title", "is", null);

    if (error) {
      return res.status(500).json({
        success: false,
        error: "Failed to load publications",
        details: error,
      });
    }

    // IMPORTANT:
    // Generate title embeddings for selected papers too.
    // Before, selected papers were excluded, so the reference tool could not match them.
    const papersToEmbed = (papers || []).filter((paper) => {
      return (
        paper.title &&
        String(paper.title).trim() !== "" &&
        !paper.title_embedding_json
      );
    });

    const results = [];

    for (const paper of papersToEmbed) {
      try {
        const textForEmbedding = buildTitleEmbeddingText(paper);
        const embedding = await createEmbedding(textForEmbedding);

        const { error: updateError } = await supabaseAdmin
          .from("publications")
          .update({
            title_embedding_json: embedding,
          })
          .eq("id", paper.id);

        if (updateError) {
          results.push({
            id: paper.id,
            title: paper.title,
            is_selected: paper.is_selected,
            status: "failed",
            error: updateError.message,
          });
          continue;
        }

        results.push({
          id: paper.id,
          title: paper.title,
          is_selected: paper.is_selected,
          status: "success",
        });
      } catch (singleError) {
        results.push({
          id: paper.id,
          title: paper.title,
          is_selected: paper.is_selected,
          status: "failed",
          error: singleError.message,
        });
      }
    }

    res.json({
      success: true,
      message: "Title embeddings generated for publications including selected papers",
      total: papersToEmbed.length,
      results,
    });
  } catch (error) {
    console.error("Generate title embeddings error:", error.message);

    res.status(500).json({
      success: false,
      error: "Failed to generate title embeddings",
      details: error.message,
    });
  }
});

function formatReferenceAuthors(authors, fallbackName) {
  const rawAuthors = authors && String(authors).trim() !== ""
    ? String(authors).trim()
    : "";

  if (rawAuthors) {
    return rawAuthors;
  }

  return fallbackName || "Unknown Author";
}

function buildIeeeReference(paper) {
  const year = paper.publication_date
    ? String(paper.publication_date).slice(0, 4)
    : "n.d.";

  const authorText = formatReferenceAuthors(
    paper.authors,
    paper.researchers?.name
  );

  const doiText =
    paper.doi && paper.doi !== "No DOI"
      ? `, doi: ${paper.doi}`
      : "";

  const volumeText = paper.volume ? `, vol. ${paper.volume}` : "";
  const issueText = paper.issue ? `, no. ${paper.issue}` : "";
  const pagesText = paper.page_range ? `, pp. ${paper.page_range}` : "";

  return `${authorText}, "${paper.title}," ${paper.journal || "Unknown Source"}${volumeText}${issueText}${pagesText}, ${year}${doiText}.`;
}

function buildApaReference(paper) {
  const year = paper.publication_date
    ? String(paper.publication_date).slice(0, 4)
    : "n.d.";

  const authorText = formatReferenceAuthors(
    paper.authors,
    paper.researchers?.name
  );

  const doiText =
    paper.doi && paper.doi !== "No DOI"
      ? ` https://doi.org/${paper.doi}`
      : "";

  return `${authorText}. (${year}). ${paper.title}. ${paper.journal || "Unknown Source"}.${doiText}`;
}

// TEST ROUTE: Find citation suggestions from selected enriched papers
app.post("/api/find-citations", async (req, res) => {
  try {
    const { paragraph } = req.body;

    if (!paragraph || paragraph.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Paragraph is required",
      });
    }

    const paragraphEmbedding = await createEmbedding(paragraph);

    // 1. Search selected enriched papers first
    const { data: selectedPapers, error: selectedError } = await supabaseAdmin
      .from("publications")
      .select(`
        id,
        title,
        doi,
        journal,
        publication_date,
        scopus_link,
        abstract,
        keywords,
        index_terms,
        authors,
        volume,
        issue,
        page_range,
        citation_ieee,
        citation_apa,
        embedding_json,
        researchers (
          name
        )
      `)
      .eq("is_selected", true)
      .not("abstract", "is", null)
      .not("embedding_json", "is", null);

    if (selectedError) {
      return res.status(500).json({
        success: false,
        error: "Failed to load selected publications",
        details: selectedError,
      });
    }

    const selectedResults = (selectedPapers || [])
      .map((paper) => {
        const similarityRaw = cosineSimilarity(
          paragraphEmbedding,
          paper.embedding_json
        );

        const similarity = Math.round(similarityRaw * 100);

        let matchStrength = "Moderate Match";
        let citationSuitability = "Use as background reference";

        if (similarity >= 75) {
          matchStrength = "Very Strong Match";
          citationSuitability = "Suitable for direct citation";
        } else if (similarity >= 60) {
          matchStrength = "Strong Match";
          citationSuitability = "Suitable for citation";
        } else if (similarity >= 45) {
          matchStrength = "Moderate Match";
          citationSuitability = "Use as background reference";
        }

        const matchReason = `This selected paper was suggested because its title, abstract, and keywords are semantically related to the paragraph. Similarity score: ${similarity}%.`;

        const ieeeReference =
          paper.citation_ieee ||
          buildIeeeReference(paper);

        const apaReference =
          paper.citation_apa ||
          buildApaReference(paper);

        return {
          id: paper.id,
          title: paper.title,
          researcher: paper.researchers?.name || null,
          doi: paper.doi,
          journal: paper.journal,
          publication_date: paper.publication_date,
          scopus_link: paper.scopus_link,
          similarity,
          similarity_raw: similarityRaw,
          match_type: "Selected paper semantic match",
          match_strength: matchStrength,
          citation_suitability: citationSuitability,
          match_reason: matchReason,
          keywords: paper.keywords,
          ieee_reference: ieeeReference,
          apa_reference: apaReference,
        };
      })
      .filter((paper) => paper.similarity >= 45)
      .sort((a, b) => b.similarity_raw - a.similarity_raw)
      .slice(0, 3);

    // 2. Search other title-only papers as possible matches
    const { data: otherPapers, error: otherError } = await supabaseAdmin
      .from("publications")
      .select(`
        id,
        title,
        doi,
        journal,
        publication_date,
        scopus_link,
        authors,
        volume,
        issue,
        page_range,
        citation_ieee,
        citation_apa,
        title_embedding_json,
        researchers (
          name
        )
      `)
      .not("title_embedding_json", "is", null);

    if (otherError) {
      return res.status(500).json({
        success: false,
        error: "Failed to load title-based publications",
        details: otherError,
      });
    }

    const otherResults = (otherPapers || [])
      .filter((paper) => {
        return !selectedResults.some(
          (selected) => String(selected.id) === String(paper.id)
        );
      })
      .map((paper) => {
        const similarityRaw = cosineSimilarity(
          paragraphEmbedding,
          paper.title_embedding_json
        );

        const similarity = Math.round(similarityRaw * 100);

        const ieeeReference =
          paper.citation_ieee ||
          buildIeeeReference(paper);

        const apaReference =
          paper.citation_apa ||
          buildApaReference(paper);

        return {
          id: paper.id,
          title: paper.title,
          researcher: paper.researchers?.name || null,
          doi: paper.doi,
          journal: paper.journal,
          publication_date: paper.publication_date,
          scopus_link: paper.scopus_link,
          similarity,
          similarity_raw: similarityRaw,
          match_type: "Possible title-based match",
          match_strength: "Possible Match",
          citation_suitability: "Review before citation",
          match_reason: `This paper was suggested from title and journal similarity only. It may be related, but the user should review it before citing. Similarity score: ${similarity}%.`,
          keywords: null,
          ieee_reference: ieeeReference,
          apa_reference: apaReference,
        };
      })
      .filter((paper) => paper.similarity >= 50)
      .sort((a, b) => b.similarity_raw - a.similarity_raw)
      .slice(0, 3);

    const results = [...selectedResults, ...otherResults];

    res.json({
      success: true,
      method: "two_level_embedding_matching",
      message:
        "Citation suggestions generated using selected-paper semantic matching and title-based matching",
      searched_selected_papers: selectedPapers.length,
      searched_title_papers: otherPapers.length,
      paragraph,
      selected_results: selectedResults,
      title_results: otherResults,
      results,
    });
  } catch (error) {
    console.error("Find citations two-level matching error:", error.message);

    res.status(500).json({
      success: false,
      error: "Failed to find citations",
      details: error.message,
    });
  }
});

// Search route: name, DOI, or Author ID publications
app.get("/api/search", async (req, res) => {
  try {
    const input = req.query.q?.trim();

    if (!input) {
      return res.status(400).json({
        message: "Search query missing",
      });
    }

    const isDOI = input.includes("/");
    const isNumericId = /^\d+$/.test(input);

    let scopusQuery = "";

    if (isDOI) {
      scopusQuery = `DOI(${input})`;
    } else if (isNumericId) {
      scopusQuery = `AU-ID(${input})`;
    } else {
      scopusQuery = `AUTH(${input})`;
    }

    const { totalResults, entries } = await fetchAllScopusPublications(
      scopusQuery
    );
    const papers = formatPapers(entries);

    res.json({
      type: isDOI ? "doi" : isNumericId ? "author_publications" : "papers",
      keyword: input,
      scopusQuery: scopusQuery,
      totalResults: totalResults,
      returnedResults: papers.length,
      papers: papers,
    });
  } catch (error) {
    res.status(500).json({
      message: "Search failed",
      error: error.response?.data || error.message,
    });
  }
});

// Get all researchers with their saved publications
app.get("/api/researchers", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("researchers")
      .select(
        `
        id,
        name,
        search_keyword,
        scopus_author_id,
        scopus_profile_url,
        total_documents,
        h_index,
        h_index_last_checked,
        h_index_status,
        h_index_update_method,
        selected_paper_1_title,
        selected_paper_1_link,
        selected_paper_2_title,
        selected_paper_2_link,
        publications (
          id,
          title,
          doi,
          scopus_document_id,
          journal,
          publication_date,
          scopus_link
        )
      `
      )
      .order("id", { ascending: true });

    if (error) {
      return res.status(500).json({
        message: "Failed to load researchers",
        error: error,
      });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({
      message: "Failed to load researchers",
      error: error.message,
    });
  }
});

// Import publications for one researcher
app.get("/api/import-publications/:researcherId", async (req, res) => {
  try {
    const researcherId = req.params.researcherId;

    const { data: researcher, error: researcherError } = await supabaseAdmin
      .from("researchers")
      .select("*")
      .eq("id", researcherId)
      .single();

    if (researcherError || !researcher) {
      return res.status(404).json({
        message: "Researcher not found",
        error: researcherError,
      });
    }

    if (!researcher.scopus_author_id) {
      return res.status(400).json({
        message: "This researcher does not have a Scopus Author ID yet",
        researcher: researcher.name,
      });
    }

    const scopusQuery = `AU-ID(${researcher.scopus_author_id})`;

    const { totalResults, entries } = await fetchAllScopusPublications(
      scopusQuery
    );
    const papers = formatPapers(entries);

    const { error: deleteError } = await supabaseAdmin
      .from("publications")
      .delete()
      .eq("researcher_id", researcherId);

    if (deleteError) {
      return res.status(500).json({
        message: "Failed to delete old publications",
        error: deleteError,
      });
    }

    const publicationsToInsert = papers.map((paper) => ({
      researcher_id: researcher.id,
      title: paper.title,
      doi: paper.doi,
      scopus_document_id: paper.scopus_document_id,
      journal: paper.journal,
      publication_date: paper.publication_date,
      scopus_link: paper.scopus_link,
    }));

    if (publicationsToInsert.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from("publications")
        .insert(publicationsToInsert);

      if (insertError) {
        return res.status(500).json({
          message: "Failed to save publications to Supabase",
          error: insertError,
        });
      }
    }

    const { error: updateTotalError } = await supabaseAdmin
      .from("researchers")
      .update({
        total_documents: totalResults,
      })
      .eq("id", researcher.id);

    if (updateTotalError) {
      return res.status(500).json({
        message: "Failed to update researcher total documents",
        error: updateTotalError,
      });
    }

    res.json({
      message: "Publications imported successfully",
      researcher: researcher.name,
      scopusAuthorId: researcher.scopus_author_id,
      totalFoundInScopus: totalResults,
      savedToDatabase: publicationsToInsert.length,
      publications: publicationsToInsert,
    });
  } catch (error) {
    res.status(500).json({
      message: "Import failed",
      error: error.response?.data || error.message,
    });
  }
});

// Import publications for all researchers that have Scopus Author ID
app.get("/api/import-all-publications", async (req, res) => {
  try {
    const { data: researchers, error: researchersError } = await supabaseAdmin
      .from("researchers")
      .select("*")
      .not("scopus_author_id", "is", null)
      .order("id", { ascending: true });

    if (researchersError) {
      return res.status(500).json({
        message: "Failed to load researchers",
        error: researchersError,
      });
    }

    const results = [];

    for (const researcher of researchers) {
      try {
        const scopusQuery = `AU-ID(${researcher.scopus_author_id})`;

        const { totalResults, entries } = await fetchAllScopusPublications(
          scopusQuery
        );
        const papers = formatPapers(entries);

        await supabaseAdmin
          .from("publications")
          .delete()
          .eq("researcher_id", researcher.id);

        const publicationsToInsert = papers.map((paper) => ({
          researcher_id: researcher.id,
          title: paper.title,
          doi: paper.doi,
          scopus_document_id: paper.scopus_document_id,
          journal: paper.journal,
          publication_date: paper.publication_date,
          scopus_link: paper.scopus_link,
        }));

        if (publicationsToInsert.length > 0) {
          const { error: insertError } = await supabaseAdmin
            .from("publications")
            .insert(publicationsToInsert);

          if (insertError) {
            results.push({
              researcher: researcher.name,
              scopusAuthorId: researcher.scopus_author_id,
              status: "failed",
              error: insertError,
            });
            continue;
          }
        }

        const { error: updateTotalError } = await supabaseAdmin
          .from("researchers")
          .update({
            total_documents: totalResults,
          })
          .eq("id", researcher.id);

        if (updateTotalError) {
          results.push({
            researcher: researcher.name,
            scopusAuthorId: researcher.scopus_author_id,
            status: "failed",
            error: updateTotalError,
          });
          continue;
        }

        results.push({
          researcher: researcher.name,
          scopusAuthorId: researcher.scopus_author_id,
          status: "success",
          totalFoundInScopus: totalResults,
          savedToDatabase: publicationsToInsert.length,
        });
      } catch (singleError) {
        results.push({
          researcher: researcher.name,
          scopusAuthorId: researcher.scopus_author_id,
          status: "failed",
          error: singleError.response?.data || singleError.message,
        });
      }
    }

    res.json({
      message: "Import all finished",
      totalResearchers: researchers.length,
      results: results,
    });
  } catch (error) {
    res.status(500).json({
      message: "Import all failed",
      error: error.response?.data || error.message,
    });
  }
});

// RPA route: update H-index only using POST
app.post("/api/update-hindex", async (req, res) => {
  try {
    const { scopus_author_id, h_index } = req.body;

    console.log("Incoming RPA H-index data:", req.body);

    if (!scopus_author_id || h_index === undefined || h_index === null) {
      return res.status(400).json({
        success: false,
        error: "scopus_author_id and h_index are required",
      });
    }

    const cleanHIndex = Number(h_index);

    if (Number.isNaN(cleanHIndex)) {
      return res.status(400).json({
        success: false,
        error: "h_index must be a valid number",
        received: h_index,
      });
    }

    const { data, error } = await supabaseAdmin
      .from("researchers")
      .update({
        h_index: cleanHIndex,
        h_index_last_checked: new Date().toISOString(),
        h_index_status: "updated",
        h_index_update_method: "rpa",
      })
      .eq("scopus_author_id", String(scopus_author_id))
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No researcher found with this scopus_author_id",
        scopus_author_id,
      });
    }

    res.json({
      success: true,
      message: "H-index updated successfully",
      data,
    });
  } catch (err) {
    console.error("Update H-index error:", err.message);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// RPA route: update H-index and selected papers using POST
app.post("/api/update-hindex-selected-papers", async (req, res) => {
  try {
    const {
      scopus_author_id,
      h_index,
      selected_paper_1_title,
      selected_paper_1_link,
      selected_paper_2_title,
      selected_paper_2_link,
    } = req.body;

    console.log("Incoming RPA H-index + selected papers data:", req.body);

    if (!scopus_author_id || h_index === undefined || h_index === null) {
      return res.status(400).json({
        success: false,
        error: "scopus_author_id and h_index are required",
      });
    }

    const cleanHIndex = Number(h_index);

    if (Number.isNaN(cleanHIndex)) {
      return res.status(400).json({
        success: false,
        error: "h_index must be a valid number",
        received: h_index,
      });
    }

    const { data, error } = await supabaseAdmin
      .from("researchers")
      .update({
        h_index: cleanHIndex,
        selected_paper_1_title: selected_paper_1_title || null,
        selected_paper_1_link: selected_paper_1_link || null,
        selected_paper_2_title: selected_paper_2_title || null,
        selected_paper_2_link: selected_paper_2_link || null,
        h_index_last_checked: new Date().toISOString(),
        h_index_status: "updated",
        h_index_update_method: "rpa",
      })
      .eq("scopus_author_id", String(scopus_author_id))
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No researcher found with this scopus_author_id",
        scopus_author_id,
      });
    }

    res.json({
      success: true,
      message: "H-index and selected papers updated successfully",
      data,
    });
  } catch (err) {
    console.error("Update H-index selected papers error:", err.message);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Power Automate friendly GET route: update H-index only
app.get("/api/update-hindex-rpa", async (req, res) => {
  try {
    const { scopus_author_id, h_index } = req.query;

    console.log("Incoming RPA GET data:", req.query);

    if (!scopus_author_id || h_index === undefined || h_index === null) {
      return res.status(400).json({
        success: false,
        error: "scopus_author_id and h_index are required",
      });
    }

    const cleanHIndex = Number(h_index);

    if (Number.isNaN(cleanHIndex)) {
      return res.status(400).json({
        success: false,
        error: "h_index must be a valid number",
        received: h_index,
      });
    }

    const { data, error } = await supabaseAdmin
      .from("researchers")
      .update({
        h_index: cleanHIndex,
        h_index_last_checked: new Date().toISOString(),
        h_index_status: "updated",
        h_index_update_method: "rpa",
      })
      .eq("scopus_author_id", String(scopus_author_id))
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No researcher found with this scopus_author_id",
        scopus_author_id,
      });
    }

    res.json({
      success: true,
      message: "H-index updated successfully from Power Automate",
      data,
    });
  } catch (err) {
    console.error("RPA GET H-index update error:", err.message);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Power Automate friendly GET route: update H-index and selected papers
app.get("/api/update-selected-papers-rpa", async (req, res) => {
  try {
    const {
      scopus_author_id,
      h_index,
      selected_paper_1_title,
      selected_paper_2_title,
    } = req.query;

    console.log("Incoming selected papers from RPA:", req.query);

    if (!scopus_author_id || h_index === undefined || h_index === null) {
      return res.status(400).json({
        success: false,
        error: "scopus_author_id and h_index are required",
      });
    }

    const cleanHIndex = Number(h_index);

    if (Number.isNaN(cleanHIndex)) {
      return res.status(400).json({
        success: false,
        error: "h_index must be a valid number",
        received: h_index,
      });
    }

    const { data, error } = await supabaseAdmin
      .from("researchers")
      .update({
        h_index: cleanHIndex,
        selected_paper_1_title: selected_paper_1_title || null,
        selected_paper_2_title: selected_paper_2_title || null,
        h_index_last_checked: new Date().toISOString(),
        h_index_status: "updated",
        h_index_update_method: "rpa",
      })
      .eq("scopus_author_id", String(scopus_author_id))
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No researcher found with this Scopus Author ID",
        scopus_author_id,
      });
    }

    res.json({
      success: true,
      message: "H-index and selected papers updated successfully",
      data,
    });
  } catch (err) {
    console.error("Selected papers update error:", err.message);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// RPA route: get researchers for Power Automate loop
app.get("/api/rpa-researchers", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("researchers")
      .select("id, name, scopus_author_id, scopus_profile_url")
      .not("scopus_author_id", "is", null)
      .not("scopus_profile_url", "is", null)
      .order("id", { ascending: true });

    if (error) throw error;

    res.json({
      success: true,
      total: data.length,
      researchers: data,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Optional monthly import job
// This imports publication list only, not H-index.
// H-index will come from Power Automate RPA.
cron.schedule("0 0 1 * *", async () => {
  console.log("Monthly publication import cron started...");

  try {
    const { data: researchers, error: researchersError } = await supabaseAdmin
      .from("researchers")
      .select("*")
      .not("scopus_author_id", "is", null)
      .order("id", { ascending: true });

    if (researchersError) {
      console.error("Cron failed to load researchers:", researchersError);
      return;
    }

    for (const researcher of researchers) {
      try {
        const scopusQuery = `AU-ID(${researcher.scopus_author_id})`;

        const { totalResults, entries } = await fetchAllScopusPublications(
          scopusQuery
        );
        const papers = formatPapers(entries);

        await supabaseAdmin
          .from("publications")
          .delete()
          .eq("researcher_id", researcher.id);

        const publicationsToInsert = papers.map((paper) => ({
          researcher_id: researcher.id,
          title: paper.title,
          doi: paper.doi,
          scopus_document_id: paper.scopus_document_id,
          journal: paper.journal,
          publication_date: paper.publication_date,
          scopus_link: paper.scopus_link,
        }));

        if (publicationsToInsert.length > 0) {
          const { error: insertError } = await supabaseAdmin
            .from("publications")
            .insert(publicationsToInsert);

          if (insertError) {
            console.error(
              `Cron insert failed for ${researcher.name}:`,
              insertError
            );
            continue;
          }
        }

        const { error: updateTotalError } = await supabaseAdmin
          .from("researchers")
          .update({
            total_documents: totalResults,
          })
          .eq("id", researcher.id);

        if (updateTotalError) {
          console.error(
            `Cron total_documents update failed for ${researcher.name}:`,
            updateTotalError
          );
          continue;
        }

        console.log(
          `Cron imported ${publicationsToInsert.length}/${totalResults} publications for ${researcher.name}`
        );
      } catch (singleError) {
        console.error(
          `Cron failed for researcher:`,
          singleError.response?.data || singleError.message
        );
      }
    }

    console.log("Monthly publication import cron finished.");
  } catch (error) {
    console.error("Monthly publication import cron failed:", error.message);
  }
});

app.get("/api/admin/selected-papers/:researcherId", async (req, res) => {
  try {
    const { researcherId } = req.params;

    const { data: researcher, error: researcherError } = await supabaseAdmin
      .from("researchers")
      .select(`
        id,
        name,
        selected_paper_1_title,
        selected_paper_1_link,
        selected_paper_2_title,
        selected_paper_2_link
      `)
      .eq("id", researcherId)
      .single();

    if (researcherError) {
      return res.status(500).json({
        success: false,
        error: "Failed to load researcher",
        details: researcherError.message,
      });
    }

    const selectedTitles = [
      researcher.selected_paper_1_title,
      researcher.selected_paper_2_title,
    ].filter(Boolean);

    const { data: papers, error: papersError } = await supabaseAdmin
      .from("publications")
      .select(`
        id,
        researcher_id,
        title,
        doi,
        journal,
        publication_date,
        scopus_link,
        abstract,
        keywords,
        index_terms,
        authors,
        volume,
        issue,
        page_range,
        is_selected
      `)
      .eq("researcher_id", researcherId)
      .in("title", selectedTitles);

    if (papersError) {
      return res.status(500).json({
        success: false,
        error: "Failed to load selected papers",
        details: papersError.message,
      });
    }

    const selectedPaper1 =
      papers.find((p) => p.title === researcher.selected_paper_1_title) || null;

    const selectedPaper2 =
      papers.find((p) => p.title === researcher.selected_paper_2_title) || null;

    res.json({
      success: true,
      researcher,
      selected_paper_1: selectedPaper1
        ? {
            ...selectedPaper1,
            scopus_link:
              selectedPaper1.scopus_link || researcher.selected_paper_1_link,
          }
        : {
            title: researcher.selected_paper_1_title,
            scopus_link: researcher.selected_paper_1_link,
          },
      selected_paper_2: selectedPaper2
        ? {
            ...selectedPaper2,
            scopus_link:
              selectedPaper2.scopus_link || researcher.selected_paper_2_link,
          }
        : {
            title: researcher.selected_paper_2_title,
            scopus_link: researcher.selected_paper_2_link,
          },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
});

app.post("/api/admin/update-selected-paper", async (req, res) => {
  try {
    const {
      paper_id,
      title,
      researcher_id,
      authors,
      doi,
      journal,
      publication_date,
      volume,
      issue,
      page_range,
      abstract,
      keywords,
      index_terms,
      scopus_link,
    } = req.body;

    if (!title || !researcher_id) {
      return res.status(400).json({
        success: false,
        error: "Paper title and researcher ID are required",
      });
    }

    const paperData = {
      researcher_id,
      title,
      authors: authors || null,
      doi: doi || null,
      journal: journal || null,
      publication_date: publication_date || null,
      volume: volume || null,
      issue: issue || null,
      page_range: page_range || null,
      abstract: abstract || null,
      keywords: keywords || null,
      index_terms: index_terms || null,
      scopus_link: scopus_link || null,
      is_selected: true,
    };

    let savedPaper;

    if (paper_id) {
      const { data, error } = await supabaseAdmin
        .from("publications")
        .update(paperData)
        .eq("id", paper_id)
        .select()
        .single();

      if (error) {
        return res.status(500).json({
          success: false,
          error: "Failed to update selected paper",
          details: error.message,
        });
      }

      savedPaper = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from("publications")
        .insert([paperData])
        .select()
        .single();

      if (error) {
        return res.status(500).json({
          success: false,
          error: "Failed to insert selected paper",
          details: error.message,
        });
      }

      savedPaper = data;
    }

    let embedding = null;

    if (abstract && abstract.trim() !== "") {
      const textForEmbedding = buildPaperEmbeddingText(savedPaper);
      embedding = await createEmbedding(textForEmbedding);

      const { error: embeddingError } = await supabaseAdmin
        .from("publications")
        .update({
          embedding_json: embedding,
        })
        .eq("id", savedPaper.id);

      if (embeddingError) {
        return res.status(500).json({
          success: false,
          error: "Paper saved but embedding failed",
          details: embeddingError.message,
        });
      }
    }

    res.json({
      success: true,
      message: "Selected paper metadata saved successfully",
      paper_id: savedPaper.id,
      embedding_generated: !!embedding,
    });
  } catch (error) {
    console.error("Update selected paper error:", error.message);

    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
});

// For local development
const PORT = process.env.PORT || 5000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// For Vercel
module.exports = app;
