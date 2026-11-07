import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processAudio } from "./AudioProcessing.ts";
import { AUDIO_PIPE_INPUT, videoFileInput } from "./MediaInput.ts";
import { processVideo } from "./VideoProcessing.ts";

// Harmless local fixtures only: a playlist and a concat script that each point
// at a real clip beside them, so that they really do open under plain ffmpeg
// (see the control test). Without that, a rejection could just mean the fixture
// was broken — which is also why these tests look at ffmpeg's stated reason.
let dir: string;
let hlsPath: string;
let concatPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-input-test-"));
  const color = "color=c=blue:s=64x64:d=1:r=5";
  await Bun.$`ffmpeg -y -f lavfi -i ${color} -pix_fmt yuv420p -c:v libx264 ${join(dir, "clip.mp4")}`.quiet();
  await Bun.$`ffmpeg -y -i ${join(dir, "clip.mp4")} -c copy -f mpegts ${join(dir, "segment.ts")}`.quiet();

  hlsPath = join(dir, "playlist.m3u8");
  await Bun.write(
    hlsPath,
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n",
  );
  // An allowed name: only the contents give this away as a script.
  concatPath = join(dir, "script.mp4");
  await Bun.write(concatPath, "ffconcat version 1.0\nfile 'clip.mp4'\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ffprobe = async (
  args: ReadonlyArray<string>,
  stdin?: Uint8Array,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(
    ["ffprobe", "-hide_banner", "-show_entries", "format=format_name", ...args],
    { stdin, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const bytesOf = (path: string) => Bun.file(path).bytes();

test("the playlist and the script open as hls and concat without the restrictions", async () => {
  const hls = await ffprobe(["-i", hlsPath]);
  expect(hls.exitCode).toBe(0);
  expect(hls.stdout).toContain("format_name=hls");

  const concat = await ffprobe(["-i", concatPath]);
  expect(concat.exitCode).toBe(0);
  expect(concat.stdout).toContain("format_name=concat");
});

test("the video input refuses an HLS playlist and a concat script as formats", async () => {
  for (const path of [hlsPath, concatPath]) {
    const { exitCode, stderr } = await ffprobe(videoFileInput(path));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Format not on whitelist");
  }
});

test("processVideo rejects an HLS playlist and a concat script", async () => {
  await expect(processVideo(hlsPath)).rejects.toThrow();
  await expect(processVideo(concatPath)).rejects.toThrow();
});

test("the audio input refuses a concat script arriving over pipe:0 as a format", async () => {
  const { exitCode, stderr } = await ffprobe(
    AUDIO_PIPE_INPUT,
    await bytesOf(concatPath),
  );
  expect(exitCode).not.toBe(0);
  // The format specifically: plain ffmpeg fails this too, but later, with
  // "Protocol 'pipe' not on whitelist" when the script opens its entries.
  expect(stderr).toContain("Format not on whitelist");
});

test("processAudio rejects an HLS playlist and a concat script", async () => {
  // Plain ffmpeg can't get far with either over a pipe (no playlist name for
  // hls, nothing to resolve the script's paths against for concat), so this
  // alone doesn't prove the restriction; the test above does, for concat.
  await expect(processAudio(await bytesOf(hlsPath))).rejects.toThrow();
  await expect(processAudio(await bytesOf(concatPath))).rejects.toThrow();
});

test("the video input only opens files", async () => {
  // `data:` as the stand-in for any other protocol: it needs no network.
  for (const url of ["data:text/plain,hello", "pipe:0"]) {
    const { exitCode, stderr } = await ffprobe(videoFileInput(url));
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Protocol .* not on whitelist/);
  }
});

test("the audio input only opens pipes", async () => {
  const flags = AUDIO_PIPE_INPUT.slice(0, -1);
  for (const url of ["data:text/plain,hello", join(dir, "clip.mp4")]) {
    const { exitCode, stderr } = await ffprobe([...flags, url]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Protocol .* not on whitelist/);
  }
});
