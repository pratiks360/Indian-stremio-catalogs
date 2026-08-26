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

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Fresh controller/timeout per attempt — a shared one across retries
    // meant that once attempt 1 timed out, its signal stayed aborted and
    // every retry after it failed instantly instead of getting its own 30s.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
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
          // reasoning:{exclude:true} isn't honored by every free-tier
          // provider — observed live: a model narrated its reasoning into
          // the main content channel anyway and got cut off mid-sentence at
          // 2000 tokens, never reaching the actual answer. A bigger budget
          // is the only reliable fix when the provider ignores the flag.
          max_tokens: 4000,
          reasoning: { exclude: true }
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
      lastErr = err.name === 'AbortError' ? new Error('OpenRouter request timed out after 30s') : err;
      if (attempt < 3) await sleep(attempt * 800);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

module.exports = { generateText, CHAT_URL };
