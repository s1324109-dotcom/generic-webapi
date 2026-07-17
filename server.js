const express = require('express');
const fs = require('fs');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public'));

// ===== 設定 =====
// 利用するLLMプロバイダを選択します（'openai' または 'gemini'）
const PROVIDER = process.env.LLM_PROVIDER || 'openai';

// プロバイダごとに利用するモデル
const MODELS = {
    openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',        // OpenAI（デフォルト）
    gemini: process.env.GEMINI_MODEL || 'gemini-1.5-flash', // Google Gemini
};
const MODEL = MODELS[PROVIDER];

let promptTemplate;
try {
    promptTemplate = fs.readFileSync('prompt.md', 'utf8');
} catch (error) {
    console.error('Error reading prompt.md:', error);
    process.exit(1);
}

const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

// public/ 内の .html 一覧を返す（index.html がこの一覧を使ってリンクを表示する）
app.get('/api/pages', (req, res) => {
    const files = fs.readdirSync('public')
        .filter(name => name.endsWith('.html') && name !== 'index.html');
    res.json(files);
});

// 問題数の上限（過剰なリクエストでトークンを浪費しないようにする）
const MAX_COUNT = 20;

app.post('/api/', async (req, res) => {
    try {
        // title と、変数置換に使うその他のキーを受け取る
        // （prompt.md がプロンプトを定義するので、リクエストでの上書きは許可しない）
        const { title = 'Generated Content', ...variables } = req.body;

        // count が指定されている場合は 1〜MAX_COUNT の範囲に収める
        if (variables.count !== undefined) {
            const count = Number(variables.count);
            if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
                return res.status(400).json({
                    error: `count must be an integer between 1 and ${MAX_COUNT}`,
                });
            }
        }

        // prompt.md のテンプレート変数 ${key} をリクエストの値で置換する
        const finalPrompt = fillTemplate(promptTemplate, variables);

        let result;
        if (PROVIDER === 'openai') {
            result = await callOpenAI(finalPrompt);
        } else if (PROVIDER === 'gemini') {
            result = await callGemini(finalPrompt);
        } else {
            return res.status(400).json({ error: 'Invalid provider configuration' });
        }

        res.json({
            title: title,
            data: result,
        });

    } catch (error) {
        // 詳細はサーバーログにのみ出力し、クライアントには汎用メッセージを返す
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to generate content. Please try again.' });
    }
});

app.post('/api/legend', async (req, res) => {
    try {
        const topic = sanitizeText(req.body.topic, 80);
        const tone = sanitizeText(req.body.tone || '不気味だが現実にありそう', 40);
        const length = sanitizeText(req.body.length || '標準', 20);

        if (!topic) {
            return res.status(400).json({ error: 'topic is required' });
        }

        const workflow = await generateUrbanLegend({ topic, tone, length });
        res.json(workflow);
    } catch (error) {
        console.error('Legend API Error:', error);
        res.status(500).json({ error: 'Failed to generate urban legend. Please try again.' });
    }
});

// prompt.md 内の ${key} を variables の値で安全に置換する
function fillTemplate(template, variables) {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(variables, key)
            ? String(variables[key])
            : match; // 対応する値がなければそのまま残す
    });
}

async function callOpenAI(prompt) {
    const parsedData = await callOpenAIJson(prompt);
    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

async function callOpenAIJson(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: prompt }
            ],
            max_completion_tokens: prompt.includes('都市伝説') ? 3500 : 2000,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenAI API error');
    }

    const data = await response.json();
    const responseText = data.choices[0].message.content;
    return extractJsonObject(responseText);
}

async function callGemini(prompt) {
    const parsedData = await callGeminiJson(prompt);
    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

async function callGeminiJson(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const response = await fetch(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                maxOutputTokens: prompt.includes('都市伝説') ? 5000 : 3000,
                response_mime_type: "application/json"
            }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Gemini API error');
    }

    const data = await response.json();
    const responseText = data.candidates[0].content.parts[0].text;
    return extractJsonObject(responseText);
}

async function callLLMJson(prompt) {
    if (PROVIDER === 'openai') {
        return callOpenAIJson(prompt);
    }
    if (PROVIDER === 'gemini') {
        return callGeminiJson(prompt);
    }
    throw new Error('Invalid provider configuration');
}

async function generateUrbanLegend({ topic, tone, length }) {
    const startedAt = new Date().toISOString();
    const steps = [];

    const analysis = await runLegendStep(steps, 'analysis', '題材分析', `
あなたは都市伝説を設計する編集者です。
題材「${topic}」を分析し、日常性、不気味さ、噂になりやすい要素を抽出してください。

条件:
- 実在の事件、団体、個人、大学名、店舗名は作らない
- 読者が「ありそう」と感じる具体性を入れる
- 出力はJSONのみ

形式:
{
  "topic": string,
  "ordinaryDetails": string[],
  "fearTriggers": string[],
  "rumorHooks": string[],
  "taboo": string,
  "coreQuestion": string
}`);

    const setting = await runLegendStep(steps, 'setting', '設定生成', `
以下の分析をもとに、都市伝説の基本設定を作ってください。
題材: ${topic}
トーン: ${tone}
長さ: ${length}
分析: ${JSON.stringify(analysis)}

条件:
- フィクションとして楽しめるが、文章内では本物の噂のように見せる
- 固有名詞は架空にする
- 出力はJSONのみ

形式:
{
  "title": string,
  "catchcopy": string,
  "location": string,
  "period": string,
  "rule": string,
  "origin": string,
  "signs": string[],
  "twistSeed": string
}`);

    const testimonies = await runLegendStep(steps, 'testimonies', '証言生成', `
以下の設定について、目撃証言を3件作ってください。
設定: ${JSON.stringify(setting)}

条件:
- 年齢、職業、関係性を少しだけ変える
- 直接的に怪物や幽霊を断定しない
- 語り口は口コミらしく、各120字以内
- 出力はJSONのみ

形式:
{
  "testimonies": [
    {
      "speaker": string,
      "context": string,
      "quote": string
    }
  ]
}`);

    const social = await runLegendStep(steps, 'social', 'SNS生成', `
以下の設定と証言をもとに、架空SNS投稿と口コミを作ってください。
設定: ${JSON.stringify(setting)}
証言: ${JSON.stringify(testimonies)}

条件:
- 投稿者IDは架空
- 実在SNS名を断定的に使いすぎない
- 短文、ハッシュタグ、半信半疑の反応を混ぜる
- 出力はJSONのみ

形式:
{
  "posts": [
    {
      "handle": string,
      "time": string,
      "body": string,
      "reaction": string
    }
  ],
  "wordOfMouth": string[]
}`);

    const article = await runLegendStep(steps, 'article', '記事生成', `
以下の素材をもとに、Wikipedia風の架空記事と最後のオチを作ってください。
題材: ${topic}
分析: ${JSON.stringify(analysis)}
設定: ${JSON.stringify(setting)}
証言: ${JSON.stringify(testimonies)}
SNS: ${JSON.stringify(social)}

条件:
- 本物のWikipediaとは名乗らない
- 百科事典風の淡々とした文体にする
- 最後に短いオチを入れる
- 出力はJSONのみ

形式:
{
  "summary": string,
  "articleSections": [
    {
      "heading": string,
      "body": string
    }
  ],
  "ending": string,
  "disclaimer": "この物語はAIが生成した架空の都市伝説です。"
}`);

    const evaluation = await runLegendStep(steps, 'evaluation', '評価', `
以下の都市伝説を評価し、改善点を短く示してください。
設定: ${JSON.stringify(setting)}
証言: ${JSON.stringify(testimonies)}
SNS: ${JSON.stringify(social)}
記事: ${JSON.stringify(article)}

条件:
- 100点満点のスコア
- リアリティ、不気味さ、日常性、オチを評価
- 出力はJSONのみ

形式:
{
  "score": number,
  "reality": string,
  "creepiness": string,
  "everydayness": string,
  "endingQuality": string,
  "revisionHint": string
}`);

    return {
        topic,
        generatedAt: startedAt,
        model: MODEL,
        provider: PROVIDER,
        result: {
            analysis,
            setting,
            testimonies,
            social,
            article,
            evaluation,
        },
        steps,
    };
}

async function runLegendStep(steps, id, label, prompt) {
    const startedAt = Date.now();
    const result = await callLLMJson(prompt);
    steps.push({
        id,
        label,
        durationMs: Date.now() - startedAt,
        status: 'done',
    });
    return result;
}

function sanitizeText(value, maxLength) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

// LLM が返した JSON 文字列をパースする
function extractJsonObject(responseText) {
    try {
        return JSON.parse(responseText);
    } catch (parseError) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Failed to parse LLM response: ' + parseError.message);
        }
        return JSON.parse(jsonMatch[0]);
    }
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
