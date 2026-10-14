const micButton = document.querySelector("#mic-button");
const status = document.querySelector("#status");
const conversation = document.querySelector("#conversation");
const intro = document.querySelector("#intro");
const voiceNote = document.querySelector("#voice-note");

const history = [];
const maxRecordingSeconds = 60;
const microphonePermissionTimeoutMs = 15000;
const microphonePermissionHelp =
  "Microphone is blocked: open site settings beside the address bar, set Microphone to Allow, then refresh.";
let recordingSession;
let recordingTimer;
let isThinking = false;
let isRequestingMicrophone = false;

if (navigator.permissions?.query) {
  navigator.permissions
    .query({ name: "microphone" })
    .then((permission) => {
      if (permission.state === "denied") {
        status.textContent = "Allow microphone access in this site’s settings before speaking.";
        voiceNote.textContent = microphonePermissionHelp;
      }
    })
    .catch((error) => {
      console.warn("Could not check microphone permission:", error);
    });
}

async function getMicrophoneStream() {
  if (navigator.permissions?.query) {
    try {
      const permission = await navigator.permissions.query({ name: "microphone" });
      if (permission.state === "denied") {
        const error = new Error("Microphone access is blocked for this site.");
        error.name = "NotAllowedError";
        throw error;
      }
    } catch (error) {
      if (error.name === "NotAllowedError") {
        throw error;
      }
      console.warn("Could not check microphone permission; requesting microphone access directly:", error);
    }
  }

  let permissionTimeout;
  let permissionTimedOut = false;
  const streamRequest = navigator.mediaDevices.getUserMedia({ audio: true });
  streamRequest.then(
    (stream) => {
      if (permissionTimedOut) {
        stream.getTracks().forEach((track) => track.stop());
      }
    },
    () => {},
  );

  try {
    return await Promise.race([
      streamRequest,
      new Promise((_, reject) => {
        permissionTimeout = setTimeout(() => {
          permissionTimedOut = true;
          const error = new Error("The microphone permission request timed out.");
          error.name = "TimeoutError";
          reject(error);
        }, microphonePermissionTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(permissionTimeout);
  }
}

function setRecording(recording) {
  micButton.classList.toggle("is-listening", recording);
  micButton.setAttribute("aria-label", "Talk to AURA");
  document.body.dataset.state = recording ? "listening" : "idle";
  status.textContent = recording
    ? "Listening… Tap the microphone when you’re finished"
    : "Finishing your question…";
}

function addMessage(text, sender, isError = false) {
  intro.hidden = true;
  conversation.hidden = false;

  const message = document.createElement("div");
  message.className = `message message-${sender}${isError ? " message-error" : ""}`;
  message.textContent = text;
  conversation.append(message);
  conversation.scrollTop = conversation.scrollHeight;
  return message;
}

function speak(text) {
  if (!("speechSynthesis" in window)) {
    document.body.dataset.state = "idle";
    status.textContent = "Your browser does not support spoken replies.";
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language || "en-US";
  utterance.addEventListener("start", () => {
    if (!isThinking) {
      status.textContent = "AURA is speaking…";
    }
  });
  utterance.addEventListener("end", () => {
    if (!isThinking) {
      document.body.dataset.state = "idle";
      status.textContent = "Tap the microphone to ask another question";
    }
  });
  utterance.addEventListener("error", (event) => {
    console.error("Could not speak the response:", event.error);
    document.body.dataset.state = "error";
    status.textContent = "I’ve shown my answer above, but couldn’t play the spoken reply.";
  });
  window.speechSynthesis.speak(utterance);
}

function readAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read the microphone recording."));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    });
    reader.addEventListener("error", () => reject(new Error("Could not read the microphone recording.")));
    reader.readAsDataURL(blob);
  });
}

function createWavRecording(audioChunks, sourceSampleRate) {
  const totalFrameCount = audioChunks.reduce((total, chunk) => total + chunk.length, 0);
  if (totalFrameCount / sourceSampleRate < 0.25) {
    throw new Error("Your recording was too short. Please speak for a moment and try again.");
  }

  const sourceSamples = new Float32Array(totalFrameCount);
  let writeOffset = 0;
  for (const chunk of audioChunks) {
    sourceSamples.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  const targetSampleRate = 16000;
  const targetFrameCount = Math.ceil((totalFrameCount * targetSampleRate) / sourceSampleRate);
  const samples = new Float32Array(targetFrameCount);
  let peakLevel = 0;

  for (let index = 0; index < targetFrameCount; index += 1) {
    const start = Math.min(
      totalFrameCount - 1,
      Math.floor((index * sourceSampleRate) / targetSampleRate),
    );
    const end = Math.min(
      totalFrameCount,
      Math.max(start + 1, Math.floor(((index + 1) * sourceSampleRate) / targetSampleRate)),
    );
    let sample = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sample += sourceSamples[sourceIndex];
    }
    samples[index] = sample / (end - start);
    peakLevel = Math.max(peakLevel, Math.abs(samples[index]));
  }

  if (peakLevel < 0.004) {
    throw new Error("AURA didn’t receive your voice. Check your microphone and speak a little closer.");
  }

  const wavBuffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(wavBuffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Blob([wavBuffer], { type: "audio/wav" });
}

async function requestAssistant(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The assistant server returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(result.error || "AURA could not answer. Please try again.");
  }
  return result;
}

async function askAssistant(text) {
  if (isThinking) {
    return;
  }

  isThinking = true;
  micButton.disabled = true;
  document.body.dataset.state = "thinking";
  status.textContent = "AURA is thinking…";
  const historySnapshot = history.slice();

  try {
    const result = await requestAssistant("/api/chat", { message: text, history: historySnapshot });
    if (typeof result.answer !== "string" || result.answer.trim().length === 0) {
      throw new Error("AURA returned an empty answer. Please try again.");
    }

    const answer = result.answer.trim();
    history.push({ role: "user", text }, { role: "model", text: answer });
    if (history.length > 12) {
      history.splice(0, history.length - 12);
    }
    addMessage(text, "user");
    addMessage(answer, "assistant");
    document.body.dataset.state = "speaking";
    status.textContent = "AURA is speaking…";
    speak(answer);
  } catch (error) {
    addMessage(error.message, "assistant", true);
    document.body.dataset.state = "error";
    status.textContent = error.message;
    speak(error.message);
  } finally {
    isThinking = false;
    micButton.disabled = false;
    if (!window.speechSynthesis?.speaking) {
      document.body.dataset.state = "idle";
    }
  }
}

async function askWithRecording(blob) {
  if (!blob.size) {
    status.textContent = "I didn’t receive any audio. Tap the microphone and try again.";
    return;
  }

  isThinking = true;
  micButton.disabled = true;
  document.body.dataset.state = "thinking";
  status.textContent = "AURA is listening to your question…";

  try {
    status.textContent = "Preparing your recording…";
    if (blob.size > 5 * 1024 * 1024) {
      throw new Error("That recording is too large. Please keep your question under 60 seconds.");
    }
    const audio = await readAsBase64(blob);
    status.textContent = "AURA is listening to your question…";
    const result = await requestAssistant("/api/voice", {
      audio,
      mimeType: blob.type,
      history: history.slice(),
    });
    if (
      typeof result.transcript !== "string" ||
      !result.transcript.trim() ||
      typeof result.answer !== "string" ||
      !result.answer.trim()
    ) {
      throw new Error("AURA couldn’t understand that recording. Please try again.");
    }

    const transcript = result.transcript.trim();
    const answer = result.answer.trim();
    history.push({ role: "user", text: transcript }, { role: "model", text: answer });
    if (history.length > 12) {
      history.splice(0, history.length - 12);
    }
    addMessage(transcript, "user");
    addMessage(answer, "assistant");
    document.body.dataset.state = "speaking";
    status.textContent = "AURA is speaking…";
    speak(answer);
  } catch (error) {
    addMessage(error.message, "assistant", true);
    document.body.dataset.state = "error";
    status.textContent = error.message;
    speak(error.message);
  } finally {
    isThinking = false;
    micButton.disabled = false;
    if (!window.speechSynthesis?.speaking) {
      document.body.dataset.state = "idle";
    }
  }
}

async function startRecording() {
  if (isRequestingMicrophone) {
    return;
  }
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (
    !navigator.mediaDevices?.getUserMedia ||
    !AudioContextClass ||
    !AudioContextClass.prototype.createScriptProcessor
  ) {
    status.textContent = "Audio recording isn’t supported here. Open AURA in Chrome or Edge.";
    voiceNote.textContent = "Audio recording requires a supported browser and microphone permission.";
    return;
  }

  isRequestingMicrophone = true;
  micButton.disabled = true;
  let stream;
  let audioContext;
  try {
    audioContext = new AudioContextClass();
    await audioContext.resume();
    stream = await getMicrophoneStream();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silence = audioContext.createGain();
    const audioChunks = [];
    silence.gain.value = 0;
    processor.onaudioprocess = (event) => {
      audioChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      event.outputBuffer.getChannelData(0).fill(0);
    };
    source.connect(processor);
    processor.connect(silence);
    silence.connect(audioContext.destination);
    recordingSession = { stream, audioContext, source, processor, silence, audioChunks };
    setRecording(true);
    recordingTimer = setTimeout(() => {
      if (recordingSession) {
        status.textContent = "Recording limit reached. Sending your question…";
        void stopRecording();
      }
    }, maxRecordingSeconds * 1000);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }
    console.error("Could not access the microphone:", error);
    const message =
      error.name === "NotAllowedError" || error.name === "SecurityError"
        ? "Microphone access is blocked. Allow it in your browser’s site settings, then try again."
        : error.name === "NotFoundError" || error.name === "DevicesNotFoundError"
          ? "No microphone was found. Connect a microphone and try again."
          : error.name === "TimeoutError"
            ? "Microphone access is still waiting for permission. Allow it in your browser prompt and try again."
          : "Could not start the microphone. Check it is connected and try again.";
    status.textContent = message;
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      voiceNote.textContent = microphonePermissionHelp;
    }
    document.body.dataset.state = "error";
  } finally {
    isRequestingMicrophone = false;
    micButton.disabled = isThinking;
  }
}

async function stopRecording() {
  const session = recordingSession;
  if (!session) {
    return;
  }

  clearTimeout(recordingTimer);
  recordingSession = undefined;
  setRecording(false);
  session.processor.onaudioprocess = null;
  session.source.disconnect();
  session.processor.disconnect();
  session.silence.disconnect();
  session.stream.getTracks().forEach((track) => track.stop());
  try {
    await session.audioContext.close();
  } catch (error) {
    console.error("Could not close the microphone audio context:", error);
  }

  try {
    const recording = createWavRecording(session.audioChunks, session.audioContext.sampleRate);
    void askWithRecording(recording);
  } catch (error) {
    document.body.dataset.state = "error";
    status.textContent = error.message;
  }
}

micButton.addEventListener("click", () => {
  if (isThinking || isRequestingMicrophone) {
    return;
  }

  if (recordingSession) {
    void stopRecording();
    return;
  }

  void startRecording();
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    if (!isThinking && !isRequestingMicrophone && !recordingSession) {
      void askAssistant(button.dataset.prompt);
    }
  });
});
