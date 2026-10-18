/** `nova-plugin.json`, as typed data (the JSON Schema is in schema/nova-plugin.schema.json). */
export interface Manifest {
  id: string;
  name: string;
  version: string;
  api: 1;
  kind: ("provider" | "app")[];
  main: string;
  app?: string;
  icon?: string;
  description: string;
  author: { name: string; url?: string; email?: string };
  audience: "everyone" | "adults";
  permissions: Permissions;
  settings?: Setting[];
}

export interface Permissions {
  /** HTTPS domains; "*.ejemplo.es" allows its subdomains. */
  network?: string[];
  channels?: boolean;
  guide?: boolean;
  rows?: boolean;
  search?: boolean;
  screensaver?: boolean;
  notify?: boolean;
  location?: boolean;
}

export type Setting =
  | { key: string; type: "text"; label: string; help?: string; default?: string }
  | { key: string; type: "toggle"; label: string; help?: string; default?: boolean }
  | { key: string; type: "number"; label: string; help?: string; default?: number }
  | { key: string; type: "choice"; label: string; help?: string; default?: string; options: { value: string; label: string }[] };
