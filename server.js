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

// ====== Google Sheets auth ======
function loadServiceAccount() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is missing");
  const creds = JSON.parse(raw);
  // <<< 重要: 改行コードを本物の改行に戻す
  if (creds.private_key && creds.private_key.includes("\\n")) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n");
  }
  return creds;
}

const credentials = loadServiceAccount();
const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

// 保存先
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "line_bot"; // ← あなたのシート名に合わせる

async function appendToSheet(values) {
  try {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
    console.log("Sheets append result:", res.status, res.statusText);
  } catch (e) {
    const msg =
      e?.errors?.[0]?.message ||
      e?.response?.data?.error?.message ||
      e?.message;
    console.error("Sheets append error:", msg);
    throw e;
  }
}

// ====== LINE ======
const app = express();
const lineClient = new Client(config);

app.post("/callback", middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("handler error:", e);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userText = event.message.text;
  const systemPrompt =
    process.env.SYSTEM_PROMPT ||
    "あなたは優しい悩み相談カウンセラー。否定せず共感→状況確認→小さな提案の順で、200〜300字で返答。医療や法律は断定しない。";

  let reply = "ごめんね、いま上手く返答を作れないみたい。もう一度送ってみてね。";
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
    console.error("OpenAI error:", err?.message);
  }

  // 返答
  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: reply.slice(0, 4000),
  });

  // シート保存
  try {
    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const ts = jst.toISOString().replace("T", " ").slice(0, 19);
    const userId = event.source?.userId || "";
    await appendToSheet([[ts, userId, userText, reply]]);
  } catch (e) {
    // 上で詳細ログを出しているのでここは静かに
  }
}

// 動作確認 & Sheets テスト書き込み
app.get("/", (_, res) => res.send("LINE × OpenAI × Sheets on Render"));

app.get("/diag/sheets", async (_, res) => {
  try {
    const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const ts = jst.toISOString().replace("T", " ").slice(0, 19);
    await appendToSheet([[ts, "diag", "ping", "pong"]]);
    res.send("OK: wrote a row to Google Sheets");
  } catch (e) {
    res.status(500).send("NG: " + (e?.message || "unknown error"));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));
