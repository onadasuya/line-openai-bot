import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import { google } from "googleapis";
import crypto from "crypto";

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

// ====== ENV ======
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID is not set");

const SHEET_NAME  = process.env.SHEET_NAME  || "line_bot";
const USERS_SHEET = process.env.USERS_SHEET || "users";

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || ""; // あなたのLINE userId
const APPROVE_TOKEN = process.env.APPROVE_TOKEN || "";
const BASE_URL      = process.env.BASE_URL || "";

// ====== utils ======
function genId() {
  return crypto.randomBytes(8).toString("hex");
}

async function appendToSheet(values, sheetName = SHEET_NAME) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

async function findRowById(rowId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });
  const rows = res.data.values || [];
  // 1行目はヘッダ想定
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[6] === rowId) {
      return { index: i + 1, row: r }; // シート上の行番号（1始まり）
    }
  }
  return null;
}

async function updateStatus(rowIndex, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!F${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] },
  });
}

// ====== Webhook ======
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

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source?.userId;
  if (!userId) return;

  const userText = event.message.text;

  // 1) ユーザー名
  let displayName = "unknown";
  try {
    const profile = await lineClient.getProfile(userId);
    displayName = profile.displayName || "unknown";

    // 新規ユーザーなら users シートに追記
    await appendToSheet([[userId, displayName]], USERS_SHEET);
  } catch (e) {
    console.error("Profile fetch error:", e);
  }

  // 2) AI 下書き
  const systemPrompt =
    process.env.SYSTEM_PROMPT ||
    "あなたは優しい悩み相談カウンセラー。否定せず共感→状況確認→小さな提案の順で200〜300字で返答。医療や法律は断定しない。";

  let draft = "ごめんね、今うまく返答が作れないみたい。";
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
    draft = resp.choices?.[0]?.message?.content?.trim() || draft;
  } catch (err) {
    console.error("OpenAI error:", err);
  }

  // 3) シートに PENDING で保存
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timestamp = jst.toISOString().replace("T", " ").slice(0, 19);
  const rowId = genId();

  await appendToSheet([[timestamp, userId, displayName, userText, draft, "PENDING", rowId]]);

  // 4) ユーザーには受付連絡だけ（自動返信はしない）
  try {
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "メッセージありがとう！内容を確認してからお返事するね。少し待っててね。",
    });
  } catch (e) {
    console.error("LINE reply error:", e);
  }

  // 5) 管理者に承認用URLを通知
  if (ADMIN_USER_ID && BASE_URL && APPROVE_TOKEN) {
    const reviewUrl = `${BASE_URL}/review?id=${rowId}&token=${APPROVE_TOKEN}`;
    try {
      await lineClient.pushMessage(ADMIN_USER_ID, {
        type: "text",
        text:
          `【承認待ち】\n` +
          `from: ${displayName} (${userId})\n` +
          `Q: ${userText}\n\n` +
          `Draft:\n${draft}\n\n` +
          `承認/却下はこちら → ${reviewUrl}`,
      });
    } catch (e) {
      console.error("Notify admin error:", e);
    }
  }
}

// ====== 承認画面（簡易HTML） ======
app.get("/review", async (req, res) => {
  try {
    const { id, token } = req.query;
    if (!id || token !== APPROVE_TOKEN) return res.status(403).send("Forbidden");

    const found = await findRowById(String(id));
    if (!found) return res.status(404).send("Not found");

    const [, userId, displayName, userText, draft, status] = found.row;

    const approveUrl = `${BASE_URL}/approve?id=${id}&token=${APPROVE_TOKEN}`;
    const rejectUrl  = `${BASE_URL}/reject?id=${id}&token=${APPROVE_TOKEN}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <html><body>
        <h2>承認レビュー</h2>
        <p><b>status:</b> ${status}</p>
        <p><b>user:</b> ${displayName} (${userId})</p>
        <p><b>Q:</b> ${escapeHtml(userText)}</p>
        <p><b>Draft:</b><br>${escapeHtml(draft).replace(/\n/g, "<br>")}</p>
        <p>
          <a href="${approveUrl}"><button style="padding:8px 16px;">承認して送信</button></a>
          <a href="${rejectUrl}"><button style="padding:8px 16px;margin-left:8px;">却下</button></a>
        </p>
      </body></html>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error");
  }
});

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ====== 承認 → ユーザーへ送信（push） ======
app.get("/approve", async (req, res) => {
  try {
    const { id, token } = req.query;
    if (!id || token !== APPROVE_TOKEN) return res.status(403).send("Forbidden");

    const found = await findRowById(String(id));
    if (!found) return res.status(404).send("Not found");

    const row = found.row;
    const rowIndex = found.index;

    const userId = row[1];
    const draft  = row[4];
    const status = row[5];

    if (status === "SENT") return res.send("すでに送信済みです。");

    await lineClient.pushMessage(userId, { type: "text", text: draft.slice(0, 4000) });
    await updateStatus(rowIndex, "SENT");

    res.send("ユーザーへ送信しました。");
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error");
  }
});

// ====== 却下 ======
app.get("/reject", async (req, res) => {
  try {
    const { id, token } = req.query;
    if (!id || token !== APPROVE_TOKEN) return res.status(403).send("Forbidden");

    const found = await findRowById(String(id));
    if (!found) return res.status(404).send("Not found");

    await updateStatus(found.index, "REJECTED");
    res.send("却下しました。");
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error");
  }
});

// ====== 動作確認 ======
app.get("/", (_, res) => res.send("LINE × OpenAI × Sheets (manual approval mode) on Render"));

// ====== 起動 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));
