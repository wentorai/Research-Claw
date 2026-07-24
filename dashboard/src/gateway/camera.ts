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
 * Capture a single JPEG frame from a browser camera.
 *
 * @param deviceId browser mediaDevice id (gateway forwards device.config.deviceId ?? device.id).
 *        Passed straight through to getUserMedia; a bad id surfaces as
 *        OverconstrainedError / NotFoundError, which callers classify.
 * @returns the JPEG blob plus the source video's intrinsic dimensions.
 * @throws DOMException-shaped errors from getUserMedia (NotAllowedError, NotFoundError,
 *         OverconstrainedError, …) and a plain Error if the frame cannot be encoded.
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

    // Wait until we have real frame dimensions before drawing.
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('video element failed to load camera stream'));
      };
      const cleanup = () => {
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
