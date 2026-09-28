export const CODEX_RESPONSES_URL: string;
export const IMAGE_TOOL_NAME: 'generate_image';
export const IMAGE_SIZES: readonly string[];
export interface ImageGenModel { id: string; provider: string }
export interface ImageData { mimeType: string; data: string }
export interface StemImageDetails {
  id: string;
  mime: string;
  width?: number;
  height?: number;
  prompt?: string;
  revisedPrompt?: string;
}
export function accountIdFromJwt(token: string): string | null;
export function dispatcherCandidates<T extends ImageGenModel>(ctxModel: T | undefined, available: readonly T[], lastGood?: string | null): T[];
export function buildImageRequest(args: { model: string; prompt: string; size?: string; refs?: readonly ImageData[] }): Record<string, unknown>;
export function codexHeaders(token: string, accountId: string): Record<string, string>;
export class ImageGenError extends Error {
  constructor(code: string, message: string);
  code: string;
}
export function httpError(status: number, body: string): ImageGenError;
export function parseImageSse(body: AsyncIterable<Uint8Array | string> | null): Promise<{ b64: string; revisedPrompt?: string }>;
export function pngSize(buf: Buffer): { width: number; height: number } | null;
export function newImageId(): string;
export const IMAGES_MARKER_RE: RegExp;
export function parseImagesMarker(text: string): string[];
export function stemImageOf(message: unknown): StemImageDetails | null;
export function findImageInEntries(entries: readonly unknown[], id: string): ImageData | null;
export function knownImageIds(entries: readonly unknown[]): string[];
export function stubOldImages<T>(messages: T[], keep?: number): T[];
