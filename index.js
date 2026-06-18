require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const SYSTEM_PROMPT = require('./system-prompt');

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

// thread_ts → { userId, originalText, fileNote, files, question }
const pendingFollowups = new Map();
// thread_ts → clickup task id
const ticketThreads = new Map();

async function resolveDisplayName(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    return info.user.real_name || info.user.profile.display_name || info.user.name || `<@${userId}>`;
  } catch (_) {
    return `<@${userId}>`;
  }
}

async function callClaude(messages) {
  const aiResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });
  const raw = aiResponse.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  return JSON.parse(raw);
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
        }
      );
    } catch (err) {
      console.error('ClickUp attachment error:', err.message);
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
      }
    );
  } catch (err) {
    console.error('ClickUp comment error:', err.message);
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
  } catch (err) {
    console.error('ClickUp error:', err.message);
    await say({
      text: `⚠️ Couldn't create the ClickUp task (API error). <@${SLACK_USERS[parsed.assignee] || SLACK_USERS.patrick}> — please pick this up manually.`,
      thread_ts: threadTs,
    });
    return;
  }

  await attachFilesToTask(task.id, files);
  ticketThreads.set(threadTs, task.id);

  await client.reactions.add({ channel, timestamp: threadTs, name: 'clipboard' });
  await say({
    text: `:clipboard: Ticket logged → ${task.url}\nAssigned to <@${SLACK_USERS[parsed.assignee] || SLACK_USERS.patrick}>`,
    thread_ts: threadTs,
  });
}

app.error(async (error) => {
  console.error('Slack app error:', error);
});

app.message(async ({ message, say, client }) => {
  if (message.subtype || message.bot_id) return;
  if (message.channel !== CHANNEL_ID) return;

  const isThreadReply = message.thread_ts && message.thread_ts !== message.ts;

  if (isThreadReply) {
    // Handle reply to a pending clarifying question
    const pending = pendingFollowups.get(message.thread_ts);
    if (pending && pending.userId === message.user) {
      pendingFollowups.delete(message.thread_ts);

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
      } catch (err) {
        console.error('Claude error (followup):', err.message);
        return;
      }

      if (parsed.type === 'ticket') {
        await handleTicket({ parsed, requesterName, threadTs: message.thread_ts, channel: message.channel, say, client, files: allFiles });
      } else if (parsed.type === 'self-serve') {
        await say({ text: parsed.direct_response, thread_ts: message.thread_ts });
      }
      return;
    }

    // Sync any non-bot thread reply to ClickUp as a comment
    const taskId = ticketThreads.get(message.thread_ts);
    if (taskId) {
      const commenterName = await resolveDisplayName(client, message.user);
      const replyText = message.text || '';

      if (replyText.trim()) {
        await addClickUpComment(taskId, `${commenterName}: ${replyText}`);
      }
      if (message.files && message.files.length > 0) {
        await attachFilesToTask(taskId, message.files);
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
  } catch (err) {
    console.error('Claude error:', err.message);
    return;
  }

  if (parsed.type === 'ignore') return;

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
    });
    await say({ text: parsed.clarifying_question, thread_ts: message.ts });
    return;
  }

  if (parsed.type === 'ticket') {
    await handleTicket({ parsed, requesterName, threadTs: message.ts, channel: message.channel, say, client, files });
  }
});

(async () => {
  await app.start();
  console.log('✓ IT Support bot running (socket mode)');
})();
