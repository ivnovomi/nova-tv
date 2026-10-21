import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { TriangleAlert } from "lucide-react";
import { Footer, TopBar } from "./components/Chrome";
import { LaunchOverlay, type OverlayState } from "./components/LaunchOverlay";
import { listen } from "@tauri-apps/api/event";
import { ToastProvider, useToast } from "./components/Toasts";
import { NovaContext, type Dialog, type Nova } from "./app/context";
import { AddExecutableDialog, AddSteamDialog, AddWebDialog, ConfirmDialog, ConfirmRemoveDialog } from "./features/Dialogs";
import { HomeScreen } from "./features/Home";
import { PcGamesDialog } from "./features/PcGamesCard";
import { Setup } from "./features/setup/Setup";
import { AppsScreen } from "./features/Library";
import { MediaScreen } from "./features/Media";
import { StreamingScreen } from "./features/Streaming";
import { SearchScreen } from "./features/Search";
import { TvMode } from "./features/livetv/TvMode";
import { AmbientBackdrop } from "./components/AmbientBackdrop";
import { FULLSCREEN_PREF, SettingsScreen, startsOnTv } from "./features/Settings";
import { StoreScreen } from "./features/store/StoreScreen";
import { BootSplash } from "./components/BootSplash";
import { ProfilePicker } from "./components/ProfilePicker";
import { profiles, useProfiles } from "./app/profiles";
import { updates } from "./app/updates";
import { power, useAutoScreensaver, usePower } from "./app/power";
import { PowerLayer } from "./features/PowerMenu";
import { Screensaver } from "./features/Screensaver";
import { UpdateNotice, UpdateWindows } from "./features/Updates";
import { useRemoteBridge } from "./app/useRemoteBridge";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { liveTv, useLiveTv } from "./features/livetv/store";
import { runHomeOverride, useBackHandler } from "./hooks/backStack";
import { GamingMode } from "./features/gaming/GamingMode";
import { GameLaunch, PREVIEW_LAUNCH, type GameLaunchState, type LaunchStage } from "./features/gaming/GameLaunch";
import { sfx } from "./features/gaming/sfx";
import { GameVariantsDialog } from "./features/gaming/GameVariants";
import { isGroupTile, variantsOf } from "./features/gaming/groups";
import { useRemoteInput } from "./hooks/useRemoteInput";
import { api, inTauri, pickMediaFile } from "./lib/api";
import { focusElement, focusFirst } from "./lib/spatialNav";
import type { FeedItem, Library, RecentMedia, Screen, Shortcut, WatchEntry } from "./lib/types";

const FALLBACK_EXTENSIONS = ["mp4", "mkv", "avi", "mov", "webm", "mp3", "flac", "wav", "m4a", "jpg", "jpeg", "png"];

function Shell() {
  const toast = useToast();
  const [screen, setScreen] = useState<Screen>("home");
  const history = useRef<Screen[]>([]);
  const focusTarget = useRef<"content" | "tab">("content");
  const mainRef = useRef<HTMLElement>(null);

  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [recentMedia, setRecentMedia] = useState<RecentMedia[]>([]);
  const [extensions, setExtensions] = useState<string[]>(FALLBACK_EXTENSIONS);
  const [launching, setLaunching] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const [gameLaunch, setGameLaunch] = useState<GameLaunchState>(null);
  const [watchHistory, setWatchHistory] = useState<WatchEntry[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [gaming, setGaming] = useState(false);

  const loadHistory = useCallback(() => {
    api.historyList().then(setWatchHistory, () => {});
  }, []);
  const loadFeed = useCallback(() => {
    api.youtubeFeed().then(setFeed, () => {});
  }, []);

  // Progress arrives every few seconds while watching; refresh at most once a second.
  useEffect(() => {
    loadHistory();
    loadFeed();
    if (!inTauri) return;
    let timer: number | undefined;
    const off = listen("history-changed", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(loadHistory, 1000);
    });
    return () => {
      window.clearTimeout(timer);
      void off.then((f) => f());
    };
  }, [loadHistory, loadFeed]);
  const overlayTimer = useRef<number | undefined>(undefined);

  const hideOverlayIn = useCallback((ms: number) => {
    window.clearTimeout(overlayTimer.current);
    overlayTimer.current = window.setTimeout(() => setOverlay(null), ms);
  }, []);


  const reload = useCallback(async () => {
    try {
      setLibrary(await api.listLibrary());
      setLibraryError(null);
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e));
    }
    api.recentMedia().then(setRecentMedia, () => {});
  }, []);

  // Session events from Rust: the service closed or the remote pressed Home.
  useEffect(() => {
    if (!inTauri) return;
    const off = listen<{ active: boolean; name: string; reason: string }>("stream-session", ({ payload }) => {
      if (payload.active) return;
      setOverlay({ phase: "returning", name: payload.name });
      hideOverlayIn(1100);
      void reload();
      loadHistory();
      loadFeed();
    });
    return () => {
      void off.then((f) => f());
    };
  }, [hideOverlayIn, reload, loadHistory, loadFeed]);

  // The opening transition stays until the service window takes over the screen.
  useEffect(() => {
    if (overlay?.phase !== "opening") return;
    const onBlur = () => hideOverlayIn(700);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [overlay, hideOverlayIn]);

  useEffect(() => {
    void reload();
    api.mediaExtensions().then(setExtensions, () => {});
    // Coming back from a launched app: pick up newly installed programs/games.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const show = useCallback((next: Screen, target: "content" | "tab") => {
    focusTarget.current = target;
    setScreen(next);
    mainRef.current?.scrollTo({ top: 0 });
  }, []);

  const navigate = useCallback(
    (next: Screen, target: "content" | "tab" = "content") => {
      // "TV" isn't a page: it turns the TV mode on, a world apart.
      // "Sistema" now lives inside Ajustes.
      if (next === "system") next = "settings";
      if (next === "livetv") {
        void liveTv.open();
        return;
      }
      // "Juegos" goes straight into NOVA PLAY, like a console.
      if (next === "games") {
        liveTv.close();
        setGaming(true);
        return;
      }
      if (next === screen) {
        if (target === "content") focusFirst(mainRef.current);
        return;
      }
      history.current.push(screen);
      show(next, target);
    },
    [screen, show],
  );

  const goHome = useCallback(() => {
    // Under the screensaver Home only wakes it.
    if (power.isSaving()) {
      power.screensaver(false);
      return;
    }
    if (runHomeOverride()) return; // e.g. Gaming Mode opens its Guide
    history.current = [];
    if (screen === "home") {
      mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      focusFirst(mainRef.current);
    } else show("home", "content");
  }, [screen, show]);

  const goHomeRef = useRef(goHome);
  goHomeRef.current = goHome;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Phone remote: Home button and new pairings.
  useEffect(() => {
    if (!inTauri) return;
    const offs = [
      listen("remote-home", () => goHomeRef.current()),
      listen("remote-search", () => navigateRef.current("search")),
      listen<string>("remote-paired", ({ payload }) => toast.show("success", "Mando móvil emparejado", payload)),
    ];
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, [toast]);

  useBackHandler(() => {
    const prev = history.current.pop();
    if (prev) show(prev, "content");
    else if (screen !== "home") show("home", "content");
    else {
      const tab = document.querySelector<HTMLElement>('[data-nav-tab="home"]');
      if (tab) focusElement(tab);
    }
  });

  // Move focus into the new screen once it has rendered.
  useEffect(() => {
    if (focusTarget.current !== "content") return;
    const raf = requestAnimationFrame(() => focusFirst(mainRef.current));
    return () => cancelAnimationFrame(raf);
  }, [screen]);

  const gamepad = useRemoteInput(goHome);
  const prevPad = useRef<string | null>(null);
  useEffect(() => {
    if (gamepad && gamepad !== prevPad.current) toast.show("info", "Mando conectado", gamepad);
    if (!gamepad && prevPad.current) toast.show("info", "Mando desconectado", "El teclado sigue funcionando.");
    prevPad.current = gamepad;
  }, [gamepad, toast]);

  const launch = useCallback(
    async (item: Shortcut) => {
      if (launching) return;
      // A game with several ways to open it (instances, here or on a PC): ask which first.
      if (isGroupTile(item) && library) {
        const variants = variantsOf(library.games, item);
        if (variants.length > 1) {
          setDialog({ type: "game-variants", title: item.name, variants });
          return;
        }
      }
      setLaunching(item.id);
      if (item.kind !== "app") liveTv.close(); // a game or a service takes over the screen and sound
      const started = performance.now();
      const isStream = item.kind === "stream";
      if (isStream) {
        window.clearTimeout(overlayTimer.current);
        setOverlay({ phase: "opening", item, name: item.name });
      }
      // Games get their loading screen; it follows the launch through `game-launch` events.
      if (item.kind === "game") {
        sfx.launch();
        setGameLaunch({ item, stage: "launching" });
        try {
          await api.launch(item.id);
          void reload();
        } catch (e) {
          setGameLaunch((g) => (g?.item.id === item.id ? { item, stage: "error", detail: e instanceof Error ? e.message : String(e) } : g));
        } finally {
          window.setTimeout(() => setLaunching(null), Math.max(0, 600 - (performance.now() - started)));
        }
        return;
      }
      const id = isStream ? -1 : toast.show("loading", `Abriendo ${item.name}…`);
      try {
        await api.launch(item.id);
        if (isStream) {
          hideOverlayIn(8000); // safety net if the window never takes focus
          void reload();
          return;
        }
        toast.update(
          id,
          "success",
          `${item.name} se ha iniciado`,
          item.target.type === "steam"
            ? "Steam se encarga de abrir el juego."
            : item.target.type === "web"
              ? "Pantalla completa. Pulsa Alt+F4 para volver a NOVA TV."
              : undefined,
        );
        void reload();
      } catch (e) {
        if (isStream) {
          setOverlay(null);
          toast.show("error", `No se pudo abrir ${item.name}`, e instanceof Error ? e.message : String(e));
          return;
        }
        toast.update(id, "error", `No se pudo abrir ${item.name}`, e instanceof Error ? e.message : String(e));
      } finally {
        const wait = Math.max(0, 600 - (performance.now() - started));
        window.setTimeout(() => setLaunching(null), wait);
      }
    },
    [launching, toast, reload, hideOverlayIn, library],
  );

  // The game's loading screen follows the real launch (gamewatch / gamestream).
  useEffect(() => {
    if (!inTauri) return;
    const off = [
      listen<{ id: string; stage: LaunchStage; detail?: string }>("game-launch", ({ payload }) => {
        setGameLaunch((g) => (g && g.item.id === payload.id && g.stage !== "error" ? { ...g, stage: payload.stage, detail: payload.detail ?? g.detail } : g));
      }),
      // Ended before NOVA saw it start (or the PC session closed): nothing left to wait for.
      listen<{ id: string }>("game-ended", ({ payload }) => setGameLaunch((g) => (g?.item.id === payload.id ? null : g))),
    ];
    return () => off.forEach((o) => void o.then((f) => f()));
  }, []);

  // Development: `?launch-preview` plays a whole PC-game launch, no Tauri needed.
  useEffect(() => {
    if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("launch-preview")) return;
    const { item, stages } = PREVIEW_LAUNCH;
    const timers = stages.map(([stage, at]) => window.setTimeout(() => setGameLaunch({ item, stage, detail: "TORRE" }), at + 800));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  // When it's over: "running" plays its way out; when NOVA can't tell (or it's
  // a PC's game in Moonlight), the game's window taking the screen ends it.
  const launchStage = gameLaunch?.stage;
  useEffect(() => {
    if (!launchStage) return;
    if (launchStage === "running") {
      sfx.success();
      const t = window.setTimeout(() => setGameLaunch(null), 1100);
      return () => window.clearTimeout(t);
    }
    if (launchStage !== "unwatched" && launchStage !== "streaming") return;
    const close = () => setGameLaunch(null);
    // Already in the background (the game came up first): close now.
    if (!document.hasFocus()) {
      const t = window.setTimeout(close, 400);
      return () => window.clearTimeout(t);
    }
    window.addEventListener("blur", close);
    const t = window.setTimeout(close, launchStage === "unwatched" ? 8000 : 25_000);
    return () => {
      window.removeEventListener("blur", close);
      window.clearTimeout(t);
    };
  }, [launchStage]);

  const openMedia = useCallback(
    async (path: string) => {
      try {
        const entry = await api.openMedia(path);
        toast.show("success", `Abriendo ${entry.name}`, "Con la aplicación predeterminada de Windows.");
      } catch (e) {
        toast.show("error", "No se pudo abrir el archivo", e instanceof Error ? e.message : String(e));
      }
      api.recentMedia().then(setRecentMedia, () => {});
    },
    [toast],
  );

  const pickAndOpenMedia = useCallback(async () => {
    if (!inTauri) {
      toast.show("error", "No disponible en el navegador", "Ejecuta NOVA TV como aplicación de escritorio.");
      return;
    }
    try {
      const path = await pickMediaFile(extensions);
      if (path) await openMedia(path);
    } catch (e) {
      toast.show("error", "No se pudo abrir el selector", e instanceof Error ? e.message : String(e));
    }
  }, [extensions, openMedia, toast]);

  const forgetMedia = useCallback(
    async (path: string) => {
      try {
        await api.forgetMedia(path);
      } catch (e) {
        toast.show("error", "No se pudo quitar", e instanceof Error ? e.message : String(e));
      }
      api.recentMedia().then(setRecentMedia, () => {});
    },
    [toast],
  );

  const playVideo = useCallback(
    async (videoId: string, position?: number) => {
      liveTv.close();
      const youtube = library?.streaming.find((s) => s.id === "stream:youtube");
      window.clearTimeout(overlayTimer.current);
      setOverlay({ phase: "opening", item: youtube, name: "YouTube" });
      try {
        await api.playYoutube(videoId, position);
        hideOverlayIn(8000);
      } catch (e) {
        setOverlay(null);
        toast.show("error", "No se pudo abrir el vídeo", e instanceof Error ? e.message : String(e));
      }
    },
    [library, hideOverlayIn, toast],
  );

  const playTwitch = useCallback(
    async (login: string, name: string) => {
      liveTv.close();
      const twitch = library?.streaming.find((s) => s.id === "stream:twitch");
      window.clearTimeout(overlayTimer.current);
      setOverlay({ phase: "opening", item: twitch, name: `Twitch · ${name}` });
      try {
        await api.twitchPlay(login, name);
        hideOverlayIn(8000);
      } catch (e) {
        setOverlay(null);
        toast.show("error", "No se pudo abrir el directo", e instanceof Error ? e.message : String(e));
      }
    },
    [library, hideOverlayIn, toast],
  );

  const removeHistory = useCallback(
    (key: string) => {
      api.historyRemove(key).then(loadHistory, (e: Error) => toast.show("error", "No se pudo quitar", e.message));
    },
    [loadHistory, toast],
  );


  // Ajustes → "Abrir a pantalla completa".
  useEffect(() => {
    if (!inTauri) return;
    try {
      if (localStorage.getItem(FULLSCREEN_PREF) === "on") void getCurrentWindow().setFullscreen(true).catch(() => {});
    } catch {}
  }, []);
  const { open: tvOn, pip: tvPip } = useLiveTv();
  // Full-screen TV hides NOVA's windows; the mini player in a corner doesn't.
  const tvFull = tvOn && !tvPip;
  const [booting, setBooting] = useState(true);
  useRemoteBridge({ library, screen, launch, playVideo });

  // Who's watching. With several profiles, someone picks after the start-up
  // animation; with one, the TV turns on behind it, on the last channel.
  const profileInfo = useProfiles();
  const [profilesReady, setProfilesReady] = useState(!inTauri);
  const [picking, setPicking] = useState<"boot" | "switch" | null>(null);
  // First run: the assistant comes before choosing a profile or turning the TV on.
  const [setup, setSetup] = useState(false);
  const multiProfile = (profileInfo?.profiles.length ?? 1) > 1;
  useEffect(() => {
    if (!inTauri) {
      // Development: `?setup` shows the assistant with sample data.
      if (import.meta.env.DEV && new URLSearchParams(location.search).has("setup")) setSetup(true);
      return;
    }
    Promise.all([api.setupNeeded().catch(() => false), profiles.load().catch(() => null)]).then(([needed, info]) => {
      setProfilesReady(true);
      if (needed) setSetup(true);
      else if (info && info.profiles.length > 1) setPicking("boot");
      else if (startsOnTv()) void liveTv.open();
    });
  }, []);

  // Ajustes → "Repetir el asistente".
  useEffect(() => {
    const again = () => setSetup(true);
    window.addEventListener("nova-setup", again);
    return () => window.removeEventListener("nova-setup", again);
  }, []);

  const setupDone = () => {
    setSetup(false);
    void profiles.load();
    void reload();
    show("home", "content");
    if (startsOnTv()) void liveTv.open();
  };

  // A plugin was installed, enabled, changed…: its channels and guide, now (the
  // rest of live TV stays cached in Rust, so this is quick).
  useEffect(() => {
    if (!inTauri) return;
    const offs = [
      listen("plugins-changed", () => {
        if (liveTv.loaded()) void liveTv.load(true);
      }),
      // A plugin's notice (permission "notify", at most 3 a minute, enforced in Rust).
      listen<{ plugin: string; title: string; detail: string | null }>("plugin-notify", ({ payload }) =>
        toast.show("info", payload.title, payload.detail ? `${payload.detail} · ${payload.plugin}` : payload.plugin),
      ),
      // A PC of the house was paired, forgotten or has other games.
      listen("pcs-changed", () => void reload()),
      // Settings that can't be saved would be lost at the next restart: never silently.
      listen<string>("config-save-failed", ({ payload }) => toast.show("error", "NOVA no puede guardar tus ajustes", payload)),
    ];
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, [toast, reload]);

  // Another profile: everything it sees comes again from Rust, already filtered.
  useEffect(() => {
    if (!inTauri) return;
    const off = listen("profile-changed", () => {
      void profiles.load();
      void reload();
      loadHistory();
      loadFeed();
      if (liveTv.loaded()) void liveTv.load(true);
      history.current = [];
      show("home", "content");
    });
    return () => void off.then((f) => f());
  }, [reload, loadHistory, loadFeed, show]);

  useEffect(() => {
    updates.start();
    power.start();
  }, []);
  const { screensaver } = usePower();
  useAutoScreensaver(!booting && !picking && !tvOn && !gaming && !overlay && !gameLaunch && !setup);

  const pickerDone = () => {
    const boot = picking === "boot";
    setPicking(null);
    if (boot && startsOnTv()) void liveTv.open();
  };
  const gamingRef = useRef(gaming);
  gamingRef.current = gaming;

  // A game launched from the TV interface ended (NOVA PLAY shows its own welcome).
  useEffect(() => {
    if (!inTauri) return;
    const off = listen<{ name: string; seconds: number }>("game-ended", ({ payload }) => {
      if (gamingRef.current) return;
      const min = Math.round(payload.seconds / 60);
      toast.show("info", "Bienvenido de nuevo", min >= 1 ? `Has jugado ${min} min a ${payload.name}.` : `Has salido de ${payload.name}.`);
      void reload();
    });
    return () => {
      void off.then((f) => f());
    };
  }, [toast, reload]);
  const exitGaming = useCallback(() => {
    setGaming(false);
    requestAnimationFrame(() => focusFirst(mainRef.current));
  }, []);

  const nova = useMemo<Nova>(
    () => ({
      enterGaming: () => {
        liveTv.close();
        setGaming(true);
      },
      library,
      libraryError,
      recentMedia,
      launching,
      history: watchHistory,
      feed,
      playVideo,
      playTwitch,
      removeHistory,
      navigate: (s) => navigate(s, "content"),
      launch,
      pickAndOpenMedia,
      openMedia,
      forgetMedia,
      openDialog: setDialog,
      reload,
    }),
    [library, libraryError, recentMedia, launching, watchHistory, feed, playVideo, playTwitch, removeHistory, navigate, launch, pickAndOpenMedia, openMedia, forgetMedia, reload],
  );

  const closeDialog = () => setDialog(null);
  const onSaved = (s: Shortcut) => {
    setDialog(null);
    toast.show("success", `«${s.name}» añadido`, s.kind === "game" ? "Ya está en tu biblioteca de juegos." : s.kind === "stream" ? "Ya está en Streaming." : "Ya está en tus aplicaciones.");
    void reload();
  };

  return (
    <NovaContext.Provider value={nova}>
      {gaming && (
        <GamingMode
          onExit={exitGaming}
          onCrash={(e) => {
            exitGaming();
            toast.show("error", "El Modo Juego se ha cerrado por un error", e.message);
          }}
        />
      )}
      <div className="relative flex h-full flex-col" hidden={gaming}>
        <div className="ambient" />
        <AmbientBackdrop />
        <div onFocus={() => mainRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>
          <TopBar screen={screen} onNavigate={(s) => navigate(s, "tab")} onProfiles={() => setPicking("switch")} />
        </div>
        {libraryError && (
          <div role="alert" className="relative z-10 mx-[var(--gutter)] mb-3 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-5 py-3 text-[1rem] text-[#ffe7b0]">
            <TriangleAlert className="size-5 shrink-0" /> {libraryError}
          </div>
        )}
        <main ref={mainRef} className="page-scroll relative z-[1] min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-2">
          <motion.div
            key={screen}
            className={screen === "settings" || screen === "search" ? "h-full" : undefined}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            {screen === "home" && <HomeScreen />}
            {screen === "search" && <SearchScreen />}
            {screen === "streaming" && <StreamingScreen />}
            {screen === "apps" && <AppsScreen />}
            {screen === "media" && <MediaScreen />}
            {screen === "settings" && <SettingsScreen />}
            {screen === "store" && <StoreScreen />}
          </motion.div>
        </main>
        <Footer gamepad={gamepad} />
      </div>

      <AnimatePresence>{overlay && <LaunchOverlay key="overlay" state={overlay} />}</AnimatePresence>
      <AnimatePresence>{gameLaunch && <GameLaunch key={gameLaunch.item.id} state={gameLaunch} onHide={() => setGameLaunch(null)} preview={import.meta.env.DEV ? PREVIEW_LAUNCH.meta : undefined} />}</AnimatePresence>
      {tvOn && <TvMode />}
      <AnimatePresence>
        {booting && (
          <BootSplash
            key="boot"
            libraryReady={profilesReady && (library !== null || libraryError !== null || !inTauri)}
            tv={inTauri && profilesReady && !setup && !multiProfile && startsOnTv()}
            onDone={() => setBooting(false)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {picking && !booting && (
          <ProfilePicker
            key="profiles"
            dismissable={picking === "switch"}
            onDone={pickerDone}
            onManage={() => {
              setPicking(null);
              navigate("settings");
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>{setup && !booting && <Setup key="setup" onDone={setupDone} />}</AnimatePresence>

      <AnimatePresence>{screensaver && <Screensaver key="screensaver" tvWasOn={tvOn} />}</AnimatePresence>
      <PowerLayer />

      {/* Announced only in NOVA's own menus, never over the TV, a game or the start-up. */}
      <UpdateNotice hidden={booting || !!picking || setup || tvFull || gaming} raised={tvOn && tvPip} />
      {!booting && !picking && !setup && !tvFull && !gaming && <UpdateWindows />}

      <AnimatePresence>
        {dialog?.type === "add-exe" && (
          <AddExecutableDialog key="add-exe" kind={dialog.kind} suggestedName={dialog.suggestedName} onClose={closeDialog} onSaved={onSaved} />
        )}
        {dialog?.type === "add-steam" && <AddSteamDialog key="add-steam" onClose={closeDialog} onSaved={onSaved} />}
        {dialog?.type === "add-web" && <AddWebDialog key="add-web" onClose={closeDialog} onSaved={onSaved} />}
        {dialog?.type === "pc-games" && <PcGamesDialog key="pc-games" onClose={closeDialog} />}
        {dialog?.type === "game-variants" && (
          <GameVariantsDialog
            key="game-variants"
            title={dialog.title}
            variants={dialog.variants}
            onClose={closeDialog}
            onPick={(g) => {
              setDialog(null);
              void launch(g);
            }}
          />
        )}
        {dialog?.type === "confirm-clear-history" && (
          <ConfirmDialog
            key="clear-history"
            title="¿Borrar todo el historial?"
            subtitle="Se olvidará «Seguir viendo» y lo visto en NOVA TV. Tu cuenta de YouTube no cambia."
            confirmLabel="Borrar historial"
            onClose={closeDialog}
            onConfirm={async () => {
              await api.historyClear();
              setDialog(null);
              loadHistory();
              setFeed([]);
              toast.show("success", "Historial borrado");
            }}
          />
        )}
        {dialog?.type === "confirm-remove" && (
          <ConfirmRemoveDialog
            key="confirm"
            item={dialog.item}
            onClose={closeDialog}
            onRemoved={() => {
              toast.show("success", `«${dialog.item.name}» quitado`);
              setDialog(null);
              void reload();
            }}
          />
        )}
      </AnimatePresence>
    </NovaContext.Provider>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </MotionConfig>
  );
}
