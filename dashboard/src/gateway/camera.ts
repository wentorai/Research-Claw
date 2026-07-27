/**
 * Browser-camera frame capture helper.
 *
 * Isolated in its own module so it can be mocked at the module boundary
 * (PeriphCaptureListener consumes it; T14's "take photo" button reuses it).
 *
 * getUserMedia's real behavior cannot be exercised under happy-dom; the
 * orchestration here is validated with canvas/video mocks in unit tests, and
 * verified against real hardware in T19.
 */

/**
 * Max time to wait for the video element's `loadedmetadata` event before giving
 * up on a capture. Audit #9: some browsers/devices never fire `loadedmetadata`
 * nor `error` after `srcObject` is set (e.g. a camera grabbed by another app, a
 * suspended tab), so a plain event-gated await hangs forever — a manual "take
 * photo" then stays permanently `busy`. A finite deadline turns that hang into a
 * classifiable rejection while `finally` still releases the track.
 */
export const CAPTURE_METADATA_TIMEOUT_MS = 10_000;

/**
 * Capture a single JPEG frame from a browser camera.
 *
 * @param deviceId browser mediaDevice id (gateway forwards device.config.deviceId ?? device.id).
 *        Passed straight through to getUserMedia; a bad id surfaces as
 *        OverconstrainedError / NotFoundError, which callers classify.
 * @returns the JPEG blob plus the source video's intrinsic dimensions.
 * @throws DOMException-shaped errors from getUserMedia (NotAllowedError, NotFoundError,
 *         OverconstrainedError, …), a plain Error if the frame cannot be encoded, and a
 *         `camera-timeout` Error if `loadedmetadata` never arrives within
 *         CAPTURE_METADATA_TIMEOUT_MS (no path is left hanging).
 */
export async function captureFrameFromCamera(
  deviceId: string,
): Promise<{ blob: Blob; width: number; height: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
  });

  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    // Wait until we have real frame dimensions before drawing. A finite timeout
    // guarantees this settles even if neither `loadedmetadata` nor `error` ever
    // fires (audit #9): on timeout we reject with a `camera-timeout` Error, and
    // the outer `finally` stops the track so the camera is never left held.
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('video element failed to load camera stream'));
      };
      const onTimeout = () => {
        cleanup();
        const err = new Error(
          `camera-timeout: no frame within ${CAPTURE_METADATA_TIMEOUT_MS}ms`,
        );
        err.name = 'CameraTimeoutError';
        reject(err);
      };
      const timer = setTimeout(onTimeout, CAPTURE_METADATA_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
      // play() kicks the pipeline; ignore its rejection (metadata event is the gate).
      void video.play().catch(() => undefined);
    });

    const width = video.videoWidth;
    const height = video.videoHeight;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
        'image/jpeg',
        0.85,
      );
    });

    return { blob, width, height };
  } finally {
    // Always release the camera, even on failure.
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}
