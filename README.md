# Claude Code → Telegram Approver

Approve or deny Claude Code permission prompts from Telegram, anywhere in the world. The service runs on Render; your laptop only runs Claude Code.

## How it works

1. Claude Code hits a permission prompt (like the WebFetch one in your screenshot).
2. A `PermissionRequest` HTTP hook sends the request to this service on Render.
3. The service messages your Telegram with ✅ Yes / ❌ No / ✍️ Type instruction buttons.
4. Your tap (or typed instruction) resolves the request, and Claude Code proceeds, stops, or reads your instruction and adjusts.

## Step 1  Telegram bot (5 minutes)

1. Message **@BotFather** on Telegram → `/newbot` → follow prompts → copy the **bot token**.
2. Send your new bot any message (e.g. "hi").
3. Open in a browser: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and copy the numeric `"id"` under `"from"`  that's your **chat ID**.

## Step 2  Deploy to Render

1. Push this folder to a GitHub repo.
2. Render → New → **Web Service** → connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Add environment variables:
   - `TELEGRAM_BOT_TOKEN`  from BotFather
   - `TELEGRAM_CHAT_ID`  your numeric id
   - `HOOK_SECRET`  any long random string (generate one: `openssl rand -hex 24`)
   - `PUBLIC_URL`  your Render URL, e.g. `https://cc-approver.onrender.com`
4. After deploy, visit `https://<your-app>.onrender.com/setup` once  this registers the Telegram webhook. You should see `{"ok":true,...}`.

⚠️ **Use a paid Render instance (or keep-alive pings).** Free-tier Render sleeps after inactivity, and a sleeping service means Claude Code's hook call fails and falls back to the normal terminal prompt.

## Step 3  Point Claude Code at it

Edit `~/.claude/settings.json` on your laptop (create it if missing):

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "https://<your-app>.onrender.com/hooks/permission",
            "timeout": 300,
            "headers": { "X-Hook-Secret": "your-HOOK_SECRET-value" }
          }
        ]
      }
    ]
  }
}
```

Restart Claude Code (or run `/hooks` to confirm it's registered), then trigger something that needs permission. Your phone should buzz.

## Notes & gotchas

- **Timeouts:** the service waits `DECISION_TIMEOUT_MS` (default 4 min) for your tap, then safely denies. Keep the hook `timeout` in settings.json above that (300s covers 4 min).
- **Fail-safe behavior:** if Render is down or unreachable, HTTP hook errors are non-blocking  Claude Code falls back to the normal terminal prompt. You lose remote approval, not safety.
- **Typed instructions:** free-text replies are delivered as a deny-with-reason, so Claude reads your instruction as feedback and adjusts course. This is instruction *steering*, not full remote prompting  for injecting brand-new prompts into the session, the tmux relay or Agent SDK route from earlier applies.
- **Security:** only your chat ID can act on requests, and the hook endpoint requires the shared secret header. Still, treat the bot token and secret like passwords.
- **Verify the response schema:** Claude Code's hook JSON schema evolves. If decisions aren't taking effect, check the current `PermissionRequest` output format at https://code.claude.com/docs/en/hooks and adjust the two `res.json(...)` blocks in `index.js`.

## Changes in this fork

Based on [jimokonma/cc-telegram-approver](https://github.com/jimokonma/cc-telegram-approver), with these fixes:

- **Forged-update protection:** `/setup` now registers a Telegram `secret_token`, and `/telegram/webhook` rejects any request without it. Before this, anyone who found your URL could POST fake button taps. **If you already ran `/setup` on the old version, visit `/setup` again.**
- **Messages no longer fail on special characters:** switched from Markdown to escaped HTML. Commands containing `_`, `*`, backticks or `<>` used to break the Telegram message, which left Claude Code waiting 4 minutes and then denying.
- **Falls back right away when Telegram is down:** if the message can't be sent, the hook returns no decision and you get the normal terminal prompt immediately.
