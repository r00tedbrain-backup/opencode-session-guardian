import { tool } from "@opencode-ai/plugin/tool";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

// ============================================================================
// OPENCODE SESSION GUARDIAN PLUGIN
// ============================================================================
// Solves 3 critical problems:
//   1. Sessions crashing from oversized images/screenshots (>8000px API limit)
//   2. Total context loss when a session breaks
//   3. No way to recover work from previous sessions
//
// Uses system sqlite3 CLI (no native Node modules needed)
// ============================================================================

const DB_PATH = join(
  process.env.HOME || "",
  ".local/share/opencode/opencode.db"
);
const STORAGE_PATH = join(
  process.env.HOME || "",
  ".local/share/opencode/storage"
);
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB max for base64 in context

// ============================================================================
// SQLite via CLI (zero native dependencies)
// ============================================================================

function dbQuery(sql) {
  try {
    if (!existsSync(DB_PATH)) return [];
    const escaped = sql.replace(/'/g, "'\\''");
    const result = execSync(
      `sqlite3 -json '${DB_PATH}' '${escaped}'`,
      { encoding: "utf-8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
    );
    if (!result.trim()) return [];
    return JSON.parse(result);
  } catch (e) {
    return [];
  }
}

// ============================================================================
// File-based storage (fallback)
// ============================================================================

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

// ============================================================================
// Session summarization
// ============================================================================

function summarizeSessionFromDb(sessionId, maxMessages = 20) {
  const messages = dbQuery(
    `SELECT m.id, json_extract(m.data, '$.role') as role, m.time_created
     FROM message m WHERE m.session_id = '${sessionId}'
     ORDER BY m.time_created DESC LIMIT ${maxMessages}`
  );

  if (messages.length === 0) return null;
  messages.reverse();

  const summary = [];
  for (const msg of messages) {
    const parts = dbQuery(
      `SELECT json_extract(data, '$.type') as type,
              substr(json_extract(data, '$.text'), 1, 1000) as text,
              json_extract(data, '$.tool') as tool,
              json_extract(data, '$.state.title') as tool_title,
              json_extract(data, '$.state.status') as tool_status
       FROM part WHERE message_id = '${msg.id}'`
    );

    if (msg.role === "user") {
      const text = parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join("\n");
      if (text.trim()) summary.push(`[USER]: ${text.substring(0, 500)}`);
    } else if (msg.role === "assistant") {
      const text = parts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join("\n");
      if (text.trim()) summary.push(`[ASSISTANT]: ${text.substring(0, 800)}`);

      for (const tp of parts) {
        if (tp.type === "tool" && tp.tool_status === "completed") {
          summary.push(`  [TOOL ${tp.tool || "unknown"}]: ${tp.tool_title || ""}`);
        }
      }
    }
  }

  return summary.length > 0 ? summary.join("\n\n") : null;
}

function summarizeSession(sessionId, maxMessages = 20) {
  const dbSummary = summarizeSessionFromDb(sessionId, maxMessages);
  if (dbSummary) return dbSummary;

  // Fallback to file storage
  const messages = getSessionMessages(sessionId);
  const summary = [];
  const relevant = messages.slice(-maxMessages);

  for (const msg of relevant) {
    const parts = getMessageParts(msg.id);
    const textParts = parts.filter((p) => p.type === "text" && p.text);
    const toolParts = parts.filter((p) => p.type === "tool");

    if (msg.role === "user") {
      const userText = textParts.map((p) => p.text).join("\n");
      if (userText.trim()) summary.push(`[USER]: ${userText.substring(0, 500)}`);
    } else if (msg.role === "assistant") {
      const assistantText = textParts.map((p) => p.text).join("\n");
      if (assistantText.trim()) summary.push(`[ASSISTANT]: ${assistantText.substring(0, 800)}`);

      for (const tp of toolParts) {
        if (tp.state?.status === "completed") {
          summary.push(`  [TOOL ${tp.tool || "unknown"}]: ${tp.state?.title || ""}`);
        }
      }
    }
  }

  return summary.join("\n\n");
}

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
// PLUGIN
// ============================================================================

/** @type {import("@opencode-ai/plugin").PluginModule} */
export default {
  id: "session-guardian",
  server: async (ctx) => {
    const projectDir = ctx.directory;

    return {
      // Intercept screenshots BEFORE execution
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
            output.args.fullPage = false;
          }
        }
      },

      // Truncate oversized tool outputs
      "tool.execute.after": async (input, output) => {
        if (output.output && output.output.length > MAX_IMAGE_SIZE_BYTES) {
          output.output =
            `[SESSION-GUARDIAN] Output from ${input.tool} was truncated (exceeded ${(MAX_IMAGE_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB). ` +
            `Use smaller dimensions or avoid fullPage screenshots.\n\n` +
            `Original output (first 2000 chars):\n${output.output.substring(0, 2000)}`;
        }
      },

      // Filter oversized base64 images from message history
      // Claude API limits: 8000px single image, 2000px when multiple images
      // We keep max MAX_IMAGES_IN_CONTEXT images (the most recent ones)
      "experimental.chat.messages.transform": async (_input, output) => {
        const MAX_IMAGES_IN_CONTEXT = 3;

        // First pass: collect all image locations
        const allImages = [];
        for (let mi = 0; mi < output.messages.length; mi++) {
          const msg = output.messages[mi];
          for (let pi = 0; pi < msg.parts.length; pi++) {
            const part = msg.parts[pi];
            // Direct image file parts
            if (part.type === "file" && part.url && part.url.startsWith("data:image")) {
              allImages.push({ mi, pi, size: part.url.length, type: "file" });
            }
            // Tool outputs with image attachments
            if (part.type === "tool" && part.state?.status === "completed" && part.state?.attachments) {
              for (const att of part.state.attachments) {
                if (att.url && att.url.startsWith("data:image")) {
                  allImages.push({ mi, pi, size: att.url.length, type: "tool-attachment" });
                }
              }
            }
            // Tool outputs that ARE base64 images
            if (part.type === "tool" && part.state?.status === "completed" && part.state?.output) {
              if (part.state.output.startsWith("data:image") || part.state.output.length > MAX_IMAGE_SIZE_BYTES) {
                allImages.push({ mi, pi, size: part.state.output.length, type: "tool-output" });
              }
            }
          }
        }

        // If too many images, remove all except the last MAX_IMAGES_IN_CONTEXT
        const imagesToRemove = new Set();
        if (allImages.length > MAX_IMAGES_IN_CONTEXT) {
          const toRemove = allImages.slice(0, allImages.length - MAX_IMAGES_IN_CONTEXT);
          for (const img of toRemove) {
            imagesToRemove.add(`${img.mi}-${img.pi}`);
          }
        }

        // Also always remove any single image >4MB
        for (const img of allImages) {
          if (img.size > MAX_IMAGE_SIZE_BYTES) {
            imagesToRemove.add(`${img.mi}-${img.pi}`);
          }
        }

        // Second pass: apply removals
        if (imagesToRemove.size > 0) {
          for (let mi = 0; mi < output.messages.length; mi++) {
            const msg = output.messages[mi];
            const newParts = [];
            for (let pi = 0; pi < msg.parts.length; pi++) {
              const part = msg.parts[pi];
              const key = `${mi}-${pi}`;

              if (imagesToRemove.has(key)) {
                if (part.type === "file") {
                  newParts.push({
                    ...part,
                    type: "text",
                    text: `[SESSION-GUARDIAN] Image removed from context to prevent crash (${allImages.length} images total, keeping last ${MAX_IMAGES_IN_CONTEXT}). File: ${part.filename || "screenshot"}`,
                    url: undefined,
                  });
                } else if (part.type === "tool") {
                  if (part.state?.output) {
                    part.state.output = `[SESSION-GUARDIAN] Image output removed (${allImages.length} images in session, limit ${MAX_IMAGES_IN_CONTEXT}). Tool: ${part.tool}. Summary: ${part.state.title || "N/A"}`;
                  }
                  if (part.state?.attachments) {
                    part.state.attachments = [];
                  }
                  newParts.push(part);
                } else {
                  newParts.push(part);
                }
              } else {
                newParts.push(part);
              }
            }
            msg.parts = newParts;
          }
        }
      },

      // Improve session compaction
      "experimental.session.compacting": async (_input, output) => {
        output.context.push(
          `IMPORTANT: When summarizing, focus on:\n` +
            `1. What the user was working on (project, files, features)\n` +
            `2. What changes were made (file modifications, code written)\n` +
            `3. Current state of work (done vs pending)\n` +
            `4. Decisions or preferences the user expressed\n` +
            `5. Directory and project context\n\n` +
            `Make the summary detailed enough to continue where this session left off.`
        );
      },

      // Custom tools
      tool: {
        session_list: tool({
          description:
            "List recent sessions for the current project directory. Use this to find previous sessions when context was lost.",
          args: {
            limit: tool.schema.number().optional().describe("Max sessions to return (default 10)"),
            directory: tool.schema.string().optional().describe("Filter by project directory (defaults to current)"),
          },
          async execute(args) {
            const dir = args.directory || projectDir;
            const limit = args.limit || 10;

            const escapedDir = dir.replace(/'/g, "''");
            let sessions = dbQuery(
              `SELECT id, slug, title, directory, time_created, time_updated,
                      summary_additions, summary_deletions, summary_files
               FROM session WHERE directory = '${escapedDir}'
               ORDER BY time_updated DESC LIMIT ${limit}`
            ).map((r) => ({
              id: r.id, slug: r.slug, title: r.title, directory: r.directory,
              time: { created: r.time_created, updated: r.time_updated },
              summary: { additions: r.summary_additions, deletions: r.summary_deletions, files: r.summary_files },
            }));

            if (sessions.length === 0) {
              sessions = getSessionsFromStorage(dir).slice(0, limit);
            }

            if (sessions.length === 0) return `No sessions found for: ${dir}`;

            return `Sessions found (${sessions.length}):\n\n${sessions.map((s) => formatSessionInfo(s)).join("\n\n---\n\n")}`;
          },
        }),

        session_recover: tool({
          description:
            "Recover context from a previous session by ID. Returns summary of messages, tool calls, and file changes.",
          args: {
            session_id: tool.schema.string().describe("The session ID to recover"),
            max_messages: tool.schema.number().optional().describe("Max messages in summary (default 30)"),
          },
          async execute(args) {
            const sessionId = args.session_id;
            const maxMessages = args.max_messages || 30;

            const rows = dbQuery(`SELECT id, slug, title, directory, time_created, time_updated, summary_additions, summary_deletions, summary_files FROM session WHERE id = '${sessionId}'`);
            const sessionInfo = rows[0]
              ? { id: rows[0].id, slug: rows[0].slug, title: rows[0].title, directory: rows[0].directory, time: { created: rows[0].time_created, updated: rows[0].time_updated }, summary: { additions: rows[0].summary_additions, deletions: rows[0].summary_deletions, files: rows[0].summary_files } }
              : null;

            const conversationSummary = summarizeSession(sessionId, maxMessages);

            let diffs = "";
            try {
              const diffPath = join(STORAGE_PATH, "session_diff", `${sessionId}.json`);
              if (existsSync(diffPath)) {
                const diffData = JSON.parse(readFileSync(diffPath, "utf-8"));
                if (Array.isArray(diffData) && diffData.length > 0) {
                  diffs = diffData.map((d) => `File: ${d.file} (+${d.additions || 0} -${d.deletions || 0})`).join("\n");
                }
              }
            } catch {}

            let result = `=== RECOVERED CONTEXT FROM PREVIOUS SESSION ===\n\n`;
            if (sessionInfo) result += `Session info:\n${formatSessionInfo(sessionInfo)}\n\n`;
            if (diffs) result += `Files modified:\n${diffs}\n\n`;
            result += conversationSummary
              ? `Conversation (last ${maxMessages} messages):\n\n${conversationSummary}`
              : `No messages found for this session.`;
            return result;
          },
        }),

        session_search: tool({
          description: "Search across all sessions for specific text in messages.",
          args: {
            query: tool.schema.string().describe("Text to search for"),
            limit: tool.schema.number().optional().describe("Max results (default 5)"),
          },
          async execute(args) {
            const limit = args.limit || 5;
            const escapedQuery = args.query.replace(/'/g, "''");
            const rows = dbQuery(
              `SELECT DISTINCT p.session_id, s.title, s.directory, s.time_updated,
                      substr(json_extract(p.data, '$.text'), 1, 200) as snippet
               FROM part p JOIN session s ON p.session_id = s.id
               WHERE json_extract(p.data, '$.type') = 'text'
                 AND json_extract(p.data, '$.text') LIKE '%${escapedQuery}%'
               ORDER BY s.time_updated DESC LIMIT ${limit}`
            );

            if (rows.length === 0) return `No sessions found containing: "${args.query}"`;

            return `Results (${rows.length}):\n\n${rows.map((r) => `Session: ${r.session_id}\nTitle: ${r.title || "Untitled"}\nDirectory: ${r.directory || "N/A"}\nUpdated: ${r.time_updated ? new Date(r.time_updated).toLocaleString() : "unknown"}\nSnippet: ${r.snippet || ""}`).join("\n\n---\n\n")}`;
          },
        }),

        session_recover_last: tool({
          description:
            "Automatically recover context from the most recent broken/crashed session. Use FIRST after a crash.",
          args: {},
          async execute() {
            const escapedDir = projectDir.replace(/'/g, "''");
            const rows = dbQuery(
              `SELECT id, title, slug, directory, time_updated
               FROM session WHERE directory = '${escapedDir}'
               ORDER BY time_updated DESC LIMIT 3`
            );

            if (rows.length < 2) {
              const sessions = getSessionsFromStorage(projectDir);
              if (sessions.length < 2) return "No previous sessions found to recover.";
              const prev = sessions[1];
              return `=== AUTOMATICALLY RECOVERED CONTEXT ===\n\nPrevious session: ${prev.title || prev.slug}\nDirectory: ${prev.directory}\n\n${summarizeSession(prev.id, 30)}`;
            }

            const prevSession = rows[1];
            const summary = summarizeSession(prevSession.id, 30);

            let diffs = "";
            try {
              const diffPath = join(STORAGE_PATH, "session_diff", `${prevSession.id}.json`);
              if (existsSync(diffPath)) {
                const diffData = JSON.parse(readFileSync(diffPath, "utf-8"));
                if (Array.isArray(diffData)) {
                  diffs = diffData.map((d) => `  - ${d.file} (+${d.additions || 0} -${d.deletions || 0})`).join("\n");
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
          },
        }),
      },
    };
  },
};
