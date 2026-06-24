require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const SYSTEM_PROMPT = require('./system-prompt');

// ─── Crash protection ────────────────────────────────────────────────────────
// Catch anything that escapes Bolt's handler wrapping. Log and keep running.
process.on('uncaughtException', (err) => {
  log('FATAL', `Uncaught exception: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log('FATAL', `Unhandled rejection: ${reason}`);
});

// ─── App setup ───────────────────────────────────────────────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CHANNEL_ID = 'C064SFAJ9AT';
const CLICKUP_LIST_ID = '901818266435';
const WORKSPACE_URL = 'https://lal-rb96774.slack.com';

const CLICKUP_ASSIGNEES = {
  hussein: 89443335,
  rami: 95530435,
  gabriel: 101647025,
  patrick: 107433242,
};

const SLACK_USERS = {
  hussein: 'U02K90YB05P',
  rami: 'U08LMCU0SE8',
  gabriel: 'U09PX4VBTKR',
  patrick: 'U02JPQPHBNJ',
};

// ─── In-memory state ─────────────────────────────────────────────────────────
// Entries include createdAt for TTL cleanup.
const pendingFollowups = new Map(); // thread_ts → { userId, originalText, fileNote, files, question, createdAt }
const ticketThreads = new Map();   // thread_ts → { taskId, createdAt }

// Evict entries older than 7 days — runs every hour
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of pendingFollowups) if (v.createdAt < cutoff) pendingFollowups.delete(k);
  for (const [k, v] of ticketThreads) if (v.createdAt < cutoff) ticketThreads.delete(k);
}, 60 * 60 * 1000).unref();

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function resolveDisplayName(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    return info.user.real_name || info.user.profile.display_name || info.user.name || `<@${userId}>`;
  } catch (_) {
    return `<@${userId}>`;
  }
}

async function callClaude(messages) {
  // 30-second hard timeout — prevents handler from hanging indefinitely
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Claude API timeout after 30s')), 30000);
  });
  try {
    const aiResponse = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      }),
      timeout,
    ]);
    clearTimeout(timer);
    const raw = aiResponse.content[0].text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    return JSON.parse(raw);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function createClickUpTask({ title, description, assignee, priority, category }) {
  const priorityMap = { urgent: 1, normal: 3, low: 4 };
  const response = await axios.post(
    `https://api.clickup.com/api/v2/list/${CLICKUP_LIST_ID}/task`,
    {
      name: title,
      description,
      assignees: [CLICKUP_ASSIGNEES[assignee] || CLICKUP_ASSIGNEES.patrick],
      priority: priorityMap[priority] || 3,
      tags: ['it-support', category].filter(Boolean),
    },
    {
      headers: {
        Authorization: process.env.CLICKUP_API_TOKEN,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
}

async function attachFilesToTask(taskId, files) {
  for (const file of (files || [])) {
    try {
      const resp = await axios.get(file.url_private, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        responseType: 'arraybuffer',
        timeout: 15000,
      });
      const form = new FormData();
      form.append('attachment', Buffer.from(resp.data), {
        filename: file.name || file.title || 'attachment',
        contentType: file.mimetype || 'application/octet-stream',
      });
      await axios.post(
        `https://api.clickup.com/api/v2/task/${taskId}/attachment`,
        form,
        {
          headers: {
            Authorization: process.env.CLICKUP_API_TOKEN,
            ...form.getHeaders(),
          },
          timeout: 15000,
        }
      );
      log('INFO', `Attached file "${file.name}" to task ${taskId}`);
    } catch (err) {
      log('ERROR', `ClickUp attachment error (${file.name}): ${err.message}`);
    }
  }
}

async function addClickUpComment(taskId, text) {
  try {
    await axios.post(
      `https://api.clickup.com/api/v2/task/${taskId}/comment`,
      { comment_text: text },
      {
        headers: {
          Authorization: process.env.CLICKUP_API_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    log('INFO', `Comment added to task ${taskId}`);
  } catch (err) {
    log('ERROR', `ClickUp comment error: ${err.message}`);
  }
}

async function handleTicket({ parsed, requesterName, threadTs, channel, say, client, files }) {
  const threadUrl = `${WORKSPACE_URL}/archives/${CHANNEL_ID}/p${threadTs.replace('.', '')}`;
  let task;
  try {
    task = await createClickUpTask({
      title: parsed.ticket_title,
      description: `${parsed.ticket_description}\n\n---\nRequester: ${requesterName}\nSource: ${threadUrl}`,
      assignee: parsed.assignee,
      priority: parsed.priority,
      category: parsed.category,
    });
    log('INFO', `ClickUp task created: ${task.url} → assignee=${parsed.assignee}`);
  } catch (err) {
    log('ERROR', `ClickUp task creation failed: ${err.message}`);
    await say({
      text: `⚠️ Couldn't create the ClickUp task (API error). <@${SLACK_USERS[parsed.assignee] || SLACK_USERS.patrick}> — please pick this up manually.`,
      thread_ts: threadTs,
    });
    return;
  }

  await attachFilesToTask(task.id, files);
  ticketThreads.set(threadTs, { taskId: task.id, createdAt: Date.now() });

  await client.reactions.add({ channel, timestamp: threadTs, name: 'clipboard' });
  await say({
    text: `:clipboard: Ticket logged → ${task.url}\nAssigned to <@${SLACK_USERS[parsed.assignee] || SLACK_USERS.patrick}>`,
    thread_ts: threadTs,
  });
}

// ─── Slack event handlers ─────────────────────────────────────────────────────
app.error(async (error) => {
  log('ERROR', `Slack app error: ${error.message || error}`);
});

app.message(async ({ message, say, client }) => {
  if (message.subtype || message.bot_id) return;
  if (message.channel !== CHANNEL_ID) return;

  log('INFO', `Message received from user=${message.user} thread=${message.thread_ts || 'none'}`);

  const isThreadReply = message.thread_ts && message.thread_ts !== message.ts;

  if (isThreadReply) {
    // Handle reply to pending clarifying question
    const pending = pendingFollowups.get(message.thread_ts);
    if (pending && pending.userId === message.user) {
      pendingFollowups.delete(message.thread_ts);
      log('INFO', 'Processing follow-up reply to clarifying question');

      const requesterName = await resolveDisplayName(client, message.user);
      const followupText = message.text || '';
      const allFiles = [...(pending.files || []), ...(message.files || [])];
      const followupFileNote = message.files && message.files.length > 0
        ? `\n\n[User attached ${message.files.length} file(s) — being added to ClickUp task as attachments]`
        : '';

      let parsed;
      try {
        parsed = await callClaude([
          { role: 'user', content: `New message from ${requesterName}:\n\n${pending.originalText}${pending.fileNote}` },
          { role: 'assistant', content: JSON.stringify({ type: 'needs_info', clarifying_question: pending.question }) },
          { role: 'user', content: `Additional info from ${requesterName}:\n\n${followupText}${followupFileNote}` },
        ]);
        log('INFO', `Claude response (followup): type=${parsed.type} assignee=${parsed.assignee || 'n/a'}`);
      } catch (err) {
        log('ERROR', `Claude error (followup): ${err.message}`);
        await say({
          text: `⚠️ Something went wrong processing your reply. <@${SLACK_USERS.patrick}> — please handle this manually.`,
          thread_ts: message.thread_ts,
        });
        return;
      }

      if (parsed.type === 'ticket') {
        await handleTicket({ parsed, requesterName, threadTs: message.thread_ts, channel: message.channel, say, client, files: allFiles });
      } else if (parsed.type === 'self-serve') {
        await say({ text: parsed.direct_response, thread_ts: message.thread_ts });
      }
      return;
    }

    // Sync non-bot thread reply to ClickUp as comment
    const entry = ticketThreads.get(message.thread_ts);
    if (entry) {
      const commenterName = await resolveDisplayName(client, message.user);
      const replyText = message.text || '';
      if (replyText.trim()) {
        await addClickUpComment(entry.taskId, `${commenterName}: ${replyText}`);
      }
      if (message.files && message.files.length > 0) {
        await attachFilesToTask(entry.taskId, message.files);
      }
    }
    return;
  }

  // Top-level message
  let userText = message.text || '';
  const files = message.files || [];
  const fileNote = files.length > 0
    ? `\n\n[User attached ${files.length} file(s) — being added to ClickUp task as attachments]`
    : '';

  if (!userText.trim() && files.length === 0) return;

  const requesterName = await resolveDisplayName(client, message.user);

  let parsed;
  try {
    parsed = await callClaude([
      { role: 'user', content: `New message from ${requesterName}:\n\n${userText}${fileNote}` },
    ]);
    log('INFO', `Claude response: type=${parsed.type} assignee=${parsed.assignee || 'n/a'} priority=${parsed.priority || 'n/a'}`);
  } catch (err) {
    log('ERROR', `Claude error: ${err.message}`);
    await say({
      text: `⚠️ Something went wrong on my end. <@${SLACK_USERS.patrick}> — please check the bot logs or handle this manually.`,
      thread_ts: message.ts,
    });
    return;
  }

  if (parsed.type === 'ignore') {
    log('INFO', 'Message classified as ignore — no action');
    return;
  }

  if (parsed.type === 'self-serve') {
    await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'white_check_mark' });
    await say({ text: parsed.direct_response, thread_ts: message.ts });
    return;
  }

  if (parsed.type === 'needs_info') {
    pendingFollowups.set(message.ts, {
      userId: message.user,
      originalText: userText,
      fileNote,
      files,
      question: parsed.clarifying_question,
      createdAt: Date.now(),
    });
    await say({ text: parsed.clarifying_question, thread_ts: message.ts });
    return;
  }

  if (parsed.type === 'ticket') {
    await handleTicket({ parsed, requesterName, threadTs: message.ts, channel: message.channel, say, client, files });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  // Verify required env vars are set before connecting
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'ANTHROPIC_API_KEY', 'CLICKUP_API_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    log('FATAL', `Missing env vars: ${missing.join(', ')} — check /opt/cc-slack-support/.env`);
    process.exit(1);
  }

  await app.start();
  log('INFO', '✓ IT Support bot running (socket mode)');
})();
