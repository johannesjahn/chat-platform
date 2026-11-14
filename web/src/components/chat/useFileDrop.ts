import { useState } from "react";

// Drop a file anywhere on the conversation — thread, header, composer —
// and it becomes the message's attachment (issue #554), not just on the
// composer's own small upload field. Only drags carrying files count, so
// dragging selected text around the page doesn't raise the overlay. Spread
// `handlers` onto the drop target and show <DropOverlay /> while `dragging`.
export function useFileDrop(onFile: (file: File) => void) {
  // A counter rather than a flag, because `dragenter`/`dragleave` fire for
  // every child crossed on the way.
  const [dragDepth, setDragDepth] = useState(0);
  const draggingFiles = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files");
  function onDragEnter(e: React.DragEvent) {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    setDragDepth((depth) => depth + 1);
  }
  function onDragOver(e: React.DragEvent) {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    if (!draggingFiles(e)) return;
    setDragDepth((depth) => Math.max(0, depth - 1));
  }
  function onDrop(e: React.DragEvent) {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    setDragDepth(0);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }
  return {
    dragging: dragDepth > 0,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
