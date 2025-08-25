import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import { google } from "googleapis";

// ====== LINE config ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(config);

// ====== OpenAI ======
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Google Sheets auth ======
const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

// ====== Spreadsheet config ======
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "line_bot";     // 会話ログ
const USERS_SHEET = process.env.USERS_SHEET || "users";      // ユーザー台帳
const SUMMARIES_SHEET = process.env.SUMMARIES_SHEET || "user_summaries"; // 長期要約

// ====== ユーティリティ ======
function nowJST() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

function qTitle(name) {
  return `'${name}'`;
}

// シートが存在しなければ作成＋ヘッダー投入
async function ensureSheetExists(title) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${qTitle(title)}!A1:A1`,
    });
  } catch (e) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
    if (title === SHEET_NAME) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${qTitle(SHEET_NAME)}!A:Z`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["timestamp","userId","displayName","userText","draft","status","rowId"]],
        },
      });
    } else if (title === USERS_SHEET) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${qTitle(USERS_SHEET)}!A:Z`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["userId","displayName","updated_at"]] },
      });
    } else if (title === SUMMARIES_SHEET) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${qTitle(SUMMARIES_SHEET)}!A:Z`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["userId","long_summary","updated_at"]] },
      });
    }
  }
}

async function appendRow(title, values) {
  await ensureSheetExists(title);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(title)}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

// ====== ユーザー台帳 ======
async function upsertUser(userId, displayName) {
  await ensureSheetExists(USERS_SHEET);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(USERS_SHEET)}!A:C`,
  });
  const rows = (res.data.values || []).slice(1);
  const foundIdx = rows.findIndex(r => r[0] === userId);
  const now = nowJST();

  if (foundIdx === -1) {
    await appendRow(USERS_SHEET, [userId, displayName, now]);
  } else {
    const rowIndex = foundIdx + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${qTitle(USERS_SHEET)}!B${rowIndex}:C${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[displayName, now]] },
    });
  }
}

// ====== 履歴 & 要約ユーティリティ ======
async function getAllPairs(userId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(SHEET_NAME)}!A:G`,
  });
  const rows = (res.data.values || []).slice(1);
  return rows
    .filter(r => r[1] === userId && r[5] === "SENT")
    .map(r => ({ user: r[3] || "", asst: r[4] || "" }));
}

function formatRecentPairs(pairs, maxPairs = 20, charLimit = 2000) {
  const last = pairs.slice(-maxPairs).reverse();
  let out = last.map(p => `U: ${p.user}\nA: ${p.asst}`).join("\n---\n");
  if (out.length > charLimit) out = out.slice(-charLimit);
  return out;
}

function takeOlderForSummary(pairs, recentCount = 20) {
  return pairs.slice(0, Math.max(0, pairs.length - recentCount));
}

async function getLongSummary(userId) {
  await ensureSheetExists(SUMMARIES_SHEET);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(SUMMARIES_SHEET)}!A:C`,
  });
  const rows = (res.data.values || []).slice(1);
  const hit = rows.find(r => r[0] === userId);
  return hit ? (hit[1] || "") : "";
}

async function upsertLongSummary(userId, summary) {
  await ensureSheetExists(SUMMARIES_SHEET);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(SUMMARIES_SHEET)}!A:C`,
  });
  const rows = (res.data.values || []).slice(1);
  const now = nowJST();
  const foundIdx = rows.findIndex(r => r[0] === userId);

  if (foundIdx === -1) {
    await appendRow(SUMMARIES_SHEET, [userId, summary, now]);
  } else {
    const rowIndex = foundIdx + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${qTitle(SUMMARIES_SHEET)}!B${rowIndex}:C${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[summary, now]] },
    });
  }
}

async function summarizePairs(olderPairs) {
  if (!olderPairs.length) return "";
  const corpus = olderPairs.map(p => `U: ${p.user}\nA: ${p.asst}`).join("\n---\n");
  const prompt = `
以下の会話ログを要約してください。内容:
- 主要テーマ
- 継続している悩みの傾向
- 試した対策と反応
- 配慮点
300〜500字で簡潔にまとめてください。
${corpus}
`.trim();

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 600,
    messages: [
      { role: "system", content: "あなたは有能な日本語の要約アシスタントです。" },
      { role: "user", content: prompt },
    ],
  });
  return r.choices?.[0]?.message?.content?.trim() || "";
}

async function buildUserContext(userId) {
  const allPairs = await getAllPairs(userId);
  let recentStr = formatRecentPairs(allPairs, 20, 2000);
  let longSummary = await getLongSummary(userId);

  if (!longSummary && allPairs.length > 20) {
    try {
      const older = takeOlderForSummary(allPairs, 20);
      const sum = await summarizePairs(older);
      if (sum) {
        await upsertLongSummary(userId, sum);
        longSummary = sum;
      }
    } catch (e) {
      console.error("summarizePairs error:", e?.message || e);
    }
  }
  return { longSummary, recentStr };
}

// ====== Draft生成 ======
async function generateDraftWithContext(userId, userText) {
  const { longSummary, recentStr } = await buildUserContext(userId);

  const sys = (process.env.SYSTEM_PROMPT || `
あなたは利用者にとって気軽に話せる親友のような存在です。
- 返答は短く：2〜3文。まず共感を1文、その後に具体を1つ聞き返す or 提案を1つ。
- 長文や複数提案はしない。
- タメ口でやわらかい。絵文字は文末に1個まで（😊や🌸など）。
- 医療/法律は断定せず、必要なら専門相談を促す。
`).trim();

  const messages = [
    { role: "system", content: sys },
    { role: "system", content: `このユーザーの長期要約:\n${longSummary || "（まだ要約なし）"}` },
    { role: "system", content: `直近のやり取り（新しい→古い、最大20件）:\n${recentStr || "（履歴なし）"}` },
    { role: "user", content: userText },
  ];

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.35,
    max_tokens: 400,
    messages,
  });
  return r.choices?.[0]?.message?.content?.trim()
    || "うまく返せなかった…もう一度教えてほしい。";
}

// ====== LINE Webhook ======
const app = express();

app.post("/callback", middleware(config), async (req, res) => {
  try {
    for (const ev of (req.body.events || [])) {
      await handleEvent(ev);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const userId = event.source?.userId;
  if (!userId) return;

  const userText = event.message.text;
  const prof = await lineClient.getProfile(userId);
  const displayName = prof?.displayName || "";

  await upsertUser(userId, displayName);

  const draft = await generateDraftWithContext(userId, userText);
  const rowId = Math.random().toString(36).slice(2);

  await appendRow(SHEET_NAME, [nowJST(), userId, displayName, userText, draft, "PENDING", rowId]);

  // ここではユーザーには自動返信せず、管理者承認フローで送信する想定
}

// ====== 動作確認 ======
app.get("/", (_, res) => res.send("LINE × OpenAI × Sheets bot with context"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));
