/**
 * Claude Code -> Telegram Permission Approver
 * ---------------------------------------------
 * A small web service (host on Render) that receives Claude Code
 * PermissionRequest HTTP hooks, forwards them to your Telegram,
 * and returns your decision (Yes / No / custom instruction).
 *
 * Flow:
 *   Claude Code (laptop) --HTTP hook--> POST /hooks/permission
 *   Service --sendMessage(inline keyboard)--> Your Telegram
 *   You tap Yes/No (or type a reply) --Telegram webhook--> POST /telegram/webhook
 *   Service resolves the pending request --> responds to Claude Code
 *
 * Env vars required (set in Render dashboard):
 *   TELEGRAM_BOT_TOKEN   - from @BotFather
 *   TELEGRAM_CHAT_ID     - your own chat id (numeric)
 *   HOOK_SECRET          - any random string; Claude Code sends it as a header
 *   PUBLIC_URL           - your Render URL, e.g. https://cc-approver.onrender.com
 *
 * Optional:
 *   DECISION_TIMEOUT_MS  - how long to wait for your tap (default 240000 = 4 min)
 */

const express = require("express");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HOOK_SECRET = process.env.HOOK_SECRET;
const PUBLIC_URL = process.env.PUBLIC_URL;
const DECISION_TIMEOUT_MS = parseInt(process.env.DECISION_TIMEOUT_MS || "240000", 10);

if (!BOT_TOKEN || !CHAT_ID || !HOOK_SECRET) {
  console.error("Missing env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, HOOK_SECRET are required.");
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * Pending permission requests waiting on a human decision.
 * key: short request id -> { resolve, meta, telegramMessageId }
 */
const pending = new Map();

/** Track which request a free-text reply should attach to (last one asked). */
let awaitingTextFor = null;

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function tg(method, payload) {
  try {
    const res = await fetch(`${TG}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) console.error(`Telegram ${method} failed:`, data);
    return data;
  } catch (err) {
    console.error(`Telegram ${method} error:`, err.message);
    return { ok: false };
  }
}

// Telegram sends this back in the X-Telegram-Bot-Api-Secret-Token header on
// every webhook call, proving the update really came from Telegram.
// Derived from HOOK_SECRET so no extra env var is needed (allowed chars: A-Z a-z 0-9 _ -).
const WEBHOOK_SECRET = require("crypto")
  .createHash("sha256")
  .update("telegram-webhook:" + HOOK_SECRET)
  .digest("hex");

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function formatToolInput(toolName, toolInput) {
  try {
    if (toolName === "Bash" && toolInput.command) return toolInput.command;
    if (toolInput.url) return toolInput.url;
    if (toolInput.file_path) return toolInput.file_path;
    return JSON.stringify(toolInput);
  } catch {
    return String(toolInput);
  }
}

// ---------------------------------------------------------------------------
// Hook endpoint: Claude Code calls this and WAITS for the response
// ---------------------------------------------------------------------------

app.post("/hooks/permission", async (req, res) => {
  // Simple shared-secret auth
  if (req.headers["x-hook-secret"] !== HOOK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const input = req.body || {};
  const toolName = input.tool_name || "unknown tool";
  const toolInput = input.tool_input || {};
  const requestId = Math.random().toString(36).slice(2, 10);

  const detail = escapeHtml(truncate(formatToolInput(toolName, toolInput), 800));
  const cwd = input.cwd ? `\n📁 ${escapeHtml(truncate(input.cwd, 120))}` : "";

  // HTML (with escaping) instead of Markdown: commands often contain _ * ` which
  // break Telegram's Markdown parser and make sendMessage fail.
  const text =
    `🔐 <b>Claude Code wants permission</b>\n\n` +
    `<b>Tool:</b> ${escapeHtml(toolName)}${cwd}\n` +
    `<b>Details:</b>\n<pre>${detail}</pre>\n` +
    `<i>Tap a button, or reply with text to send Claude an instruction instead.</i>`;

  const sent = await tg("sendMessage", {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Yes", callback_data: `allow:${requestId}` },
          { text: "❌ No", callback_data: `deny:${requestId}` },
        ],
        [{ text: "✍️ Type instruction instead", callback_data: `text:${requestId}` }],
      ],
    },
  });

  const telegramMessageId = sent.result?.message_id;

  // If Telegram couldn't be reached, return no decision so Claude Code falls
  // back to the normal terminal prompt instead of hanging until timeout.
  if (!telegramMessageId) {
    return res.json({});
  }

  // Wait for the human (or time out -> deny safely)
  const decision = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ behavior: "deny", message: "No response from owner within timeout. Ask again or wait." });
      tg("editMessageText", {
        chat_id: CHAT_ID,
        message_id: telegramMessageId,
        text: `⏰ Request timed out (denied): ${toolName}`,
      });
    }, DECISION_TIMEOUT_MS);

    pending.set(requestId, {
      resolve: (d) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(d);
      },
      toolName,
      toolInput,
      telegramMessageId,
    });
  });

  // Respond in Claude Code PermissionRequest hook format
  if (decision.behavior === "allow") {
    return res.json({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: toolInput },
      },
    });
  }

  return res.json({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: decision.message || "Denied by owner via Telegram.",
        interrupt: false,
      },
    },
  });
});

// ---------------------------------------------------------------------------
// Telegram webhook: receives your button taps and text replies
// ---------------------------------------------------------------------------

app.post("/telegram/webhook", async (req, res) => {
  // Reject forged updates that didn't come from Telegram
  if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack immediately

  const update = req.body || {};

  // Button tap
  if (update.callback_query) {
    const cq = update.callback_query;
    if (String(cq.from.id) !== String(CHAT_ID)) return; // only you

    const [action, requestId] = (cq.data || "").split(":");
    const entry = pending.get(requestId);

    await tg("answerCallbackQuery", { callback_query_id: cq.id });

    if (!entry) {
      await tg("sendMessage", { chat_id: CHAT_ID, text: "⚠️ That request already expired." });
      return;
    }

    if (action === "allow") {
      entry.resolve({ behavior: "allow" });
      await tg("editMessageText", {
        chat_id: CHAT_ID,
        message_id: entry.telegramMessageId,
        text: `✅ Approved: ${entry.toolName}`,
      });
    } else if (action === "deny") {
      entry.resolve({ behavior: "deny" });
      await tg("editMessageText", {
        chat_id: CHAT_ID,
        message_id: entry.telegramMessageId,
        text: `❌ Denied: ${entry.toolName}`,
      });
    } else if (action === "text") {
      awaitingTextFor = requestId;
      await tg("sendMessage", {
        chat_id: CHAT_ID,
        text: "✍️ Type your instruction. It will be sent to Claude as the reason for denying this action, so Claude will read it and adjust.",
      });
    }
    return;
  }

  // Free-text reply
  if (update.message && update.message.text) {
    const msg = update.message;
    if (String(msg.from.id) !== String(CHAT_ID)) return;

    if (awaitingTextFor && pending.has(awaitingTextFor)) {
      const entry = pending.get(awaitingTextFor);
      awaitingTextFor = null;
      entry.resolve({
        behavior: "deny",
        message: `Owner instruction (via Telegram): ${msg.text}`,
      });
      await tg("editMessageText", {
        chat_id: CHAT_ID,
        message_id: entry.telegramMessageId,
        text: `✍️ Instruction sent for: ${entry.toolName}`,
      });
      await tg("sendMessage", { chat_id: CHAT_ID, text: "Sent to Claude ✅" });
    } else {
      await tg("sendMessage", {
        chat_id: CHAT_ID,
        text: "No pending permission request right now. Instructions can only be attached to an active request.",
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Setup + health
// ---------------------------------------------------------------------------

app.get("/", (_req, res) => res.send("cc-telegram-approver is running"));

// Visit once after deploy to register the Telegram webhook
app.get("/setup", async (_req, res) => {
  if (!PUBLIC_URL) return res.status(400).send("Set PUBLIC_URL env var first.");
  const r = await tg("setWebhook", {
    url: `${PUBLIC_URL}/telegram/webhook`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
  res.json(r);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
