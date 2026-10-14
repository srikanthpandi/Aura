import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const publicDirectory = resolve("public");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";
const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const fallbackModel = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.5-flash-lite";
const maxRequestBytes = 8 * 1024 * 1024;
const maxAudioBytes = 5 * 1024 * 1024;
const maxHistoryItems = 12;
const maxTextLength = 5000;
const maxGeminiAttempts = 3;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getRetryDelay(response, attempt) {
  const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 5000);
  }
  return attempt * 1000;
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readRequestJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      return { error: "Request is too large." };
    }
    chunks.push(chunk);
  }

  try {
    return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { error: "Request body must be valid JSON." };
  }
}

function validateChatRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  if (
    typeof body.message !== "string" ||
    body.message.trim().length === 0 ||
    body.message.length > maxTextLength
  ) {
    return `Message must contain between 1 and ${maxTextLength} characters.`;
  }

  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > maxHistoryItems) {
    return `History must contain no more than ${maxHistoryItems} messages.`;
  }

  for (const item of history) {
    if (
      item === null ||
      typeof item !== "object" ||
      !["user", "model"].includes(item.role) ||
      typeof item.text !== "string" ||
      item.text.trim().length === 0 ||
      item.text.length > maxTextLength
    ) {
      return "History contains an invalid message.";
    }
  }

  return null;
}

async function generateContent(contents, generationConfig) {
  const models = [...new Set([model, fallbackModel])];
  let upstream;
  let respondingModel = model;
  modelAttempts: for (const [modelIndex, currentModel] of models.entries()) {
    respondingModel = currentModel;
    for (let attempt = 1; attempt <= maxGeminiAttempts; attempt += 1) {
      try {
        upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(currentModel)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": process.env.GEMINI_API_KEY,
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [
                  {
                    text: "You are AURA, a helpful, friendly voice assistant. Answer clearly and conversationally. Keep spoken answers concise unless the user asks for detail.",
                  },
                ],
              },
              contents,
              generationConfig,
            }),
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (error) {
        throw new Error(
          error.name === "TimeoutError"
            ? "Gemini took too long to respond. Please try again."
            : "Could not reach Gemini. Check your internet connection and try again.",
        );
      }

      if (![429, 500, 502, 503, 504].includes(upstream.status)) {
        break modelAttempts;
      }
      if (attempt === maxGeminiAttempts) {
        if (modelIndex === models.length - 1) {
          break modelAttempts;
        }
        console.warn(
          `${currentModel} is temporarily busy; trying fallback model ${models[modelIndex + 1]}.`,
        );
        break;
      }

      await wait(getRetryDelay(upstream, attempt));
    }
    if (upstream.ok) {
      break;
    }
    if (![429, 500, 502, 503, 504].includes(upstream.status)) {
      break;
    }
  }

  return { upstream, respondingModel };
}

async function readGeminiResult(response, upstream, respondingModel) {
  let result;
  try {
    result = await upstream.json();
  } catch {
    sendJson(response, 502, { error: "Gemini returned an unreadable response." });
    return null;
  }

  if (!upstream.ok) {
    const message = result.error?.message;
    console.error(`${respondingModel} API returned ${upstream.status}: ${message ?? "unknown error"}`);
    sendJson(response, 502, {
      error:
        upstream.status === 401 || upstream.status === 403
          ? "Gemini rejected the API key. Check GEMINI_API_KEY in your .env file."
          : [429, 500, 502, 503, 504].includes(upstream.status)
            ? "Gemini is still busy after trying the backup model. Please wait a minute and try again."
            : message ?? "Gemini could not answer right now. Please try again.",
    });
    return null;
  }
  return result;
}

function getResponseText(result) {
  return result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter((text) => typeof text === "string")
    .join("")
    .trim();
}

async function handleChat(request, response) {
  if (!process.env.GEMINI_API_KEY) {
    sendJson(response, 503, {
      error: "Add your Gemini API key to the .env file, then restart the assistant.",
    });
    return;
  }

  const { data, error } = await readRequestJson(request);
  if (error) {
    sendJson(response, error === "Request is too large." ? 413 : 400, { error });
    return;
  }

  const validationError = validateChatRequest(data);
  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  const contents = [
    ...(data.history ?? []).map(({ role, text }) => ({
      role,
      parts: [{ text }],
    })),
    { role: "user", parts: [{ text: data.message.trim() }] },
  ];

  let generation;
  try {
    generation = await generateContent(contents, { maxOutputTokens: 800 });
  } catch (error) {
    sendJson(response, 502, { error: error.message });
    return;
  }

  const result = await readGeminiResult(response, generation.upstream, generation.respondingModel);
  if (!result) {
    return;
  }

  const answer = getResponseText(result);

  if (!answer) {
    sendJson(response, 502, {
      error: "Gemini did not return an answer. Please try asking another way.",
    });
    return;
  }

  sendJson(response, 200, { answer });
}

function validateVoiceRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  if (
    typeof body.audio !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio) ||
    body.audio.length % 4 !== 0
  ) {
    return "The microphone recording is missing or invalid. Please record your question again.";
  }
  if (Buffer.byteLength(body.audio, "base64") > maxAudioBytes) {
    return "That recording is too large. Please keep your question under 60 seconds and try again.";
  }

  const mimeType = typeof body.mimeType === "string" ? body.mimeType.split(";")[0].trim() : "";
  if (
    ![
      "audio/aac",
      "audio/flac",
      "audio/m4a",
      "audio/mp3",
      "audio/mp4",
      "audio/mpeg",
      "audio/mpga",
      "audio/ogg",
      "audio/wav",
      "audio/webm",
      "audio/x-m4a",
    ].includes(mimeType)
  ) {
    return "This browser’s audio format isn’t supported. Try Chrome or Edge.";
  }

  const historyError = validateChatRequest({ message: "voice input", history: body.history ?? [] });
  if (historyError) {
    return historyError;
  }
  return null;
}

async function handleVoice(request, response) {
  if (!process.env.GEMINI_API_KEY) {
    sendJson(response, 503, {
      error: "Add your Gemini API key to the .env file, then restart the assistant.",
    });
    return;
  }

  const { data, error } = await readRequestJson(request);
  if (error) {
    sendJson(response, error === "Request is too large." ? 413 : 400, { error });
    return;
  }

  const validationError = validateVoiceRequest(data);
  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  const mimeType = data.mimeType.split(";")[0].trim();
  const contents = [
    ...(data.history ?? []).map(({ role, text }) => ({
      role,
      parts: [{ text }],
    })),
    {
      role: "user",
      parts: [
        {
          text: "The attached audio is the user's spoken message. Listen to it, transcribe their exact words in their original language, and answer their question conversationally. You can process the attached audio; do not claim to be text-only or ask the user to type. Return both the transcript and answer.",
        },
        { inlineData: { mimeType, data: data.audio } },
      ],
    },
  ];

  let generation;
  try {
    generation = await generateContent(contents, {
      maxOutputTokens: 1200,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          transcript: { type: "STRING" },
          answer: { type: "STRING" },
        },
        required: ["transcript", "answer"],
        propertyOrdering: ["transcript", "answer"],
      },
    });
  } catch (error) {
    sendJson(response, 502, { error: error.message });
    return;
  }

  const result = await readGeminiResult(response, generation.upstream, generation.respondingModel);
  if (!result) {
    return;
  }

  const responseText = getResponseText(result);
  let answer;
  try {
    answer = JSON.parse(responseText);
  } catch {
    sendJson(response, 502, { error: "AURA couldn’t understand that recording. Please try again." });
    return;
  }

  if (
    typeof answer?.transcript !== "string" ||
    typeof answer?.answer !== "string"
  ) {
    sendJson(response, 502, { error: "AURA couldn’t understand that recording. Please try again." });
    return;
  }

  const transcript = answer.transcript.trim();
  const reply = answer.answer.trim();
  if (!transcript || !reply) {
    sendJson(response, 502, { error: "AURA couldn’t understand that recording. Please try again." });
    return;
  }

  if (
    /(?:i(?:'m| am) )?(?:unable|not able|cannot|can't|can not) (?:to )?(?:listen|hear|access|transcribe).{0,100}audio|text[- ]based ai|provide the text of what you said/i.test(
      `${transcript} ${reply}`,
    )
  ) {
    sendJson(response, 502, {
      error: "Gemini couldn’t understand that recording. Please speak clearly and try again.",
    });
    return;
  }

  sendJson(response, 200, {
    transcript,
    answer: reply,
  });
}

async function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  const filePath = resolve(publicDirectory, `.${decodedPath === "/" ? "/index.html" : decodedPath}`);
  const fileRelativePath = relative(publicDirectory, filePath);
  if (fileRelativePath.startsWith(`..${sep}`) || fileRelativePath === "..") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  let content;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    throw error;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(request.method === "HEAD" ? undefined : content);
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/api/chat") {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }

    handleChat(request, response).catch((error) => {
      console.error("Unexpected error handling chat request:", error);
      sendJson(response, 500, { error: "The assistant encountered an unexpected error." });
    });
    return;
  }

  if (url.pathname === "/api/voice") {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }

    handleVoice(request, response).catch((error) => {
      console.error("Unexpected error handling voice request:", error);
      sendJson(response, 500, { error: "AURA had trouble processing that recording. Please try again." });
    });
    return;
  }

  serveStatic(request, response, url.pathname).catch((error) => {
    console.error("Unexpected error serving a static file:", error);
    if (!response.headersSent) {
      response.writeHead(500);
    }
    response.end("Internal server error");
  });
});

server.listen(port, host, () => {
  console.log(`AURA is ready at http://${host}:${port}`);
});
