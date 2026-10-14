# AURA voice assistant
https://aura-voice-assistant-84z5.onrender.com
<br>
AURA is a local browser-based voice assistant. It uses Gemini to understand spoken questions and answer them, and your browser's speech synthesis to speak replies.

## Requirements

- Node.js 22.9 or newer
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- A browser that supports microphone recording and permission prompts (Chrome or Edge recommended)

## Run locally

1. Copy `.env.example` to `.env`.
2. Replace `replace-with-your-gemini-api-key` with your Gemini API key.
3. In this folder, run:

   ```powershell
   npm start
   ```

4. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in Chrome or Edge and allow microphone access when prompted. Use the same address each time because browsers keep microphone permissions separately for `127.0.0.1` and `localhost`.

The API key stays in the local server's `.env` file and is not sent to browser code. Do not share or commit `.env`. Gemini API usage may incur charges depending on your Google account and plan.

If Gemini is overloaded, AURA retries and then automatically tries the `GEMINI_FALLBACK_MODEL`, which defaults to `gemini-3.5-flash-lite`. You can change the primary model with `GEMINI_MODEL`, the fallback with `GEMINI_FALLBACK_MODEL`, or the local server port with `PORT` in `.env`; restart the server after changing settings.

## Deploy to Render

The included `render.yaml` configures a free Render web service in Singapore. Push this project to a GitHub repository, then in Render choose **New > Blueprint** and connect that repository. Render will prompt for `GEMINI_API_KEY`; enter it as a secret environment variable in Render, never in the repository or `render.yaml`. Render provides HTTPS and sets the service port automatically. The app binds to `127.0.0.1` locally and to `0.0.0.0` on Render.

The deployed page is accessible to anyone with its URL. Requests to the public voice and chat endpoints use your Gemini API key and may consume your quota or incur charges. Configure usage limits in Google AI Studio and review Render's current free-service limits before deploying.

## Voice support

Voice input captures microphone audio directly in the browser and needs microphone permission. Tap the microphone to start speaking, then tap it again to send your question (recordings are limited to 60 seconds). AURA converts the captured audio to mono WAV before sending it to Gemini for transcription and an answer. AURA speaks the answer using the browser's built-in speech synthesis.
