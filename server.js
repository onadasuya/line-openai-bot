import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import { google } from "googleapis";

// ====== LINE config ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// ====== OpenAI ======
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Google Sheets ======
const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const gs = google.sheets({ version: "v4", auth });

// === シート名（環境変数で上書き可能） ===
const SPREADSHEET_ID = process.env.SPREADSHEET_ID!;
const MESSAGES_SHEET = process.env.SHEET_NAME || "line_bot";   // 既存タブ
const USERS_SHEET    = process.env.USERS_SHEET || "users";     // 新規作成して使う

// ---- ユーティリティ ----
async function ensureSheetExists(title) {
  const meta = await gs.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const has = meta.data.sheets?.some(s => s.properties?.title === title);
  if (!has) {
    await gs.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
    // 見出し行（初回）
    if (title === MESSAGES_SHEET) {
      await gs.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${MESSAGES_SHEET}!A:Z`,
        valueInputOption: "RAW",
        requestBody: { values: [["時刻","userId","displayName","ユーザー発言","AI返答"]] }
      });
    } else if (title === USERS_SHEET) {
      await gs.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${USERS_SHEET}!A:Z`,
        valueInputOption: "RAW",
        requestBody: { values: [["userId","displayName","firstSeen","lastSeen"]] }
      });
    }
  }
}

async function appendRow(sheetName, values) {
  await ensureSheetExists(sheetName);
  await gs.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] }
  });
}

// users 台帳を更新（なければ作成、あれば lastSeen 更新）
async function upsertUser(userId, displayName) {
  await ensureSheetExists(USERS_SHEET);
  const res = await gs.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${USERS_SHEET}!A:D`
  });
  const rows = res.data.values || [];
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString().replace("T"," ").slice(0,19);

  let rowIndex = rows.findIndex(r => r[0] === userId);
  if (rowIndex === -1) {
    // 新規
    await appendRow(USERS_SHEET, [userId, displayName, nowJST, nowJST]);
  } else {
    // 更新（lastSeen と displayName）
    const targetRow = rowIndex + 1; // 1-based
    await gs.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${USERS_SHEET}!B${targetRow}:D${targetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[displayName, rows[rowIndex][2] || nowJST, nowJST]] }
    });
  }
}

// ====== LINE bot ======
const app = express();
const lineClient = new Client(config);

app.post("/callback", middleware(config), async (req, res) => {
  try {
    for (const event of (req.body.events || [])) {
      await handleEvent(event);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source?.userId; // 1:1トークで取得可
  let displayName = "";

  // プロフィール取得（グループだと取れないことがあるので例外吸収）
  if (userId) {
    try {
      const prof = await lineClient.getProfile(userId);
      displayName = prof?.displayName || "";
    } catch {}
  }

  // OpenAI 応答
  const systemPrompt =
    process.env.SYSTEM_PROMPT ||
    "あなたは優しい悩み相談カウンセラー。否定せず共感→状況確認→小さな提案の順で、200〜300字で返答。医療や法律は断定しない。";

  const userText = event.message.text;
  let reply = "うまく返答が作れませんでした。もう一度試してね。";
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ]
    });
    reply = resp.choices?.[0]?.message?.content?.trim() || reply;
  } catch (err) {
    console.error("OpenAI error:", err);
  }

  // LINE 返信
  await lineClient.replyMessage(event.replyToken, { type: "text", text: reply.slice(0,4000) });

  // 台帳更新 & messages 追記
  const ts = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString().replace("T"," ").slice(0,19);

  try {
    if (userId) await upsertUser(userId, displayName || "");
    await appendRow(MESSAGES_SHEET, [ts, userId || "", displayName || "", userText, reply]);
  } catch (e) {
    console.error("Sheets write error:", e);
  }
}

// health
app.get("/", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));
