import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from '@google/genai';
import { readFileSync } from 'fs';
import { join } from 'path';

const READY_THRESHOLD = 6;
const NEWS_RESULT_LIMIT = 3;

const CATEGORIES = [
  'Ingredient Deep-Dive',
  'Founder Story',
  'India-Specific Context',
  'Industry Transparency',
  'Brand Philosophy',
  'Consumer Education',
  'Formulation Science',
] as const;

interface ScoreResult {
  score: number;
  reason: string;
  category: (typeof CATEGORIES)[number];
  topic_query: string;
  clarifying_question?: string;
}

interface NewsItem {
  title: string;
  link: string;
}

interface TelegramChat {
  id: number;
}

interface TelegramVoice {
  file_id: string;
}

interface TelegramMessage {
  text?: string;
  voice?: TelegramVoice;
  chat: TelegramChat;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

function getVoiceSkillText(): string {
  return readFileSync(join(process.cwd(), 'meera-voice-skill.txt'), 'utf-8');
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  return new GoogleGenAI({ apiKey });
}

function getTelegramToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return token;
}

async function transcribeVoice(fileId: string): Promise<string> {
  const token = getTelegramToken();

  const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  if (!fileInfoRes.ok) {
    throw new Error(`Telegram getFile failed: ${fileInfoRes.status} ${await fileInfoRes.text()}`);
  }
  const fileInfo = (await fileInfoRes.json()) as { result?: { file_path?: string } };
  const filePath = fileInfo.result?.file_path;
  if (!filePath) throw new Error('Telegram getFile returned no file_path');

  const audioRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!audioRes.ok) throw new Error(`Telegram file download failed: ${audioRes.status}`);
  const audioBase64 = Buffer.from(await audioRes.arrayBuffer()).toString('base64');

  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Transcribe this voice note to plain text. Return only the transcription, nothing else.' },
          { inlineData: { mimeType: 'audio/ogg', data: audioBase64 } },
        ],
      },
    ],
  });

  const transcript = response.text?.trim();
  if (!transcript) throw new Error('Empty transcription response from Gemini');
  return transcript;
}

async function checkScore(noteText: string): Promise<ScoreResult> {
  const ai = getGeminiClient();

  const prompt = `You are scoring a note from Meera Pillai (Skinstinct) submitted as raw thinking for a LinkedIn post she wants to create. Score how much there is to draft from, 0-10.

Score higher for: a specific number/data point, a concrete scene or anecdote, a specific technical/mechanistic claim that could be unpacked. The more of these present and the more developed, the higher the score. Score lower for a topic mentioned with no angle — too thin or too vague to build a full post around.

Note: '${noteText}'

Return JSON only:
{
  'score': <integer 0-10>,
  'reason': '<one sentence>',
  'category': '<one of: Ingredient Deep-Dive, Founder Story, India-Specific Context, Industry Transparency, Brand Philosophy, Consumer Education, Formulation Science>',
  'topic_query': '<short phrase for a current news angle worth checking>',
  'clarifying_question': '<only relevant if score is low — one question to ask Meera to get enough to draft>'
}`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.INTEGER },
          reason: { type: Type.STRING },
          category: { type: Type.STRING, enum: [...CATEGORIES] },
          topic_query: { type: Type.STRING },
          clarifying_question: { type: Type.STRING },
        },
        required: ['score', 'reason', 'category', 'topic_query'],
      },
    },
  });

  const raw = response.text;
  if (!raw) throw new Error('Empty score response from Gemini');
  return JSON.parse(raw) as ScoreResult;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!match) return null;
  let content = match[1].trim();
  const cdata = content.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) content = cdata[1].trim();
  return decodeXmlEntities(content);
}

function stripTrailingSource(title: string): string {
  const idx = title.lastIndexOf(' - ');
  return idx === -1 ? title : title.slice(0, idx);
}

async function fetchIndustryNews(topicQuery: string): Promise<NewsItem[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topicQuery)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const xml = await res.text();
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) !== null && items.length < NEWS_RESULT_LIMIT) {
      const rawTitle = extractTag(match[1], 'title');
      const link = extractTag(match[1], 'link');
      if (!rawTitle || !link) continue;
      items.push({ title: stripTrailingSource(rawTitle), link });
    }
    return items;
  } catch {
    return [];
  }
}

async function draftPost(
  noteText: string,
  category: string,
  newsItems: NewsItem[],
  voiceSkillText: string,
): Promise<string> {
  const ai = getGeminiClient();

  const newsBlock =
    newsItems.length > 0 ? newsItems.map((item) => `- ${item.title}`).join('\n') : 'No current news context available';

  const prompt = `You are drafting a LinkedIn post in Meera Pillai's voice for Skinstinct. Follow the attached voice reference as your style guide, specifically the LinkedIn structural template:
- Cold open: a specific stat or claim about the reader's own product, no throat-clearing
- State the misconception plainly
- Decompose into 2-3 factors the label/claim hides
- Ground with a specific Skinstinct data point or internal standard
- End with an instruction: what to ask ANY brand, not just hers

Constraints:
- Include one moment where she narrows her own claim ('I'm not saying X...')
- No hype adjectives, no exclamation points
- Evidence should read as hers (internal data), not borrowed authority
- Never pitches directly — ends on a reader action, not a CTA to buy

Voice reference (style guide):
"""
${voiceSkillText}
"""

Source note: '${noteText}'
Category: ${category}

Current industry context, use only if genuinely relevant, don't force it: ${newsBlock}

Write the full post, 250-400 words.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: prompt,
  });

  const text = response.text;
  if (!text) throw new Error('Empty draft response from Gemini');
  return text.trim();
}

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = getTelegramToken();

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const update = req.body as TelegramUpdate;
  const msg = update?.message ?? update?.channel_post;

  if (!msg || (!msg.text && !msg.voice) || !msg.chat?.id) {
    // Nothing to act on (edited_message, my_chat_member, etc.) — ack and stop.
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const chatId = msg.chat.id;

  try {
    const noteText = msg.text ?? (await transcribeVoice(msg.voice!.file_id));

    const scoreResult = await checkScore(noteText);

    if (scoreResult.score < READY_THRESHOLD) {
      const question = scoreResult.clarifying_question ?? scoreResult.reason;
      await sendTelegramMessage(chatId, `Scored ${scoreResult.score}/10 — ${scoreResult.reason}\n\n${question}`);
      res.status(200).json({ ok: true, score: scoreResult.score });
      return;
    }

    const newsItems = await fetchIndustryNews(scoreResult.topic_query);
    const voiceSkillText = getVoiceSkillText();
    const draft = await draftPost(noteText, scoreResult.category, newsItems, voiceSkillText);

    await sendTelegramMessage(chatId, `[${scoreResult.category}] · Scored ${scoreResult.score}/10\n\n${draft}`);
    res.status(200).json({ ok: true, score: scoreResult.score });
  } catch (err) {
    console.error('telegram-webhook error:', err);
    try {
      await sendTelegramMessage(
        chatId,
        'Something went wrong drafting that one — try resending the note in a moment.',
      );
    } catch (notifyErr) {
      console.error('failed to notify chat of error:', notifyErr);
    }
    res.status(200).json({ ok: false });
  }
}
