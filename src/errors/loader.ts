// src/errors/loader.ts — Load app-scoped error libraries from errors/<app>.json.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ErrorLibrarySchema, type ErrorLibrary } from './schema.js';
export type { ErrorLibrary } from './schema.js';

export function loadErrorLibrary(appId: string): ErrorLibrary {
  const path = resolve('errors', `${appId}.json`);
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return ErrorLibrarySchema.parse(raw);
}
