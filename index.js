import { tool } from "@opencode-ai/plugin/tool";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createRequire } from "module";

// better-sqlite3 is a CJS module, needs createRequire for ESM
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// ============================================================================
// OPENCODE SESSION GUARDIAN PLUGIN
// ============================================================================
// Solves 3 critical problems:
//   1. Sessions crashing from oversized images/screenshots (>8000px API limit)
//   2. Total context loss when a session breaks
//   3. No way to recover work from previous sessions
//
// How it works:
//   - PREVENTS crashes by intercepting fullPage screenshots before they execute
//   - FILTERS oversized base64 images from the message history sent to the LLM
//   - TRUNCATES tool outputs that exceed safe size limits
//   - IMPROVES session compaction with better summarization prompts
//   - PROVIDES 4 tools to list, search, and recover context from any session
// ============================================================================

const DB_PATH = join(
  process.env.HOME || "",
  ".local/share/opencode/opencode.db"
);
const STORAGE_PATH = join(
  process.env.HOME || "",
  ".local/share/opencode/storage"
);

// Safe limits below the 8000px API maximum
const MAX_IMAGE_DIMENSION = 7000;
// 4MB max for base64 content in context — prevents memory bloat
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024;

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Open a read-only connection to OpenCode's SQLite database.
 * Returns null if the database doesn't exist or can't be opened.
 */
function getDb() {
  try {
    if (existsSync(DB_PATH)) {
      return new Database(DB_PATH, { readonly: true });
    }
  } catch (e) {
    // fallback to file-based storage
  }
  return null;
}

/**
 * Read sessions from file-based JSON storage (fallback when DB is unavailable).
 */
function getSessionsFromStorage(projectDir) {
  const sessions = [];
  try {
    const sessionDirs = readdirSync(join(STORAGE_PATH, "session"));
    for (const dir of sessionDirs) {
      const sessionDir = join(STORAGE_PATH, "session", dir);
      try {
        const files = readdirSync(sessionDir);
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          try {
            const data = JSON.parse(
              readFileSync(join(sessionDir, f), "utf-8")
            );
            if (!projectDir || data.directory === projectDir) {
              sessions.push(data);
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return sessions.sort(
    (a, b) => (b.time?.updated || 0) - (a.time?.updated || 0)
  );
}

/**
 * Read messages for a session from file-based JSON storage.
 */
function getSessionMessages(sessionId) {
  const messages = [];
  try {
    const msgDir = join(STORAGE_PATH, "message", sessionId);
    if (existsSync(msgDir)) {
      const files = readdirSync(msgDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(join(msgDir, f), "utf-8"));
          messages.push(data);
        } catch {}
      }
    }
  } catch {}
  return messages.sort(
    (a, b) => (a.time?.created || 0) - (b.time?.created || 0)
  );
}

/**
 * Read parts (text chunks, tool calls) for a message from file-based storage.
 */
function getMessageParts(messageId) {
  const parts = [];
  try {
    const partDir = join(STORAGE_PATH, "part", messageId);
    if (existsSync(partDir)) {
      const files = readdirSync(partDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(join(partDir, f), "utf-8"));
          parts.push(data);
        } catch {}
      }
    }
  } catch {}
  return parts;
}

/**
 * Generate a conversation summary from the SQLite database (primary method).
 * Much more reliable than file-based storage.
 */
function summarizeSessionFromDb(sessionId, maxMessages = 20) {
  const db = getDb();
  if (!db) return null;

  try {
    const messages = db
      .prepare(
        `SELECT m.id, json_extract(m.data, '$.role') as role,
                m.time_created
         FROM message m
         WHERE m.session_id = ?
         ORDER BY m.time_created DESC
         LIMIT ?`
      )
      .all(sessionId, maxMessages);

    if (messages.length === 0) {
      db.close();
      return null;
    }

    // Reverse to chronological order
    messages.reverse();

    const summary = [];
    for (const msg of messages) {
      const parts = db
        .prepare(
          `SELECT json_extract(data, '$.type') as type,
                  json_extract(data, '$.text') as text,
                  json_extract(data, '$.tool') as tool,
                  json_extract(data, '$.state.title') as tool_title,
                  json_extract(data, '$.state.status') as tool_status
           FROM part
           WHERE message_id = ?`
        )
        .all(msg.id);

      if (msg.role === "user") {
        const textParts = parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n");
        if (textParts.trim()) {
          summary.push(`[USER]: ${textParts.substring(0, 500)}`);
        }
      } else if (msg.role === "assistant") {
        const textParts = parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n");
        if (textParts.trim()) {
          summary.push(`[ASSISTANT]: ${textParts.substring(0, 800)}`);
        }

        for (const tp of parts) {
          if (tp.type === "tool" && tp.tool_status === "completed") {
            summary.push(
              `  [TOOL ${tp.tool || "unknown"}]: ${tp.tool_title || ""}`
            );
          }
        }
      }
    }

    db.close();
    return summary.join("\n\n");
  } catch (e) {
    try {
      db.close();
    } catch {}
    return null;
  }
}

/**
 * Generate a conversation summary. Tries SQLite first, falls back to file storage.
 */
function summarizeSession(sessionId, maxMessages = 20) {
  // Try DB first (more reliable, has all data)
  const dbSummary = summarizeSessionFromDb(sessionId, maxMessages);
  if (dbSummary) return dbSummary;

  // Fallback to file-based storage
  const messages = getSessionMessages(sessionId);
  const summary = [];
  const relevant = messages.slice(-maxMessages);

  for (const msg of relevant) {
    const parts = getMessageParts(msg.id);
    const textParts = parts.filter((p) => p.type === "text" && p.text);
    const toolParts = parts.filter((p) => p.type === "tool");

    if (msg.role === "user") {
      const userText = textParts.map((p) => p.text).join("\n");
      if (userText.trim()) {
        summary.push(`[USER]: ${userText.substring(0, 500)}`);
      }
    } else if (msg.role === "assistant") {
      const assistantText = textParts.map((p) => p.text).join("\n");
      if (assistantText.trim()) {
        summary.push(`[ASSISTANT]: ${assistantText.substring(0, 800)}`);
      }

      for (const tp of toolParts) {
        if (tp.state?.status === "completed") {
          const toolName = tp.tool || "unknown";
          const title = tp.state?.title || "";
          summary.push(`  [TOOL ${toolName}]: ${title}`);
        }
      }
    }
  }

  return summary.join("\n\n");
}

/**
 * Format session metadata into a human-readable string.
 */
function formatSessionInfo(session) {
  const created = session.time?.created
    ? new Date(session.time.created).toLocaleString()
    : "unknown";
  const updated = session.time?.updated
    ? new Date(session.time.updated).toLocaleString()
    : "unknown";
  return [
    `ID: ${session.id}`,
    `Slug: ${session.slug || "N/A"}`,
    `Title: ${session.title || "Untitled"}`,
    `Directory: ${session.directory || "N/A"}`,
    `Created: ${created}`,
    `Updated: ${updated}`,
    `Files changed: ${session.summary?.files || 0} (+${session.summary?.additions || 0} -${session.summary?.deletions || 0})`,
  ].join("\n");
}

// ============================================================================
// PLUGIN EXPORT
// ============================================================================

/** @type {import("@opencode-ai/plugin").PluginModule} */
export default {
  id: "session-guardian",
  server: async (ctx) => {
    const projectDir = ctx.directory;

    return {
      // ==================================================================
      // HOOK: Intercept screenshots BEFORE execution
      // Prevents fullPage screenshots that exceed 8000px API limit
      // ==================================================================
      "tool.execute.before": async (input, output) => {
        const screenshotTools = [
          "chrome-devtools_take_screenshot",
          "xcodebuildmcp_screenshot",
          "mcp_chrome-devtools_take_screenshot",
          "mcp_xcodebuildmcp_screenshot",
          "take_screenshot",
          "screenshot",
        ];

        if (screenshotTools.some((t) => input.tool.includes(t))) {
          if (output.args && output.args.fullPage === true) {
            console.log(
              "[SESSION-GUARDIAN] Intercepting fullPage screenshot → viewport only (prevents 8000px crash)"
            );
            output.args.fullPage = false;
          }
        }
      },

      // ==================================================================
      // HOOK: After tool execution, truncate oversized outputs
      // ==================================================================
      "tool.execute.after": async (input, output) => {
        if (output.output && output.output.length > MAX_IMAGE_SIZE_BYTES) {
          console.log(
            `[SESSION-GUARDIAN] Output from ${input.tool} too large (${(output.output.length / 1024 / 1024).toFixed(1)}MB), truncating to protect session`
          );
          output.output =
            `[SESSION-GUARDIAN] Output from ${input.tool} was truncated (exceeded ${(MAX_IMAGE_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB limit). ` +
            `Use smaller dimensions or avoid fullPage screenshots.\n\n` +
            `Original output (first 2000 chars):\n${output.output.substring(0, 2000)}`;
        }
      },

      // ==================================================================
      // HOOK: Transform messages before sending to LLM
      // Strips oversized base64 images from conversation history
      // ==================================================================
      "experimental.chat.messages.transform": async (_input, output) => {
        let filtered = 0;

        for (const msg of output.messages) {
          const newParts = [];
          for (const part of msg.parts) {
            // Filter out enormous base64 image parts
            if (part.type === "file" && part.url) {
              if (
                part.url.startsWith("data:image") &&
                part.url.length > MAX_IMAGE_SIZE_BYTES
              ) {
                newParts.push({
                  ...part,
                  type: "text",
                  text: `[SESSION-GUARDIAN] Image removed from context (${(part.url.length / 1024 / 1024).toFixed(1)}MB) to prevent session crash. File: ${part.filename || "screenshot"}`,
                  url: undefined,
                });
                filtered++;
                continue;
              }
            }

            // Filter oversized tool outputs
            if (
              part.type === "tool" &&
              part.state?.status === "completed" &&
              part.state?.output
            ) {
              if (part.state.output.length > MAX_IMAGE_SIZE_BYTES) {
                part.state.output =
                  `[SESSION-GUARDIAN] Output truncated (${(part.state.output.length / 1024 / 1024).toFixed(1)}MB). ` +
                  `Tool: ${part.tool}. Summary: ${part.state.title || "N/A"}`;
                filtered++;
              }
            }

            newParts.push(part);
          }
          msg.parts = newParts;
        }

        if (filtered > 0) {
          console.log(
            `[SESSION-GUARDIAN] Filtered ${filtered} oversized parts from context`
          );
        }
      },

      // ==================================================================
      // HOOK: Improve session compaction summaries
      // ==================================================================
      "experimental.session.compacting": async (_input, output) => {
        output.context.push(
          `IMPORTANT: This session may have had large images/screenshots that were filtered to prevent context loss. ` +
            `When summarizing, focus on:\n` +
            `1. What was the user working on (project, specific files, features)\n` +
            `2. What changes were made (file modifications, code written)\n` +
            `3. What was the current state of work (what's done, what's pending)\n` +
            `4. Any specific decisions or preferences the user expressed\n` +
            `5. The current directory and project context\n\n` +
            `Make the summary detailed enough that a new session can continue exactly where this one left off.`
        );
      },

      // ==================================================================
      // CUSTOM TOOLS
      // ==================================================================
      tool: {
        // ----------------------------------------------------------------
        // List recent sessions for the current project
        // ----------------------------------------------------------------
        session_list: tool({
          description:
            "List recent sessions for the current project directory. Use this to find previous sessions when context was lost. Shows session ID, title, date, and file changes.",
          args: {
            limit: tool.schema
              .number()
              .optional()
              .describe("Maximum number of sessions to return (default 10)"),
            directory: tool.schema
              .string()
              .optional()
              .describe(
                "Filter by project directory (defaults to current project)"
              ),
          },
          async execute(args) {
            const dir = args.directory || projectDir;
            const limit = args.limit || 10;

            const db = getDb();
            let sessions = [];

            if (db) {
              try {
                const rows = db
                  .prepare(
                    `SELECT id, slug, title, directory,
                            time_created, time_updated,
                            summary_additions, summary_deletions, summary_files
                     FROM session
                     WHERE directory = ?
                     ORDER BY time_updated DESC
                     LIMIT ?`
                  )
                  .all(dir, limit);
                db.close();

                sessions = rows.map((r) => ({
                  id: r.id,
                  slug: r.slug,
                  title: r.title,
                  directory: r.directory,
                  time: { created: r.time_created, updated: r.time_updated },
                  summary: {
                    additions: r.summary_additions,
                    deletions: r.summary_deletions,
                    files: r.summary_files,
                  },
                }));
              } catch (e) {
                db.close();
              }
            }

            if (sessions.length === 0) {
              sessions = getSessionsFromStorage(dir).slice(0, limit);
            }

            if (sessions.length === 0) {
              return `No sessions found for directory: ${dir}`;
            }

            const result = sessions
              .map((s) => formatSessionInfo(s))
              .join("\n\n---\n\n");
            return `Sessions found (${sessions.length}):\n\n${result}`;
          },
        }),

        // ----------------------------------------------------------------
        // Recover context from a specific session
        // ----------------------------------------------------------------
        session_recover: tool({
          description:
            "Recover context from a previous session by ID. Use this when the current session lost context (e.g. after a crash from large images). Returns a summary of messages, tool calls, and file changes.",
          args: {
            session_id: tool.schema
              .string()
              .describe("The session ID to recover context from"),
            max_messages: tool.schema
              .number()
              .optional()
              .describe(
                "Maximum recent messages to include in summary (default 30)"
              ),
          },
          async execute(args) {
            const sessionId = args.session_id;
            const maxMessages = args.max_messages || 30;

            const db = getDb();
            let sessionInfo = null;

            if (db) {
              try {
                const row = db
                  .prepare(`SELECT * FROM session WHERE id = ?`)
                  .get(sessionId);
                if (row) {
                  sessionInfo = {
                    id: row.id,
                    slug: row.slug,
                    title: row.title,
                    directory: row.directory,
                    time: {
                      created: row.time_created,
                      updated: row.time_updated,
                    },
                    summary: {
                      additions: row.summary_additions,
                      deletions: row.summary_deletions,
                      files: row.summary_files,
                    },
                  };
                }
                db.close();
              } catch (e) {
                db.close();
              }
            }

            const conversationSummary = summarizeSession(
              sessionId,
              maxMessages
            );

            let diffs = "";
            try {
              const diffPath = join(
                STORAGE_PATH,
                "session_diff",
                `${sessionId}.json`
              );
              if (existsSync(diffPath)) {
                const diffData = JSON.parse(readFileSync(diffPath, "utf-8"));
                if (Array.isArray(diffData) && diffData.length > 0) {
                  diffs = diffData
                    .map(
                      (d) =>
                        `File: ${d.file} (+${d.additions || 0} -${d.deletions || 0})`
                    )
                    .join("\n");
                }
              }
            } catch {}

            let result = `=== RECOVERED CONTEXT FROM PREVIOUS SESSION ===\n\n`;

            if (sessionInfo) {
              result += `Session info:\n${formatSessionInfo(sessionInfo)}\n\n`;
            }

            if (diffs) {
              result += `Files modified:\n${diffs}\n\n`;
            }

            if (conversationSummary) {
              result += `Conversation summary (last ${maxMessages} messages):\n\n${conversationSummary}`;
            } else {
              result += `No messages found for this session.`;
            }

            return result;
          },
        }),

        // ----------------------------------------------------------------
        // Search sessions by text content
        // ----------------------------------------------------------------
        session_search: tool({
          description:
            "Search across all sessions for specific text in messages. Useful when you need to find a session where specific work was done but don't remember the session ID.",
          args: {
            query: tool.schema
              .string()
              .describe("Text to search for in session messages"),
            limit: tool.schema
              .number()
              .optional()
              .describe("Maximum number of results (default 5)"),
          },
          async execute(args) {
            const db = getDb();
            const limit = args.limit || 5;

            if (!db) {
              return "Could not access the session database.";
            }

            try {
              const rows = db
                .prepare(
                  `SELECT DISTINCT p.session_id, s.title, s.directory, s.time_updated,
                          substr(json_extract(p.data, '$.text'), 1, 200) as snippet
                   FROM part p
                   JOIN session s ON p.session_id = s.id
                   WHERE json_extract(p.data, '$.type') = 'text'
                     AND json_extract(p.data, '$.text') LIKE ?
                   ORDER BY s.time_updated DESC
                   LIMIT ?`
                )
                .all(`%${args.query}%`, limit);
              db.close();

              if (rows.length === 0) {
                return `No sessions found containing: "${args.query}"`;
              }

              const results = rows.map((r) => {
                const updated = r.time_updated
                  ? new Date(r.time_updated).toLocaleString()
                  : "unknown";
                return `Session: ${r.session_id}\nTitle: ${r.title || "Untitled"}\nDirectory: ${r.directory || "N/A"}\nUpdated: ${updated}\nSnippet: ${r.snippet || ""}`;
              });

              return `Results (${rows.length}):\n\n${results.join("\n\n---\n\n")}`;
            } catch (e) {
              db.close();
              return `Search error: ${e.message}`;
            }
          },
        }),

        // ----------------------------------------------------------------
        // Automatically recover the last crashed session
        // ----------------------------------------------------------------
        session_recover_last: tool({
          description:
            "Automatically recover context from the most recent broken/crashed session in the current project. Use this as the FIRST thing when starting a new session after a crash.",
          args: {},
          async execute() {
            const db = getDb();

            if (!db) {
              const sessions = getSessionsFromStorage(projectDir);
              if (sessions.length < 2) {
                return "No previous sessions found to recover.";
              }

              const previousSession = sessions[1];
              const summary = summarizeSession(previousSession.id, 30);

              return (
                `=== AUTOMATICALLY RECOVERED CONTEXT ===\n\n` +
                `Previous session: ${previousSession.title || previousSession.slug}\n` +
                `Directory: ${previousSession.directory}\n\n` +
                `${summary}`
              );
            }

            try {
              const rows = db
                .prepare(
                  `SELECT id, title, slug, directory, time_updated
                   FROM session
                   WHERE directory = ?
                   ORDER BY time_updated DESC
                   LIMIT 3`
                )
                .all(projectDir);
              db.close();

              if (rows.length < 2) {
                return "No previous sessions found to recover.";
              }

              const prevSession = rows[1];
              const summary = summarizeSession(prevSession.id, 30);

              let diffs = "";
              try {
                const diffPath = join(
                  STORAGE_PATH,
                  "session_diff",
                  `${prevSession.id}.json`
                );
                if (existsSync(diffPath)) {
                  const diffData = JSON.parse(
                    readFileSync(diffPath, "utf-8")
                  );
                  if (Array.isArray(diffData)) {
                    diffs = diffData
                      .map(
                        (d) =>
                          `  - ${d.file} (+${d.additions || 0} -${d.deletions || 0})`
                      )
                      .join("\n");
                  }
                }
              } catch {}

              return (
                `=== AUTOMATICALLY RECOVERED CONTEXT ===\n\n` +
                `Previous session: "${prevSession.title || prevSession.slug}"\n` +
                `Directory: ${prevSession.directory}\n` +
                `Last activity: ${new Date(prevSession.time_updated).toLocaleString()}\n\n` +
                (diffs ? `Files modified:\n${diffs}\n\n` : "") +
                `Conversation:\n\n${summary}`
              );
            } catch (e) {
              return `Error recovering context: ${e.message}`;
            }
          },
        }),
      },
    };
  },
};
