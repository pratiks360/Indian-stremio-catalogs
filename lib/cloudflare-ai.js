'use strict';

/**
 * Cloudflare Workers AI — last-resort fallback for search.js's runSearch
 * when every OpenRouter draw fails or times out (openrouter/free's random
 * model draw can land on a congested/slow free model repeatedly; this is
 * a different provider entirely, so it doesn't share OpenRouter's outage).
 *
 * Free tier: 10,000 neurons/day, no card required. Same
 * generateText(prompt) -> raw text shape as lib/openrouter.js so search.js
 * can call either interchangeably.
 */

const config = require('../config');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isConfigured() {
  return Boolean(config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_AI_TOKEN);
}

/**
 * @param {string} prompt
 * @returns {Promise<string>} the model's raw text response
 */
async function generateText(prompt) {
  if (!isConfigured()) {
    throw new Error('Cloudflare AI not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AI_TOKEN)');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/ai/run/${config.CLOUDFLARE_AI_MODEL}`;

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.CLOUDFLARE_AI_TOKEN}`
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] })
      });

      if (res.status === 429 && attempt < 2) {
        await sleep(2000);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Cloudflare AI ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(`Cloudflare AI run failed: ${JSON.stringify(data.errors || data)}`);
      }
      return String(data.result?.response ?? '').trim();
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('Cloudflare AI request timed out after 30s') : err;
      if (attempt < 2) await sleep(800);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

module.exports = { generateText, isConfigured };
