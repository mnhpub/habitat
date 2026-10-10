// Browser recording of the video room. Everyone's camera is tiled onto one canvas, everyone's audio is mixed,
// and MediaRecorder writes WebM. Each ten-second slice is uploaded in order as one part; the server keeps
// them in R2 and joins them when the recording is downloaded.

const WIDTH = 1280;
const HEIGHT = 720;
const SLICE_MS = 10_000;
const FPS = 15;
const UPLOAD_ATTEMPTS = 4;

export interface SessionRecorder {
  /** Finish the file: flush the last part, then stop. Resolves once every part is uploaded. */
  stop(): Promise<void>;
}

/**
 * Record whatever `streams()` returns, re-read on every frame so people who join or leave mid-session
 * appear and disappear. `onFailure` is called once if a part cannot be uploaded; recording then stops.
 */
export function startSessionRecording(
  eventId: string,
  recordingId: string,
  streams: () => MediaStream[],
  onFailure: (message: string) => void,
): SessionRecorder {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d')!;
  const audio = new AudioContext();
  const mixDestination = audio.createMediaStreamDestination();
  const videos = new Map<MediaStream, HTMLVideoElement>();
  const sources = new Map<MediaStream, MediaStreamAudioSourceNode>();
  let running = true;

  /** Attach newcomers and detach people who left. */
  const sync = () => {
    const current = streams();
    for (const stream of current) {
      if (!videos.has(stream)) {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        void video.play().catch(() => undefined);
        videos.set(stream, video);
      }
      if (stream.getAudioTracks().length && !sources.has(stream)) {
        const node = audio.createMediaStreamSource(stream);
        node.connect(mixDestination);
        sources.set(stream, node);
      }
    }
    for (const stream of [...videos.keys()]) if (!current.includes(stream)) videos.delete(stream);
    for (const [stream, node] of [...sources]) {
      if (current.includes(stream)) continue;
      node.disconnect();
      sources.delete(stream);
    }
  };

  /** Tile every live camera in a grid. Interval-driven, so it keeps running when the tab is in the background. */
  const draw = () => {
    if (!running) return;
    sync();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const live = [...videos.values()].filter((v) => v.readyState >= 2);
    const count = Math.max(live.length, 1);
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const cellW = WIDTH / cols;
    const cellH = HEIGHT / rows;
    live.forEach((video, i) => {
      ctx.drawImage(video, (i % cols) * cellW, Math.floor(i / cols) * cellH, cellW, cellH);
    });
  };
  const timer = setInterval(draw, 1000 / FPS);

  const mixed = new MediaStream([
    ...canvas.captureStream(FPS).getVideoTracks(),
    ...mixDestination.stream.getAudioTracks(),
  ]);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm';
  const recorder = new MediaRecorder(mixed, { mimeType });

  // Parts are numbered when they are produced and uploaded one after another, so the server sees them in order.
  let next = 0;
  let queue: Promise<void> = Promise.resolve();
  let failed = false;
  const upload = async (part: number, blob: Blob) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`/api/events/${eventId}/recordings/${recordingId}/parts/${part}`, {
          method: 'POST', body: blob, credentials: 'same-origin',
        });
        if (res.ok) return;
        if (res.status === 409 || res.status === 403 || res.status === 404) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? 'Upload refused');
        throw new Error(`Upload failed (${res.status})`);
      } catch (err) {
        if (attempt >= UPLOAD_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  };

  recorder.ondataavailable = (ev) => {
    if (!ev.data.size) return;
    const part = next++;
    // Failure is reported and the caller stops the recording. It must not wait on the queue from in here.
    queue = queue.then(() => upload(part, ev.data)).catch((err: unknown) => {
      if (failed) return;
      failed = true;
      onFailure(err instanceof Error ? err.message : 'A part could not be uploaded');
    });
  };
  recorder.start(SLICE_MS);

  const stopRecorder = () => new Promise<void>((resolve) => {
    if (recorder.state === 'inactive') return resolve();
    recorder.onstop = () => resolve();
    recorder.stop();
  });

  return {
    async stop() {
      running = false;
      clearInterval(timer);
      await stopRecorder();
      await queue;
      sources.forEach((node) => node.disconnect());
      sources.clear();
      videos.clear();
      mixed.getTracks().forEach((t) => t.stop());
      void audio.close();
    },
  };
}
