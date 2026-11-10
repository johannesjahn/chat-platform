/**
 * Whether a keydown belongs to an IME composition (Japanese, Chinese,
 * Korean, …) rather than to the app (issue #759). With an IME, Enter first
 * confirms the composed text — an Enter handler that doesn't check this
 * sends or submits the half-typed text.
 *
 * `isComposing` covers most browsers; Safari reports `isComposing: false`
 * on the keydown that confirms a composition, but still gives it the
 * legacy `keyCode` 229 ("IME is processing this key"), hence both checks.
 * Accepts a React keyboard event (reads its `nativeEvent`) or a native one.
 */
export function isImeComposing(
  event:
    | { nativeEvent: { isComposing?: boolean; keyCode?: number } }
    | { isComposing?: boolean; keyCode?: number },
): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing === true || native.keyCode === 229;
}
