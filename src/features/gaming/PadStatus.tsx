import { BatteryFull, BatteryLow, BatteryMedium, Cable } from "lucide-react";
import type { Pad } from "./useGamepads";

/** Battery (or "con cable") of a controller. */
export function PadPower({ pad }: { pad: Pad }) {
  if (pad.wired) {
    return (
      <span className="flex items-center gap-1.5">
        <Cable className="size-5" /> Con cable
      </span>
    );
  }
  if (pad.battery == null) return null;
  const Icon = pad.battery > 66 ? BatteryFull : pad.battery > 25 ? BatteryMedium : BatteryLow;
  return (
    <span className={`flex items-center gap-1.5 ${pad.battery <= 25 ? "text-[#ff5c7a]" : ""}`}>
      <Icon className="size-5" /> {pad.battery}%{pad.charging ? " · cargando" : ""}
    </span>
  );
}

/** "Xbox Wireless Controller" → "Mando Xbox"; keeps short names as they are. */
export function shortPadName(name: string) {
  if (/xbox|xinput/i.test(name)) return "Mando Xbox";
  if (/dualsense|dualshock|playstation|wireless controller/i.test(name)) return "Mando PlayStation";
  if (/pro controller|nintendo/i.test(name)) return "Mando Nintendo";
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}
