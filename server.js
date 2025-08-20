import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import OpenAI from "openai";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const lineClient = new Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LINE Webhook受け口
app.post("/callback", middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("handler error:", e);
    res.sendStatus(500);
  }
});

// テキストのみ処理（履歴なし：毎回 System + User）
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const userText = event.message.text;

  const systemPrompt =
    "あなたは優しい悩み相談カウンセラー。否定せず共感→状況確認→小さな提案の順で、200〜300字で返答。医療や法律は断定しない。";

  let reply = "ごめんね、いま上手く返答を作れないみたい。もう一度送ってみてね。";

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

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: reply.slice(0, 4000)
  });
}

// 動作確認用
app.get("/", (_, res) => res.send("LINE × OpenAI bot on Render"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server listening on", PORT));
