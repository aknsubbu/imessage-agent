// Converts what iMessage sends into what the models accept. Voice memos arrive
// as CAF and photos as HEIC; Groq takes neither. ffmpeg does both conversions.
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const run = (cmd: string, args: string[]) => exec(cmd, args, { timeout: 45_000 });

/** Re-encodes any audio file as 16 kHz mono FLAC, the form Whisper works from anyway. */
export async function audioForWhisper(path: string): Promise<string> {
  const out = `${path}.flac`;
  await run("ffmpeg", ["-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", out]);
  return out;
}

let ffmpegMajor: Promise<number> | undefined;
/** ffmpeg learned to assemble tiled iPhone HEICs in version 7; older builds decode a single tile. */
const ffmpegVersion = (): Promise<number> =>
  (ffmpegMajor ??= run("ffmpeg", ["-version"]).then(
    ({ stdout }) => Number(/ffmpeg version n?(\d+)/.exec(stdout)?.[1] ?? 0),
    () => 0,
  ));

/**
 * Returns a JPEG no larger than `maxSide` on its long edge. Tries, in order:
 * ffmpeg 7 or newer (turns the photo upright), heif-convert followed by ffmpeg
 * (the route for older Linux ffmpeg builds), then macOS sips as a last resort,
 * which was seen to leave a rotated iPhone photo on its side.
 */
export async function imageAsJpeg(path: string, maxSide = 1024): Promise<Buffer> {
  const out = `${path}.vision.jpg`;
  const full = `${path}.full.jpg`;
  const scale = `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`;
  const resize = () => run("ffmpeg", ["-v", "error", "-y", "-i", full, "-vf", scale, "-q:v", "5", out]);
  const attempts: (() => Promise<unknown>)[] = [
    async () => {
      if ((await ffmpegVersion()) < 7) throw new Error("ffmpeg is too old for tiled HEIC");
      // ffmpeg assembles the tiles in its own filter graph, so the resize has to be a second pass.
      await run("ffmpeg", ["-v", "error", "-y", "-i", path, "-frames:v", "1", "-q:v", "3", full]);
      await resize();
    },
    async () => {
      await run("heif-convert", [path, full]);
      await resize();
    },
    () => run("sips", ["-s", "format", "jpeg", "-Z", String(maxSide), path, "--out", out]),
  ];
  let lastError: unknown;
  try {
    for (const attempt of attempts) {
      try {
        await attempt();
        return await readFile(out);
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`could not convert the image: ${lastError instanceof Error ? lastError.message : lastError}`);
  } finally {
    await Promise.all([rm(out, { force: true }), rm(full, { force: true })]);
  }
}

/** Deletes media files, but only ones inside the media directory. */
export async function discard(mediaDir: string, paths: string[]): Promise<void> {
  const root = resolve(mediaDir) + sep;
  await Promise.all(
    paths.filter((path) => resolve(path).startsWith(root)).map((path) => rm(path, { force: true }).catch(() => {})),
  );
}
