import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import { google } from "googleapis";
import crypto from "crypto";

// ========= ENV =========
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  GOOGLE_APPLICATION_CREDENTIALS_JSON,
  SPREADSHEET_ID,
  SHEET_NAME = "line_bot",     // 会話ログタブ名
  USERS_SHEET = "users",       // ユーザー台帳タブ名
  SYSTEM_PROMPT,
  ADMIN_USER_ID,               // あなたのLINE userId（承認通知の送り先）
  APPROVE_TOKEN,               // 承認URLの簡易トークン（長めのランダム文字列）
  BASE_URL,                    // 例: https://line-openai-bot-xxxx.onrender.com
  BATCH_WINDOW_SECONDS = "60", // まとめ待ち時間（秒）※最後の受信からの待ち
} = process.env;

// 必須チェック
if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  throw new Error("LINE credentials missing");
}
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
if (!GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON missing");
}
if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID missing");
if (!ADMIN_USER_ID || !APPROVE_TOKEN || !BASE_URL) {
  console.warn("ADMIN_USER_ID / APPROVE_TOKEN / BASE_URL not fully set (admin notify/approval will not work correctly).");
}

// ========= LINE / OpenAI =========
const lineClient = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ========= Google Sheets auth =========
function loadServiceAccount() {
  const creds = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON);
  if (creds.private_key && creds.private_key.includes("\\n")) {
    creds.private_key = creds.private_key.replace(/\\n/g, "\n"); // 改行復元
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

// ========= Helpers =========
const systemPrompt =
  SYSTEM_PROMPT ||
  "あなたは優しい悩み相談カウンセラー。否定せず共感→状況確認→小さな提案の順で200〜300字で返答。医療や法律は断定しない。タメ口。絵文字は文末1〜2個。";

function nowJST() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace("T", " ").slice(0, 19);
}
function genId() {
  return crypto.randomBytes(8).toString("hex");
}
function qTitle(title) {
  // シート名にスペースや記号があっても安全に
  return `'${String(title).replace(/'/g, "''")}'`;
}

async function ensureSheetExists(title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets?.some(s => s.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    // 初期ヘッダー
    if (title === SHEET_NAME) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${qTitle(SHEET_NAME)}!A:Z`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["時刻","userId","displayName","ユーザー発言","AI下書き","ステータス","rowId"]] },
      });
    } else if (title === USERS_SHEET) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${qTitle(USERS_SHEET)}!A:Z`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["userId","displayName","firstSeen","lastSeen"]] },
      });
    }
  }
}

async function appendRow(sheetName, row) {
  await ensureSheetExists(sheetName);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(sheetName)}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function upsertUser(userId, displayName) {
  await ensureSheetExists(USERS_SHEET);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(USERS_SHEET)}!A:D`,
  });
  const rows = res.data.values || [];
  const foundIdx = rows.findIndex((r, i) => i > 0 && r[0] === userId); // skip header
  const now = nowJST();

  if (foundIdx === -1) {
    await appendRow(USERS_SHEET, [userId, displayName, now, now]);
  } else {
    const rowIndex = foundIdx + 1; // 1-based
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${qTitle(USERS_SHEET)}!B${rowIndex}:D${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[displayName, rows[foundIdx][2] || now, now]] },
    });
  }
}

async function findRowById(rowId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(SHEET_NAME)}!A:Z`,
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][6] === rowId) {
      return { index: i + 1, row: rows[i] }; // 1-based index
    }
  }
  return null;
}

async function updateStatus(rowIndex, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(SHEET_NAME)}!F${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[status]] },
  });
}

function escapeHtml(str = "") {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function generateDraft(userText) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4, // 安定寄り
      max_tokens: 500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });
    return r.choices?.[0]?.message?.content?.trim() ||
      "ごめんね、今うまく返答が作れないみたい。";
  } catch (e) {
    console.error("OpenAI error:", e?.message || e);
    return "ごめんね、今少し混み合っているみたい。また送ってみてね。";
  }
}

// ========= 連投まとめ用（デバウンス） =========
const WINDOW_SEC = parseInt(BATCH_WINDOW_SECONDS || "60", 10);
// { [userId]: { texts: string[], timer: NodeJS.Timeout | null } }
const buffers = new Map();

async function bufferIncoming(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const userId = event.source?.userId;
  if (!userId) return;

  const buf = buffers.get(userId) || { texts: [], timer: null };
  buf.texts.push(event.message.text);

  if (buf.timer) clearTimeout(buf.timer);

  buf.timer = setTimeout(async () => {
    const texts = buf.texts.slice();
    buffers.delete(userId); // 使い終わったので破棄
    try {
      await processBatchedMessages(userId, texts);
    } catch (e) {
      console.error("processBatchedMessages error:", e?.message || e);
    }
  }, WINDOW_SEC * 1000);

  buffers.set(userId, buf);
}

async function processBatchedMessages(userId, texts) {
  // 表示名（台帳更新）
  let displayName = "";
  try {
    const prof = await lineClient.getProfile(userId);
    displayName = prof?.displayName || "";
    await upsertUser(userId, displayName || "");
  } catch (e) {
    console.error("profile error:", e?.message || e);
  }

  // 受信文を結合（見やすい区切り線）
  const userText = texts.join("\n——\n");

  // 下書き作成
  const draft = await generateDraft(userText);

  // シートに PENDING 保存（承認までユーザーには何も送らない）
  const rowId = genId();
  await appendRow(SHEET_NAME, [nowJST(), userId, displayName, userText, draft, "PENDING", rowId]);

  // 管理者に承認リンクを通知
  if (ADMIN_USER_ID && APPROVE_TOKEN && BASE_URL) {
    const reviewUrl = `${BASE_URL}/review?id=${rowId}&token=${APPROVE_TOKEN}`;
    try {
      await lineClient.pushMessage(ADMIN_USER_ID, {
        type: "text",
        text:
          `【承認待ち（まとめ ${texts.length} 通）】\n` +
          `from: ${displayName || "unknown"} (${userId})\n\n` +
          `Q:\n${userText}\n\n` +
          `Draft:\n${draft}\n\n` +
          `承認/却下 → ${reviewUrl}`,
      });
    } catch (e) {
      console.error("admin notify error:", e?.message || e);
    }
  }
}

// ========= App =========
const app = express();

// Webhook（承認前は一切返信しない／60秒まとめ）
app.post("/callback", middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET }), async (req, res) => {
  try {
    for (const ev of (req.body.events || [])) {
      await bufferIncoming(ev);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e);
    res.sendStatus(500);
  }
});

// 承認レビューページ
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
      <html><body style="font-family:system-ui, sans-serif; line-height:1.6;">
        <h2>承認レビュー</h2>
        <p><b>Status:</b> ${status}</p>
        <p><b>User:</b> ${escapeHtml(displayName)} (${escapeHtml(userId)})</p>
        <p><b>Message(合算):</b><br>${escapeHtml(userText).replace(/\n/g, "<br>")}</p>
        <p><b>Draft:</b><br>${escapeHtml(draft).replace(/\n/g, "<br>")}</p>
        <p>
          <a href="${approveUrl}"><button style="padding:8px 16px;">承認して送信</button></a>
          <a href="${rejectUrl}"><button style="padding:8px 16px;margin-left:8px;">却下</button></a>
        </p>
      </body></html>
    `);
  } catch (e) {
    console.error("review error:", e?.message || e);
    res.status(500).send("Server error");
  }
});

// 承認：ユーザーへ push 送信してステータス更新
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

    await lineClient.pushMessage(userId, { type: "text", text: String(draft).slice(0, 4000) });
    await updateStatus(rowIndex, "SENT");

    res.send("ユーザーへ送信しました。");
  } catch (e) {
    console.error("approve error:", e?.message || e);
    res.status(500).send("Server error");
  }
});

// 却下：ステータスを REJECTED に
app.get("/reject", async (req, res) => {
  try {
    const { id, token } = req.query;
    if (!id || token !== APPROVE_TOKEN) return res.status(403).send("Forbidden");
    const found = await findRowById(String(id));
    if (!found) return res.status(404).send("Not found");

    await updateStatus(found.index, "REJECTED");
    res.send("却下しました。");
  } catch (e) {
    console.error("reject error:", e?.message || e);
    res.status(500).send("Server error");
  }
});

// Health
app.get("/", (_, res) => res.send("LINE × OpenAI × Sheets (manual approval + 60s batch) running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));
