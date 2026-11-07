import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { processAudio } from "./AudioProcessing.ts";
import {
  AUDIO_PIPE_INPUT,
  runFfmpeg,
  runFfprobe,
  videoFileInput,
} from "./MediaInput.ts";
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

test("the decoder lists refuse an off-list codec in an allowed container", async () => {
  // Plain ffmpeg reads both, so it's the list that turns them away.
  const mpeg4 = join(dir, "mpeg4.mp4");
  const flac = join(dir, "flac.mka");
  const color = "color=c=blue:s=64x64:d=1:r=5";
  const sine = "sine=frequency=440:duration=1";
  await Bun.$`ffmpeg -y -f lavfi -i ${color} -c:v mpeg4 ${mpeg4}`.quiet();
  await Bun.$`ffmpeg -y -f lavfi -i ${sine} -c:a flac ${flac}`.quiet();
  for (const path of [mpeg4, flac]) {
    expect((await ffprobe(["-i", path])).exitCode).toBe(0);
  }

  const video = await ffprobe(videoFileInput(mpeg4));
  expect(video.exitCode).not.toBe(0);
  expect(video.stderr).toContain("(mpeg4) not on whitelist");

  const audio = await ffprobe(AUDIO_PIPE_INPUT, await bytesOf(flac));
  expect(audio.exitCode).not.toBe(0);
  expect(audio.stderr).toContain("(flac) not on whitelist");
});

test("the audio decoder list has no video decoders", async () => {
  const { exitCode, stderr } = await ffprobe(
    AUDIO_PIPE_INPUT,
    await bytesOf(join(dir, "clip.mp4")),
  );
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("(h264) not on whitelist");
});

test("the wrappers reject with ffmpeg's reason and resolve to its output", async () => {
  const clip = join(dir, "clip.mp4");
  await expect(
    runFfmpeg({ videoPath: hlsPath }, ["-f", "null", "-"]),
  ).rejects.toThrow("not on whitelist");
  expect(
    await runFfprobe({ videoPath: clip }, [
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
    ]),
  ).toContain("h264");
});

// Runs `script` in a new process whose `ffmpeg`/`ffprobe` are scripts that log
// their arguments, one call per line, and resolves to what they logged: what
// reaches the real binaries, however the code under test got there. A new process
// because Bun.spawn doesn't see a PATH changed after startup.
const logMediaCalls = async (
  script: string,
): Promise<ReadonlyArray<string>> => {
  const shimDir = await mkdtemp(join(dir, "shims-"));
  const log = join(shimDir, "calls.log");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const shim = join(shimDir, tool);
    await Bun.write(
      shim,
      `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexec "${Bun.which(tool)}" "$@"\n`,
    );
    await chmod(shim, 0o755);
  }
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      PATH: `${shimDir}${delimiter}${process.env.PATH}`,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(await proc.exited).toBe(0);
  return (await Bun.file(log).text()).trim().split("\n");
};

const expectRestricted = (calls: ReadonlyArray<string>, count: number) => {
  expect(calls).toHaveLength(count);
  for (const call of calls) {
    expect(call).toContain("-protocol_whitelist ");
    expect(call).toContain("-format_whitelist ");
    expect(call).toContain("-codec_whitelist ");
  }
};

test("processVideo restricts every call and never passes on the file's name", async () => {
  const hostile = join(dir, `hostile-name-${"a".repeat(200)}.m3u8`);
  await Bun.write(hostile, Bun.file(join(dir, "clip.mp4")));

  const calls = await logMediaCalls(`
    import { processVideo } from "./VideoProcessing.ts";
    await processVideo(${JSON.stringify(hostile)});
  `);

  expectRestricted(calls, 2);
  for (const call of calls) {
    expect(call).not.toContain(basename(hostile));
    expect(call).not.toContain("m3u8");
    // The temp dir and a UUID, nothing derived from the upload's own path.
    expect(call).toMatch(
      /-i \S*video-processing-\w+\/[0-9a-f-]{36}(\.webm)?( |$)/,
    );
  }
});

test("processAudio restricts every call", async () => {
  const wav = join(dir, "tone.wav");
  await Bun.$`ffmpeg -y -f lavfi -i ${"sine=frequency=440:duration=1"} ${wav}`.quiet();

  const calls = await logMediaCalls(`
    import { processAudio } from "./AudioProcessing.ts";
    await processAudio(await Bun.file(${JSON.stringify(wav)}).bytes());
  `);

  // The transcode and the waveform pass.
  expectRestricted(calls, 2);
});

test.each([
  { source: 1, stored: 1 },
  { source: 2, stored: 2 },
  { source: 6, stored: 2 },
])(
  "processAudio stores $source channels as $stored",
  async ({ source, stored }) => {
    const wav = join(dir, `channels-${source}.wav`);
    await Bun.$`ffmpeg -y -f lavfi -i ${"sine=frequency=440:duration=1"} -ac ${source} ${wav}`.quiet();

    const { data } = await processAudio(await bytesOf(wav));

    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=channels",
        "-of",
        "csv=p=0",
        "-",
      ],
      { stdin: data, stdout: "pipe" },
    );
    expect((await new Response(proc.stdout).text()).trim()).toBe(
      String(stored),
    );
  },
);

// A command name in code, not in prose: comments are stripped first.
const FFMPEG_CALL = /\bff(mpeg|probe)\b/;
const callsFfmpeg = (source: string): boolean =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .some((line) => FFMPEG_CALL.test(line.replace(/\/\/.*$/, "")));

test("the scan below recognizes a direct call in either style", () => {
  expect(callsFfmpeg('Bun.spawn(["ffmpeg", "-i", path]);')).toBe(true);
  expect(callsFfmpeg("await Bun.$`ffprobe -i ${path}`.quiet();")).toBe(true);
  expect(callsFfmpeg("// shells out to `ffmpeg`, see MediaInput.ts")).toBe(
    false,
  );
});

test("nothing outside MediaInput.ts names ffmpeg or ffprobe", async () => {
  const offenders: string[] = [];
  const files = new Bun.Glob("**/*.ts").scan({ cwd: import.meta.dir });
  for await (const file of files) {
    if (file === "MediaInput.ts" || file.endsWith(".test.ts")) continue;
    if (callsFfmpeg(await Bun.file(join(import.meta.dir, file)).text())) {
      offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
