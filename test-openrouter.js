/**
 * Smoke test for OpenRouter (chat filter + translation).
 * Usage: node test-openrouter.js
 * Requires OPENROUTER_API_KEY in backend/.env
 */
require('dotenv').config();

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.5-flash-02-23';

async function complete(messages, maxTokens) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.error('OPENROUTER_API_KEY is not set');
        process.exit(1);
    }

    const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };
    if (process.env.OPENROUTER_SITE_URL) {
        headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
    }
    if (process.env.OPENROUTER_APP_NAME) {
        headers['X-OpenRouter-Title'] = process.env.OPENROUTER_APP_NAME;
    }

    const res = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: MODEL,
            messages,
            temperature: 0,
            max_tokens: maxTokens,
        }),
    });

    const body = await res.json();
    if (!res.ok) {
        throw new Error(body?.error?.message || res.statusText);
    }
    return body.choices?.[0]?.message?.content?.trim() ?? '';
}

async function run() {
    console.log('Model:', MODEL);

    const filterResult = await complete(
        [
            {
                role: 'system',
                content:
                    'Detect contact sharing in marketplace chat. Reply exactly VIOLATION or CLEAN only.',
            },
            { role: 'user', content: 'رقمي zero five zero one two three' },
        ],
        10,
    );
    console.log('Filter (obfuscated phone):', filterResult);

    const translateResult = await complete(
        [
            {
                role: 'system',
                content:
                    'Translate auto parts chat: Arabic to English, English to Arabic. Output translation only.',
            },
            { role: 'user', content: 'أحتاج فلتر زيت للسيارة' },
        ],
        256,
    );
    console.log('Translation (AR→EN):', translateResult);

    console.log('SUCCESS');
}

run().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
