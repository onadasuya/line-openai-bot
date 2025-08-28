import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";
import { google } from "googleapis";
import crypto from "crypto";

// ====== ENV ======
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  GOOGLE_APPLICATION_CREDENTIALS_JSON,
  SPREADSHEET_ID,
  SHEET_NAME = "line_bot",
  USERS_SHEET = "users",
  SUMMARIES_SHEET = "user_summaries",
  SYSTEM_PROMPT,
  // 承認フロー（任意）
  ADMIN_USER_ID,
  APPROVE_TOKEN,
  BASE_URL,
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  throw new Error("LINE credentials missing");
}
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
if (!GOOGLE_APPLICATION_CREDENTIALS_JSON) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON missing");
if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID missing");

// ====== LINE / OpenAI ======
const config = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new Client(config);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ====== Google Sheets auth ======
function loadServiceAccount() {
  const creds = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON);
  // Renderなどで \n がエスケープされている場合に復元
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

// ====== Utils ======
function nowJST() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
}
function qTitle(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}
function genId() {
  return crypto.randomBytes(8).toString("hex");
}
function escapeHtml(str = "") {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// ====== シート作成＆書き込み ======
async function ensureSheetExists(title) {
  try {
    await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${qTitle(title)}!A1:A1`,
    });
  } catch {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    if (title === SHEET_NAME) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${qTitle(SHEET_NAME)}!A:Z`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["timestamp","userId","displayName","userText","draft","status","rowId"]] },
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
  const idx = rows.findIndex(r => r[0] === userId);
  const now = nowJST();
  if (idx === -1) {
    await appendRow(USERS_SHEET, [userId, displayName, now]);
  } else {
    const rowIndex = idx + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${qTitle(USERS_SHEET)}!B${rowIndex}:C${rowIndex}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[displayName, now]] },
    });
  }
}

// ====== 履歴・要約（最新20＋古い要約） ======
async function getAllPairs(userId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(SHEET_NAME)}!A:G`,
  });
  const rows = (res.data.values || []).slice(1);
  return rows
    .filter(r => r[1] === userId && r[5] === "SENT")
    .map(r => ({ user: r[3] || "", asst: r[4] || "" })); // 古い→新しい（厳密に時刻で並べたい場合はA列でソート）
}

function formatRecentPairs(pairs, maxPairs = 20, charLimit = 2000) {
  const last = pairs.slice(-maxPairs).reverse(); // 新しい→古い
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
  const idx = rows.findIndex(r => r[0] === userId);
  if (idx === -1) {
    await appendRow(SUMMARIES_SHEET, [userId, summary, now]);
  } else {
    const rowIndex = idx + 2;
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

// ====== RAG：承認済みログから似た事例を参照 ======
async function readApprovedLogRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(SHEET_NAME)}!A:G`, // [timestamp, userId, displayName, userText, draft, status, rowId]
  });
  const rows = (res.data.values || []).slice(1);
  return rows.filter(r => r[3] && r[4] && r[5] === "SENT");
}

function keywordOverlapScore(a = "", b = "") {
  const tokenize = s =>
    String(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  let hit = 0;
  A.forEach(t => { if (B.has(t)) hit++; });
  return hit;
}

async function retrieveSimilarFromLogs(userText, k = 3) {
  try {
    const rows = await readApprovedLogRows();
    const ranked = rows
      .map(r => ({ row: r, score: keywordOverlapScore(userText, r[3] || "") }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(x => x.row);

    return ranked.map((r, i) => {
      const who = r[2] ? `（${r[2]}さん）` : "";
      return `【事例${i + 1}${who}】\nユーザー: ${r[3]}\n返答: ${r[4]}`;
    }).join("\n\n");
  } catch (e) {
    console.error("retrieveSimilarFromLogs error:", e?.message || e);
    return "";
  }
}

// ====== Draft 生成（親友スタイル＋文脈＋参考事例） ======
async function generateDraftWithContext(userId, userText) {
  const { longSummary, recentStr } = await buildUserContext(userId);
  const similarCases = await retrieveSimilarFromLogs(userText, 3);

  const sys = (SYSTEM_PROMPT || `
あなたは利用者にとって気軽に話せる親友のような存在です。
- 返答は短く：2〜3文。まず共感を1文、その後に具体を1つ聞き返す or 小さな提案を1つ。
- 長文や複数提案はしない。タメ口でやわらかい。絵文字は文末に1個まで（😊や🌸など）。
- 医療/法律は断定しない。必要なら専門相談をそっと促す。
- 直近ログ・長期要約・参考事例を踏まえ、自然につなげる。
- 出力フォーマット：1) 共感（1文） 2) 短い聞き返し or 小さな提案（1つだけ）。
NG：説教・断定・価値判断・絵文字乱用。
`).trim();

  const messages = [
    { role: "system", content: sys },
    { role: "system", content: `このユーザーの長期要約:\n${longSummary || "（まだ要約なし）"}` },
    { role: "system", content: `直近のやり取り（新しい→古い、最大20件）:\n${recentStr || "（履歴なし）"}` },
    ...(similarCases ? [{ role: "system", content: `参考事例（過去の承認済みログより）:\n${similarCases}` }] : []),
    { role: "user", content: userText },
  ];

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.35,
    max_tokens: 400,
    messages,
  });
  return r.choices?.[0]?.message?.content?.trim() || "うまく返せなかった…もう一度教えてほしい。";
}

// ====== 便利: rowId検索/ステータス更新 ======
async function findRowById(rowId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${qTitle(SHEET_NAME)}!A:Z`,
  });
  const rows = (res.data.values || []).slice(1);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][6] === rowId) return { index: i + 2, row: rows[i] }; // 1-based + header
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

// ====== App ======
const app = express();

// Webhook：受信→下書き生成→シートにPENDING（自動返信はしない）
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

  // プロフィール取得＆台帳更新
  let displayName = "";
  try {
    const prof = await lineClient.getProfile(userId);
    displayName = prof?.displayName || "";
  } catch {}
  await upsertUser(userId, displayName);

  // 下書き生成（文脈＋RAG）
  const draft = await generateDraftWithContext(userId, userText);

  // シートに保存（PENDING）
  const rowId = genId();
  await appendRow(SHEET_NAME, [nowJST(), userId, displayName, userText, draft, "PENDING", rowId]);

  // 管理者に承認リンク通知（任意）
  if (ADMIN_USER_ID && APPROVE_TOKEN && BASE_URL) {
    const reviewUrl = `${BASE_URL}/review?id=${rowId}&token=${APPROVE_TOKEN}`;
    try {
      await lineClient.pushMessage(ADMIN_USER_ID, {
        type: "text",
        text:
          `【承認待ち】from ${displayName || "unknown"} (${userId})\n\n` +
          `Q:\n${userText}\n\nDraft:\n${draft}\n\n` +
          `承認/却下 → ${reviewUrl}`,
      });
    } catch (e) {
      console.error("admin notify error:", e?.message || e);
    }
  }
}

// 承認レビューページ
app.get("/review", async (req, res) => {
  try {
    const { id, token } = req.query;
    if (!id || token !== APPROVE_TOKEN) return res.status(403).send("Forbidden");
    const found = await findRowById(String(id));
    if (!found) return res.status(404).send("Not found");
    const [ts, userId, displayName, userText, draft, status] = found.row;

    const approveUrl = `${BASE_URL}/approve?id=${id}&token=${APPROVE_TOKEN}`;
    const rejectUrl  = `${BASE_URL}/reject?id=${id}&token=${APPROVE_TOKEN}`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <html><body style="font-family:system-ui,sans-serif;line-height:1.6;">
        <h2>承認レビュー</h2>
        <p><b>Status:</b> ${escapeHtml(status)}</p>
        <p><b>User:</b> ${escapeHtml(displayName)} (${escapeHtml(userId)})</p>
        <p><b>Time:</b> ${escapeHtml(ts)}</p>
        <hr>
        <p><b>Message:</b><br>${escapeHtml(userText).replace(/\n/g,"<br>")}</p>
        <p><b>Draft:</b><br>${escapeHtml(draft).replace(/\n/g,"<br>")}</p>
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

// 承認：送信 & ステータス更新
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

// 却下：ステータス更新のみ
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
app.get("/", (_, res) => res.send("LINE × OpenAI × Sheets bot (context + RAG + manual approval)"));

// ====== Start ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));

