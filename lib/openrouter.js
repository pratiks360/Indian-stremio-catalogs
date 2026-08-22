'use strict';

/**
 * Minimal OpenRouter client — the OpenAI-compatible chat/completions shape,
 * pointed at OpenRouter only. Modeled on the AI-provider abstraction in
 * itcon-pty-au/stremio-ai-search (utils/aiProvider.js), trimmed to the one
 * provider this addon needs instead of their multi-provider switch.
 */

const config = require('../config');

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} prompt
 * @returns {Promise<string>} the model's raw text response
 */
async function generateText(prompt) {
  if (!config.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let lastErr;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(CHAT_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
            // Optional per OpenRouter's own docs — identifies the app on
            // https://openrouter.ai/rankings, not required for the API to work.
            'http-referer': 'https://github.com/pratiks360/Indian-stremio-catalogs',
            'x-title': 'Indian Stremio Catalogs'
          },
          body: JSON.stringify({
            model: config.OPENROUTER_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 2000
          })
        });

        if (res.status === 429 && attempt < 3) {
          await sleep(attempt * 2000);
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`OpenRouter ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content ?? '';
        return String(content).trim();
      } catch (err) {
        if (err.name === 'AbortError') throw new Error('OpenRouter request timed out after 30s');
        lastErr = err;
        if (attempt < 3) await sleep(attempt * 800);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  throw lastErr;
}

module.exports = { generateText, CHAT_URL };
