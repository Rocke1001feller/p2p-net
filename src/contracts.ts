import { readFileSync } from 'node:fs';

export const PORTS = JSON.parse(
  readFileSync(new URL('../contracts/ports.json', import.meta.url), 'utf8'),
) as { CONTROL_PORT: number; DISCOVERY_PORT: number; DOCS_PORT: number; TUNNEL_RELAY_PORT: number };
