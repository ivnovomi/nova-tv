import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../lib/api";
import type { Library, Screen, Shortcut } from "../lib/types";
import { liveTv, onAir, useLiveTv } from "../features/livetv/store";
import { power } from "./power";

interface Bridge {
  library: Library | null;
  screen: Screen;
  launch: (s: Shortcut) => void;
  playVideo: (videoId: string, position?: number) => void;
}

/**
 * Connects NOVA to the phone remote: runs what the phone asks for (through the
 * same code paths as the TV interface) and tells the phone what's on.
 */
export function useRemoteBridge({ library, screen, launch, playVideo }: Bridge) {
  const tv = useLiveTv();
  const latest = useRef({ library, launch, playVideo });
  latest.current = { library, launch, playVideo };

  useEffect(() => {
    if (!inTauri) return;
    const offs = [
      listen<{ action: string; id?: string; number?: number }>("remote-tv", ({ payload }) => {
        // Under the screensaver the phone only wakes it (it brings the TV back itself).
        if (power.isSaving()) return power.screensaver(false);
        switch (payload.action) {
          case "up":
          case "down":
            void liveTv.open().then(() => liveTv.zap(payload.action === "up" ? 1 : -1));
            break;
          case "tune":
            if (payload.id) liveTv.play(payload.id);
            break;
          case "number":
            if (payload.number) {
              void liveTv.open().then(() => liveTv.tuneNumber(payload.number!));
            }
            break;
          case "open":
            void liveTv.open();
            break;
          case "minimize":
            liveTv.minimize();
            break;
          case "off":
            liveTv.close();
            break;
          // The list is the guide too. TvMode opens the panel once it has turned on.
          case "guide":
          case "list":
            liveTv.showPanel("guide");
            break;
          case "info":
            liveTv.showPanel("info");
            break;
          case "menu":
            liveTv.showPanel("menu");
            break;
        }
      }),
      listen<{ id: string }>("remote-launch", ({ payload }) => {
        // Waking only: launching now would leave the TV coming back on top of the app.
        if (power.isSaving()) return power.screensaver(false);
        const lib = latest.current.library;
        const item = lib && [...lib.streaming, ...lib.games, ...lib.apps].find((s) => s.id === payload.id);
        if (item) latest.current.launch(item);
      }),
      listen<{ videoId: string; position: number }>("remote-cast", ({ payload }) => {
        if (power.isSaving()) return power.screensaver(false);
        latest.current.playVideo(payload.videoId, payload.position || undefined);
      }),
    ];
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, []);

  // What the phone shows as "on TV now" (only sent when it changes).
  const channel = tv.data?.channels.find((c) => c.id === tv.playing);
  const air = onAir(tv.epg, channel);
  const snapshot = JSON.stringify({
    open: tv.open,
    pip: tv.pip,
    screen,
    channel: channel
      ? { id: channel.id, number: channel.number, name: channel.name, logo: channel.logo, program: air.current?.title ?? null, next: air.next?.title ?? null }
      : null,
  });
  const sent = useRef("");
  useEffect(() => {
    if (!inTauri || snapshot === sent.current) return;
    sent.current = snapshot;
    void api.remotePublish(JSON.parse(snapshot)).catch(() => {});
  }, [snapshot]);
}
