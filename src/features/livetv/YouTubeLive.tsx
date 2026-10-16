import { useEffect, useRef } from "react";
import type { Embed } from "./useHlsStream";

const ORIGIN = "https://www.youtube.com";
/** How long a live stream may take to start before NOVA tries the next one. */
const START_TIMEOUT_MS = 20_000;

/**
 * A Twitch live stream in Twitch's embedded player. Twitch doesn't tell the
 * page whether it plays, so the stream is taken as tuned once the player has
 * loaded (NOVA's signal check already confirmed it's live). Muting reloads it
 * with Twitch's own `muted` setting.
 */
export function TwitchPlayer({ embed, muted, className = "" }: { embed: Embed; muted: boolean; className?: string }) {
  const report = useRef(embed.report);
  report.current = embed.report;
  useEffect(() => {
    const timeout = window.setTimeout(() => report.current(false), START_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [embed.src]);
  const src = `${embed.src}&muted=${muted}`;
  return (
    <iframe
      key={src}
      src={src}
      title="Twitch en directo"
      allow="autoplay; encrypted-media"
      tabIndex={-1}
      onLoad={() => window.setTimeout(() => report.current(true), 1500)}
      className={`pointer-events-none border-0 bg-black ${className}`}
    />
  );
}

/**
 * An official YouTube live stream in YouTube's own embedded player. It can't be
 * clicked or focused (the TV keeps the keyboard and the remote); NOVA learns
 * whether it plays from the player's standard postMessage events.
 */
export function YouTubeLive({ embed, muted, className = "" }: { embed: Embed; muted: boolean; className?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const report = useRef(embed.report);
  report.current = embed.report;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const post = (message: object) => frame.current?.contentWindow?.postMessage(JSON.stringify(message), ORIGIN);
  const command = (func: string) => post({ event: "command", func, args: [] });

  useEffect(() => {
    let heard = false;
    const timeout = window.setTimeout(() => report.current(false), START_TIMEOUT_MS);
    // The player only talks once asked to; keep asking until it answers.
    const hello = window.setInterval(() => {
      if (heard) return window.clearInterval(hello);
      post({ event: "listening", id: "nova", channel: "widget" });
    }, 700);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== ORIGIN || e.source !== frame.current?.contentWindow) return;
      let data: { event?: string; info?: unknown } | null = null;
      try {
        data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!data?.event) return;
      if (!heard) {
        heard = true;
        command(mutedRef.current ? "mute" : "unMute");
      }
      const state = data.event === "onStateChange" ? data.info : data.event === "infoDelivery" ? (data.info as { playerState?: number } | null)?.playerState : undefined;
      if (state === 1) {
        window.clearTimeout(timeout);
        report.current(true);
      } else if (data.event === "onError") {
        window.clearTimeout(timeout);
        report.current(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(hello);
      window.removeEventListener("message", onMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embed.src]);

  useEffect(() => {
    command(muted ? "mute" : "unMute");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted]);

  return (
    <iframe
      ref={frame}
      key={embed.src}
      src={embed.src}
      title="Emisión en directo"
      allow="autoplay; encrypted-media"
      referrerPolicy="strict-origin-when-cross-origin"
      tabIndex={-1}
      className={`pointer-events-none border-0 bg-black ${className}`}
    />
  );
}
