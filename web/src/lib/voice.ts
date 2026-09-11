// Whether this browser can record a voice message at all. Both the chat
// composer (which offers a mic button only where recording works) and
// VoiceRecorderField itself gate on this, so the two can't disagree about
// whether the feature exists.
//
// It's a function rather than a module-level const so the answer is read
// from the live browser at the point it's needed, not captured once at
// import time (where a server-rendered pass would bake in `false`).
export function canRecordVoice(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}
