import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from '@google/genai';
import { readFileSync } from 'fs';
import { join } from 'path';

const CATEGORIES = [
  'Ingredient Deep-Dive',
  'Founder Story',
  'India-Specific Context',
  'Industry Transparency',
  'Brand Philosophy',
  'Consumer Education',
  'Formulation Science',
] as const;

interface ReadinessResult {
  ready: boolean;
  reason: string;
  category: (typeof CATEGORIES)[number];
  topic_query: string;
  clarifying_question?: string;
}

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  text?: string;
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

async function checkReadiness(noteText: string): Promise<ReadinessResult> {
  const ai = getGeminiClient();

  const prompt = `You are screening a note from Meera Pillai (Skinstinct) submitted as raw thinking for a LinkedIn post she wants to create. Decide if there's enough here to draft from.

READY if it has at least one of: a specific number/data point, a concrete scene or anecdote, or a specific technical/mechanistic claim that could be unpacked.
NOT READY if it's a topic without an angle — too thin or too vague to build a full post around.

Note: '${noteText}'

Return JSON only:
{
  'ready': true/false,
  'reason': '<one sentence>',
  'category': '<one of: Ingredient Deep-Dive, Founder Story, India-Specific Context, Industry Transparency, Brand Philosophy, Consumer Education, Formulation Science>',
  'topic_query': '<short phrase for a current angle worth checking>',
  'clarifying_question': '<only if ready is false — one question to ask Meera to get enough to draft>'
}`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          ready: { type: Type.BOOLEAN },
          reason: { type: Type.STRING },
          category: { type: Type.STRING, enum: [...CATEGORIES] },
          topic_query: { type: Type.STRING },
          clarifying_question: { type: Type.STRING },
        },
        required: ['ready', 'reason', 'category', 'topic_query'],
      },
    },
  });

  const raw = response.text;
  if (!raw) throw new Error('Empty readiness response from Gemini');
  return JSON.parse(raw) as ReadinessResult;
}

async function draftPost(
  noteText: string,
  category: string,
  topicQuery: string,
  voiceSkillText: string,
): Promise<string> {
  const ai = getGeminiClient();

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

If genuinely relevant, use your search capability to check for a current angle related to: '${topicQuery}'. Don't force it if nothing fits.

Write the full post, 250-400 words.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });

  const text = response.text;
  if (!text) throw new Error('Empty draft response from Gemini');
  return text.trim();
}

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');

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

  if (!msg || typeof msg.text !== 'string' || !msg.chat?.id) {
    // Nothing to act on (edited_message, my_chat_member, etc.) — ack and stop.
    res.status(200).json({ ok: true, skipped: true });
    return;
  }

  const chatId = msg.chat.id;
  const noteText = msg.text;

  try {
    const readiness = await checkReadiness(noteText);

    if (!readiness.ready) {
      const question = readiness.clarifying_question || readiness.reason;
      await sendTelegramMessage(chatId, question);
      res.status(200).json({ ok: true, ready: false });
      return;
    }

    const voiceSkillText = getVoiceSkillText();
    const draft = await draftPost(noteText, readiness.category, readiness.topic_query, voiceSkillText);

    await sendTelegramMessage(chatId, `[${readiness.category}]\n\n${draft}`);
    res.status(200).json({ ok: true, ready: true });
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
