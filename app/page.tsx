"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
const API_URL = process.env.NEXT_API_URL;

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [userTranscript, setUserTranscript] = useState("");
  const [assistantReply, setAssistantReply] = useState("");
  const [input, setInput] = useState("");
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState("");
  const [isThinking, setIsThinking] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const animationRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function stopVisualizer() {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    analyserRef.current = null;
    setVolume(0);

    const context = audioContextRef.current;
    audioContextRef.current = null;

    if (context && context.state !== "closed") {
      void context.close();
    }
  }

  function startVisualizer(stream: MediaStream) {
    const context = new AudioContext();
    const analyser = context.createAnalyser();

    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);

    audioContextRef.current = context;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);

    function updateVolume() {
      if (!analyserRef.current) return;

      analyser.getByteTimeDomainData(data);

      let sum = 0;

      for (const sample of data) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / data.length);

      setVolume(Math.min(1, rms * 5));

      animationRef.current = requestAnimationFrame(updateVolume);
    }

    void context.resume().then(() => {
      updateVolume();
    });
  }

  async function sendMessageToGrok(message: string) {
    setIsThinking(true);
    setAssistantReply("");
    setError("");

    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });

      if (!response.ok) {
        throw new Error(`Grok request failed: ${response.status}`);
      }

      const data: { reply: string } = await response.json();

      setAssistantReply(data.reply);
      await speakReply(data.reply);
    } catch (err) {
      console.error("Grok request failed:", err);
      setError("I couldn't get a response. Please try again.");
    } finally {
      setIsThinking(false);
    }
  }

  async function startRecording() {
    let stream: MediaStream | null = null;

    try {
      setError("");
      setUserTranscript("");
      setAssistantReply("");

      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);

      recorderRef.current = recorder;

      try {
        startVisualizer(stream);
      } catch (visualizerError) {
        console.warn("Audio visualization unavailable:", visualizerError);
      }

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      });

      recorder.addEventListener(
        "stop",
        async () => {
          stopVisualizer();

          stream?.getTracks().forEach((track) => track.stop());

          const blob = new Blob(chunks, {
            type: recorder.mimeType || "audio/webm",
          });

          if (!blob.size) {
            setError("No audio was recorded. Please try again.");
            return;
          }

          // This request may consume ElevenLabs credits.
          setIsTranscribing(true);

          try {
            const formData = new FormData();
            formData.append("audio", blob, "recording.webm");

            const response = await fetch(
              "`${API_URL}/transcribe`",
              {
                method: "POST",
                body: formData,
              }
            );

            if (!response.ok) {
              throw new Error(
                `Transcription failed: ${response.status}`
              );
            }

            const data: { text: string } = await response.json();
            const message = data.text.trim();

            setUserTranscript(message);

            if (message) {
              // This request may consume Groq API usage.
              await sendMessageToGrok(message);
            } else {
              setError("No speech was detected. Please try again.");
            }
          } catch (err) {
            console.error("Voice request failed:", err);
            setError(
              "I couldn't process your voice. Check your backend and try again."
            );
          } finally {
            setIsTranscribing(false);
          }
        },
        { once: true }
      );

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error(err);

      stopVisualizer();
      stream?.getTracks().forEach((track) => track.stop());

      setError(
        "Microphone access failed. Check your browser permissions."
      );
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }

    setIsRecording(false);
  }

  function handleMicClick() {
    if (isRecording) {
      stopRecording();
    } else if (!isTranscribing && !isThinking) {
      void startRecording();
    }
  }

  async function handleTextSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    const message = input.trim();

    if (
      !message ||
      isTranscribing ||
      isRecording ||
      isThinking
    ) {
      return;
    }

    setUserTranscript(message);
    setInput("");

    await sendMessageToGrok(message);
  }

  useEffect(() => {
    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }

      const context = audioContextRef.current;

      if (context && context.state !== "closed") {
        void context.close();
      }

      recorderRef.current?.stream
        .getTracks()
        .forEach((track) => track.stop());
    };
  }, []);

  const status = isRecording
    ? "LISTENING"
    : isTranscribing
      ? "TRANSCRIBING"
      : isThinking
        ? "THINKING"
        : "READY";

  const orbScale = 1 + volume * 0.16;
  const orbGlow = 20 + volume * 65;


async function speakReply(text: string) {
  try {
    const response = await fetch(`${API_URL}/speak`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error(`Speech request failed: ${response.status}`);
    }

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
audioRef.current = audio;

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
    };

    audio.onended = () => {
  URL.revokeObjectURL(audioUrl);

  if (audioRef.current === audio) {
    audioRef.current = null;
  }
};

audio.onerror = () => {
  URL.revokeObjectURL(audioUrl);

  if (audioRef.current === audio) {
    audioRef.current = null;
  }

  console.error("Morrow's audio could not be played.");
};

    await audio.play();
  } catch (err) {
    console.error("Text-to-speech failed:", err);
    setError("Morrow couldn't speak this response. Please try again.");
  }
}
  return (
    <main className="relative flex h-dvh flex-col overflow-hidden bg-[#f7f5ed] text-[#27271f]">
      {/* Subtle paper texture */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(rgba(100,94,72,0.13) 0.65px, transparent 0.65px)",
          backgroundSize: "8px 8px",
        }}
      />

      {/* Header */}
      <header className="relative z-10 grid h-17 shrink-0 grid-cols-2 items-center px-5 sm:grid-cols-3 sm:px-9">
        <div className="flex items-center gap-3">
          <svg
            viewBox="0 0 30 30"
            fill="none"
            className="h-6 w-6 text-[#92957b]"
            aria-hidden="true"
          >
            <path
              d="M5 23V7H10L15 18L20 7H25V23"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          <span className="font-serif text-xl tracking-tight">
            Morrow
          </span>
        </div>

        <div className="hidden items-center justify-center gap-2 sm:flex">
          <span className="text-[10px] font-semibold tracking-[0.2em] text-[#929286]">
            {status}
          </span>
        </div>

        <div className="flex items-center justify-end gap-5">
          <button
            type="button"
            title="Clear conversation"
            aria-label="Clear conversation"
            onClick={() => {
               if (audioRef.current) {
  audioRef.current.pause();
  audioRef.current.currentTime = 0;
  audioRef.current = null;
}
              setUserTranscript("");
              setAssistantReply("");
              setError("");
              setInput("");
            }}
            className="text-[#929286] transition hover:text-[#27271f]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-5 w-5"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7V12L15 14" />
            </svg>
          </button>

          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            className="text-[#929286] transition hover:text-[#27271f]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-5 w-5"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4 7H20M4 17H20" />
              <circle cx="9" cy="7" r="2" />
              <circle cx="15" cy="17" r="2" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main workspace */}
      <section className="relative z-10 mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col items-center px-6 pb-5 sm:px-10">
        {/* Voice orb */}
        <div className="relative mt-1 flex w-full max-w-40 shrink-0 items-center justify-center sm:mt-2">
          <div
            className="relative aspect-square w-full"
            style={{
              transform: `scale(${1 + volume * 0.035})`,
              transition: "transform 100ms linear",
            }}
          >
            {Array.from({ length: 13 }, (_, index) => {
              const inset = index * 3.1;
              const rotation = index * 7;

              return (
                <div
                  key={index}
                  className="absolute rounded-[44%_56%_48%_52%] border border-[#c8c7ae]"
                  style={{
                    inset: `${inset}px`,
                    transform: `rotate(${rotation}deg) scale(${orbScale})`,
                    opacity: 0.22 + (index / 13) * 0.38,
                    boxShadow:
                      volume > 0.04
                        ? `0 0 ${orbGlow * 0.15}px rgba(146,149,123,${volume * 0.2})`
                        : "none",
                    transition:
                      "transform 100ms linear, box-shadow 100ms linear",
                  }}
                />
              );
            })}

            <div className="absolute inset-0 grid place-items-center">
              <div
                className={`h-12 w-12 rounded-[45%_55%_48%_52%] bg-white/40 blur-md ${
                  isTranscribing || isThinking ? "animate-pulse" : ""
                }`}
              />
            </div>
          </div>
        </div>

        {/* Assistant response and transcript */}
        <div className="flex min-h-0 w-full max-w-2xl flex-1 flex-col py-3">
          {/* Section label outside the border */}
          <p className="mb-3 shrink-0 text-center text-[9px] font-semibold tracking-[0.24em] text-[#a09f91]">
            {isRecording
              ? "LISTENING TO YOU"
              : isTranscribing
                ? "PROCESSING YOUR VOICE"
                : isThinking
                  ? "MORROW IS THINKING"
                  : assistantReply
                    ? "MORROW"
                    : "YOUR VOICE COMPANION"}
          </p>

          {/* Bordered, scrollable response panel */}
          <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto overscroll-contain rounded-2xl border border-[#e3dfd2] bg-white/25 px-5 py-4 text-left shadow-sm scrollbar-thin [scrollbar-color:#c8c7ae_transparent] sm:px-7 sm:py-5">
            {userTranscript && (
              <div className="mb-5">
                <p className="mb-2 text-[9px] font-semibold tracking-[0.2em] text-[#a09f91]">
                  YOU
                </p>

                <p className="whitespace-pre-wrap text-sm leading-7 text-[#77766b]">
                  {userTranscript}
                </p>
              </div>
            )}

            {isThinking && (
              <p className="text-sm text-[#929286]">
                Morrow is thinking...
              </p>
            )}

            {assistantReply && (
              <div>
                <p className="mb-2 text-[9px] font-semibold tracking-[0.2em] text-[#92957b]">
                  MORROW
                </p>

                <div className="prose prose-sm max-w-none text-[#3b3a33] prose-headings:font-serif prose-headings:font-normal prose-p:leading-7 prose-strong:text-[#27271f]">
                  <ReactMarkdown>{assistantReply}</ReactMarkdown>
                </div>
              </div>
            )}

            {!userTranscript &&
              !assistantReply &&
              !isThinking &&
              !error && (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-center text-sm text-[#a09f91]">
                    Your conversation will appear here.
                  </p>
                </div>
              )}
          </div>
        </div>

        {/* Microphone */}
        <div className="flex shrink-0 flex-col items-center">
          <button
            type="button"
            onClick={handleMicClick}
            disabled={isTranscribing || isThinking}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
            className={`grid h-19 w-19 place-items-center rounded-full transition duration-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#92957b] disabled:cursor-wait disabled:opacity-70 sm:h-22 sm:w-22 ${
              isRecording
                ? "scale-105 bg-[#a75f50] text-white shadow-[0_0_0_10px_rgba(167,95,80,0.09)]"
                : "bg-[#22221f] text-[#fffef8] hover:scale-105 hover:shadow-xl"
            }`}
          >
            {isTranscribing || isThinking ? (
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            ) : isRecording ? (
              <span className="h-5 w-5 rounded-sm bg-white" />
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="h-8 w-8"
                aria-hidden="true"
              >
                <rect
                  x="9"
                  y="3"
                  width="6"
                  height="12"
                  rx="3"
                  stroke="currentColor"
                  strokeWidth="1.7"
                />
                <path
                  d="M5 11V12A7 7 0 0 0 19 12V11M12 19V22M9 22H15"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>

          <p className="mt-4 text-center text-[9px] font-semibold tracking-[0.19em] text-[#a09f92]">
            {isRecording
              ? "TAP TO FINISH"
              : isTranscribing
                ? "TRANSCRIBING"
                : isThinking
                  ? "THINKING"
                  : "TAP TO SPEAK"}
          </p>
        </div>

        {/* Errors */}
        {error && (
          <p
            role="alert"
            className="mt-3 max-w-lg shrink-0 text-center text-xs text-[#a34f43]"
          >
            {error}
          </p>
        )}

        {/* Text input */}
        <form
          onSubmit={handleTextSubmit}
          className="mt-5 flex min-h-13.5 w-full max-w-2xl shrink-0 items-center gap-3 rounded-full border border-[#e3dfd2] bg-[#ebe8dc]/80 py-1.5 pl-5 pr-2 transition focus-within:border-[#c2c0a8] sm:mt-6"
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Or type instead..."
            aria-label="Type a message"
            className="min-w-0 flex-1 bg-transparent text-sm text-[#3b3a33] outline-none placeholder:text-[#a29f92]"
          />

          <button
            type="submit"
            disabled={
              !input.trim() ||
              isRecording ||
              isTranscribing ||
              isThinking
            }
            aria-label="Submit message"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#dcd8c9] text-[#59584d] transition hover:bg-[#ccc8b7] disabled:cursor-default disabled:opacity-50"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path
                d="M12 19V5M6 11L12 5L18 11"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>

        <p className="mt-3 flex shrink-0 items-center justify-center gap-2 text-center text-[8px] font-semibold tracking-[0.15em] text-[#aaa89c] sm:text-[9px]">
          GROQ CONNECTED · VOICE READY
        </p>
      </section>
    </main>
  );
}