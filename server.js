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

// ====== Sheets IDs ======
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is not set");

const SHEET_NAME = process.env.SHEET_NAME || "line_bot";   // 会話ログ用
const USERS_SHEET = process.env.USERS_SHEET || "users";    // ユーザー管理用

// ====== utils: append to Google Sheets ======
async function appendToSheet(values, sheetName = SHEET_NAME) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

// ====== LINE webhook ======
const app = express();

app.post("/callback", middleware(config), async (req, res) => {
  try {
    for (const ev of (req.body.events || [])) {
      await handleEvent(ev);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook handler error:", e);
    res.sendStatus(500);
  }
});

// ====== Handle LINE message ======
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source?.userId;
  if (!userId) return;

  const userText = event.message.text;

  // --- ユーザー名を取得（1回だけAPI呼ぶ）
  let displayName = "unknown";
  try {
    const profile = await lineClient.getProfile(userId);
    displayName = profile.displayName || "unknown";

    // ユーザーシートに存在しない場合は追加
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${USERS_SHEET}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [[userId, displayName]] },
    });
  } catch (e) {
    console.error("Profile fetch error:", e);
  }

  // --- OpenAIに問い合わせ
  const systemPrompt =
    process.env.SYSTEM_PROMPT ||
    "あなたは優しい悩み相談カウンセラー。否定せず共感→状況確認→小さな提案の順で200〜300字で返答。医療や法律は断定しない。";

  let reply = "ごめんね、今うまく返答が作れないみたい。";
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });
    reply = resp.choices?.[0]?.message?.content?.trim() || reply;
  } catch (err) {
    console.error("OpenAI error:", err);
  }

  // --- LINEに返信
  try {
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: reply.slice(0, 4000),
    });
  } catch (e) {
    console.error("LINE reply error:", e);
  }

  // --- シートに保存
  try {
    const now = new Date();
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000); // JST
    const timestamp = jst.toISOString().replace("T", " ").slice(0, 19);

    await appendToSheet([[timestamp, userId, displayName, userText, reply]]);
  } catch (e) {
    console.error("Sheet append error:", e);
  }
}

// ====== 動作確認用 ======
app.get("/", (_, res) => res.send("LINE × OpenAI × Sheets on Render"));

// ====== 起動 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));
