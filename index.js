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

app.error(async (error) => {
  console.error('Slack app error:', error);
});

app.message(async ({ message, say, client }) => {
  // Skip all message subtypes (edits, unfurls, bot messages, etc.)
  if (message.subtype || message.bot_id) return;
  // Skip thread replies
  if (message.thread_ts && message.thread_ts !== message.ts) return;
  // Only handle #it-support
  if (message.channel !== CHANNEL_ID) return;

  // Build the text Claude will see
  let userText = message.text || '';

  if (message.files && message.files.length > 0) {
    const names = message.files.map(f => f.name || f.title || 'file').join(', ');
    const fileNote = `[User attached: ${names} — image/file visible in Slack thread, not reproduced here]`;
    userText = userText ? `${userText}\n\n${fileNote}` : fileNote;
  }

  if (!userText.trim()) return;

  const threadUrl = `${WORKSPACE_URL}/archives/${CHANNEL_ID}/p${message.ts.replace('.', '')}`;

  let parsed;
  try {
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `New message from <@${message.user}>:\n\n${userText}`,
        },
      ],
    });

    const raw = aiResponse.content[0].text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('Claude error:', err.message);
    return;
  }

  if (parsed.type === 'ignore') return;

  if (parsed.type === 'self-serve') {
    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: 'white_check_mark',
    });
    await say({ text: parsed.direct_response, thread_ts: message.ts });
    return;
  }

  if (parsed.type === 'ticket') {
    let requesterName;
    try {
      const userInfo = await client.users.info({ user: message.user });
      requesterName = userInfo.user.real_name
        || userInfo.user.profile.display_name
        || userInfo.user.name
        || `<@${message.user}>`;
    } catch (_) {
      requesterName = `<@${message.user}>`;
    }

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
        thread_ts: message.ts,
      });
      return;
    }

    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: 'clipboard',
    });

    await say({
      text: `:clipboard: Ticket logged → ${task.url}\nAssigned to <@${SLACK_USERS[parsed.assignee] || SLACK_USERS.patrick}>`,
      thread_ts: message.ts,
    });
  }
});

(async () => {
  await app.start();
  console.log('✓ IT Support bot running (socket mode)');
})();
