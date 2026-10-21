import type { NetStatus, Place, ProfilesInfo, RemoteInfo, WifiNetwork } from "../../lib/types";

/** Sample data for looking at the assistant outside Tauri (`npm run dev`, `?setup`). */
export const PREVIEW = {
  net: { internet: false, kind: null, ssid: null, network: null, private: null, wifi: true } satisfies NetStatus,
  networks: [
    { ssid: "MiFibra-5G", signal: 96, secured: true, connected: false, saved: false },
    { ssid: "MiFibra", signal: 82, secured: true, connected: false, saved: true },
    { ssid: "Vecino_2.4", signal: 41, secured: true, connected: false, saved: false },
    { ssid: "Cafetería invitados", signal: 18, secured: false, connected: false, saved: false },
  ] satisfies WifiNetwork[],
  profiles: {
    profiles: [{ id: "principal", name: "Principal", avatar: "😎", color: "#6e6cff", kids: false, favorites: [], lastChannel: null, allowed: [], allowWorld: false }],
    active: "principal",
    hasPin: false,
    unlockedUntil: null,
  } satisfies ProfilesInfo,
  place: { city: "Madrid", country: "España", region: "Comunidad de Madrid", latitude: 40.4, longitude: -3.7, countryCode: "ES", timezone: "Europe/Madrid", source: "auto", detectedAt: null } satisfies Place,
  remote: { enabled: true, running: true, urls: ["http://192.168.1.50:8765"], pin: "481527", pairUrl: null, qrSvg: null, locked: false, devices: [], error: null } satisfies RemoteInfo,
};
