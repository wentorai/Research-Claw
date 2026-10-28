# Browser voice input

The chat composer offers Mandarin (`zh-CN`) dictation when the browser exposes
`SpeechRecognition` or `webkitSpeechRecognition`. Unsupported browsers retain the
normal text composer without a microphone button. API presence does not guarantee
that the browser's recognition service is available.

On first use in a mounted composer, a notice explains that the browser may send
audio to its provider's online recognition service. This is not an offline-only
feature. Research-Claw does not upload or store audio, and no model API key is
required for dictation. Browser/network requirements and microphone permissions
still apply; use localhost or HTTPS when testing.

Click the microphone to begin. Interim and final recognition results appear in a
separate preview while the existing draft remains editable. Click Stop to request
the final result; it is appended to the latest draft when recognition ends. Cancel
discards the entire pending dictation. Sending is blocked during recognition and
its finalization. Review and send the draft manually afterward.

Recognition does not automatically restart. Errors, cancellation, session changes,
disconnection, and page navigation release the microphone and restore normal text
input. Startup/finalization timeouts prevent a stuck recognition implementation
from blocking Send indefinitely. Interim-only text is never silently committed.

## Verification

Automated tests simulate recognition events to cover result revisions, final-result
deduplication, Stop versus Cancel, errors, timeouts, stale session callbacks,
disconnect/unmount cleanup, draft preservation, and keyboard-send blocking.

Before claiming support for a browser version, manually verify with a microphone:

1. Start from an existing draft; accept the notice and browser microphone prompt.
2. Speak Mandarin, inspect the preview, edit the draft, then Stop and verify a
   single appended transcript. Confirm no message was sent automatically.
3. Repeat with Cancel, silence, denied permissions, and recognition-service failure.
4. Switch conversations while listening; verify neither saved draft is overwritten.
5. Verify ordinary text input in a browser without recognition support.

Mock tests do not establish recognition accuracy, network availability, or actual
microphone support. Record browser/version and real-audio results separately.

API behavior: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
