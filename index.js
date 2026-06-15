require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
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

// thread_ts → { userId, originalText, images, question }
const pendingFollowups = new Map();

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function fetchImages(files) {
  const images = [];
  for (const file of (files || [])) {
    if (!IMAGE_TYPES.includes(file.mimetype)) continue;
    try {
      const resp = await axios.get(file.url_private, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        responseType: 'arraybuffer',
      });
      images.push({ base64: Buffer.from(resp.data).toString('base64'), mediaType: file.mimetype });
    } catch (_) {}
  }
  return images;
}

function buildContent(text, images) {
  if (!images || images.length === 0) return text;
  return [
    ...images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    })),
    { type: 'text', text },
  ];
}

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

async function handleTicket({ parsed, requesterName, threadTs, channel, say, client }) {
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

  // Handle follow-up replies to clarifying questions
  if (isThreadReply) {
    const pending = pendingFollowups.get(message.thread_ts);
    if (!pending || pending.userId !== message.user) return;
    pendingFollowups.delete(message.thread_ts);

    const requesterName = await resolveDisplayName(client, message.user);
    const followupImages = await fetchImages(message.files);
    const followupText = message.text || '';

    let parsed;
    try {
      parsed = await callClaude([
        { role: 'user', content: buildContent(`New message from ${requesterName}:\n\n${pending.originalText}`, pending.images) },
        { role: 'assistant', content: JSON.stringify({ type: 'needs_info', clarifying_question: pending.question }) },
        { role: 'user', content: buildContent(`Additional info from ${requesterName}:\n\n${followupText}`, followupImages) },
      ]);
    } catch (err) {
      console.error('Claude error (followup):', err.message);
      return;
    }

    if (parsed.type === 'ticket') {
      await handleTicket({ parsed, requesterName, threadTs: message.thread_ts, channel: message.channel, say, client });
    } else if (parsed.type === 'self-serve') {
      await say({ text: parsed.direct_response, thread_ts: message.thread_ts });
    }
    return;
  }

  // Top-level message
  let userText = message.text || '';
  const images = await fetchImages(message.files);

  // Mention non-image attachments as text note
  const nonImageFiles = (message.files || []).filter(f => !IMAGE_TYPES.includes(f.mimetype));
  if (nonImageFiles.length > 0) {
    const names = nonImageFiles.map(f => f.name || f.title || 'file').join(', ');
    const note = `[User attached file(s): ${names} — visible in Slack thread]`;
    userText = userText ? `${userText}\n\n${note}` : note;
  }

  if (!userText.trim() && images.length === 0) return;

  const requesterName = await resolveDisplayName(client, message.user);

  let parsed;
  try {
    parsed = await callClaude([
      { role: 'user', content: buildContent(`New message from ${requesterName}:\n\n${userText}`, images) },
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
      images,
      question: parsed.clarifying_question,
    });
    await say({ text: parsed.clarifying_question, thread_ts: message.ts });
    return;
  }

  if (parsed.type === 'ticket') {
    await handleTicket({ parsed, requesterName, threadTs: message.ts, channel: message.channel, say, client });
  }
});

(async () => {
  await app.start();
  console.log('✓ IT Support bot running (socket mode)');
})();
