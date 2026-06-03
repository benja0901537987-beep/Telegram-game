// ============================================================
// 🚀 ADVANCED API CLIENT WITH RETRY & TIMEOUT
// api-client.js
// ============================================================

const MAX_RETRIES = 5;
const BASE_TIMEOUT = 15000;
const TIMEOUT_BACKOFF = 1.5;

class APIError extends Error {
  constructor(message, code, retryable = true) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = 'APIError';
  }
}

async function fetchWithTimeout(url, options = {}, timeout = BASE_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new APIError(`Request timeout after ${timeout}ms`, 'TIMEOUT', true);
    }
    throw err;
  }
}

export async function callDeepSeekAPI(systemPrompt, userPrompt, apiKey, options = {}) {
  const {
    model = 'deepseek-ai/deepseek-r1',
    temperature = 0.2,
    maxTokens = 1500,
    retries = MAX_RETRIES,
  } = options;

  let lastError = null;
  let currentTimeout = BASE_TIMEOUT;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[DeepSeek] Attempt ${attempt}/${retries} (timeout: ${currentTimeout}ms)`);

      const response = await fetchWithTimeout(
        'https://integrate.api.nvidia.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature,
            max_tokens: maxTokens,
          }),
        },
        currentTimeout
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error?.message || response.statusText;

        // Non-retryable errors
        if (response.status === 401 || response.status === 403) {
          throw new APIError(`Auth error: ${errorMsg}`, response.status, false);
        }
        if (response.status === 400) {
          throw new APIError(`Bad request: ${errorMsg}`, response.status, false);
        }

        // Rate limit
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '30');
          throw new APIError(`Rate limited (retry after ${retryAfter}s)`, 429, true);
        }

        // Server errors - retryable
        if (response.status >= 500) {
          throw new APIError(`Server error: ${response.status}`, response.status, true);
        }

        throw new APIError(`HTTP ${response.status}: ${errorMsg}`, response.status, true);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || '';

      if (!text) {
        throw new APIError('Empty response from API', 'EMPTY_RESPONSE', true);
      }

      // Try to extract JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch {
          return { raw: text, parsed: false };
        }
      }

      return { raw: text, parsed: false };

    } catch (err) {
      lastError = err;
      console.error(`[DeepSeek] Attempt ${attempt} failed:`, err.message);

      // Non-retryable errors - throw immediately
      if (err instanceof APIError && !err.retryable) {
        throw err;
      }

      // Last attempt
      if (attempt === retries) {
        throw new APIError(
          `All ${retries} attempts failed: ${err.message}`,
          err.code || 'FINAL_FAILURE',
          false
        );
      }

      // Exponential backoff
      const waitTime = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
      console.log(`[DeepSeek] Retrying in ${waitTime}ms...`);
      await new Promise(r => setTimeout(r, waitTime));

      // Increase timeout for next attempt
      currentTimeout = Math.min(60000, currentTimeout * TIMEOUT_BACKOFF);
    }
  }

  throw lastError || new APIError('Unknown error', 'UNKNOWN', false);
}

export async function callGroqAPI(messages, options = {}) {
  const {
    model = 'llama-3.3-70b-versatile',
    temperature = 0.3,
    maxTokens = 500,
    retries = MAX_RETRIES,
  } = options;

  let lastError = null;
  let currentTimeout = BASE_TIMEOUT;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Groq] Attempt ${attempt}/${retries}`);

      // Using Groq SDK is easier, but add timeout wrapper
      const response = await Promise.race([
        fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
          }),
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Groq timeout')), currentTimeout)
        ),
      ]);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        if (response.status === 429) {
          throw new APIError('Rate limited', 429, true);
        }
        if (response.status >= 500) {
          throw new APIError(`Server error: ${response.status}`, response.status, true);
        }
        if (response.status === 401 || response.status === 403) {
          throw new APIError('Auth failed', response.status, false);
        }

        throw new APIError(`Groq error: ${response.status}`, response.status, true);
      }

      const data = await response.json();
      return data.choices[0].message.content;

    } catch (err) {
      lastError = err;
      console.error(`[Groq] Attempt ${attempt} failed:`, err.message);

      if (err instanceof APIError && !err.retryable) {
        throw err;
      }

      if (attempt === retries) {
        throw new APIError(`Groq failed after ${retries} attempts: ${err.message}`, 'GROQ_FINAL', false);
      }

      const waitTime = Math.min(20000, 1000 * Math.pow(2, attempt - 1));
      await new Promise(r => setTimeout(r, waitTime));
      currentTimeout = Math.min(45000, currentTimeout * TIMEOUT_BACKOFF);
    }
  }

  throw lastError;
}

// 🔀 PARALLEL REQUEST HANDLER
export async function callMultipleAPIsInParallel(requests) {
  const results = await Promise.allSettled(requests);
  return results.map((r, i) => ({
    index: i,
    status: r.status,
    value: r.value,
    reason: r.reason,
  }));
}

export { APIError };
