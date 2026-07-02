const express = require("express");
const path = require("path");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

// Supabase backend client
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SCOPUS_API_URL = "https://api.elsevier.com/content/search/scopus";

// 200 is enough for your current lecturers because the highest is around 179.
const MAX_PUBLICATIONS_PER_RESEARCHER = 200;
const SCOPUS_BATCH_SIZE = 25;

// Test route
// Serve login page first
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Serve frontend files
app.use(express.static(path.join(__dirname, "public")));

// Check keys
app.get("/api/test-key", (req, res) => {
  res.json({
    scopusKeyLoaded: !!process.env.SCOPUS_API_KEY,
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
      journal: item["prism:publicationName"] || "No journal",
      publication_date: item["prism:coverDate"] || "No date",
      scopus_link: scopusLink,
    };
  });
}

// Fetch all Scopus publications using pagination
async function fetchAllScopusPublications(scopusQuery) {
  let allEntries = [];
  let start = 0;
  let totalResults = null;

  while (allEntries.length < MAX_PUBLICATIONS_PER_RESEARCHER) {
    const response = await axios.get(SCOPUS_API_URL, {
      headers: {
        "X-ELS-APIKey": process.env.SCOPUS_API_KEY,
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

    const { totalResults, entries } = await fetchAllScopusPublications(scopusQuery);
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
      .select(`
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
      `)
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

    const { totalResults, entries } = await fetchAllScopusPublications(scopusQuery);
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

        const { totalResults, entries } = await fetchAllScopusPublications(scopusQuery);
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

        const { totalResults, entries } = await fetchAllScopusPublications(scopusQuery);
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
            console.error(`Cron insert failed for ${researcher.name}:`, insertError);
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

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
