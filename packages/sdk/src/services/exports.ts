import { LearningError } from '../types/errors.js';
import type { Scope } from '../types/refs.js';

export type ResumeDecision = 'append' | 'restart';

/** 206 + correct range + same validator → append; otherwise restart (S07). */
export function decideRangeResume(input: { status: number; contentRangeStart: number; expectedOffset: number; validatorMatches: boolean }): ResumeDecision {
  if (input.status !== 206) return 'restart';
  if (input.contentRangeStart !== input.expectedOffset) return 'restart';
  if (!input.validatorMatches) return 'restart';
  return 'append';
}

const WINDOWS_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'LPT1', 'LPT2', 'LPT3']);

export function safeFilename(title: string): string {
  const base = title.replace(/[/\\:*?"<>|.]/g, '_');
  const upper = base.toUpperCase();
  return WINDOWS_RESERVED.has(upper) ? `${base}_` : base;
}

export interface ManifestShape { scope: Scope; path: string; sha256: string }

export function validateManifestScope(manifest: ManifestShape, scope: Scope, committedPath: string): boolean {
  if (manifest.scope.userId !== scope.userId || manifest.scope.profileId !== scope.profileId || manifest.scope.platform !== scope.platform) return false;
  if (manifest.path !== committedPath) return false;
  return /^[0-9a-f]{64}$/.test(manifest.sha256);
}

export function assertDownloadBudget(bytes: number, budget: number): void {
  if (bytes > budget) {
    throw new LearningError({ code: 'BUDGET', message: 'download exceeds configured budget', retryAfterMs: null, operationId: null });
  }
}
