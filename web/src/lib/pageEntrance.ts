// Rows and cards fade/slide in on mount (`animate-in` + `stagger-in`) so
// content arriving from the network lands gently instead of popping in. On a
// change of page that's the wrong moment: the page itself already enters
// through the view transition (see router.tsx and "View transitions" in
// styles.css), so content rendered straight from the cache would animate a
// second time, outlasting the 320ms page enter, and read as the page blinking
// once it settles — most visibly on the chat list and the profile.
//
// So once a new page has rendered, every entrance animation already running
// in the page column is finished on the spot: what was on screen at the swap
// arrives with the page, and anything mounted afterwards — data that wasn't
// cached, a new realtime row, the next infinite-scroll page — still animates
// in as before. `enter` is tw-animate-css's keyframes behind `animate-in`.
const ENTRANCE_ANIMATIONS = new Set(["enter"]);

export function settlePageEntrance(): void {
  if (typeof document === "undefined" || !document.getAnimations) return;
  const column = document.querySelector("[data-app-column]");
  if (!column) return;
  for (const animation of document.getAnimations()) {
    if (!(animation instanceof CSSAnimation)) continue;
    if (!ENTRANCE_ANIMATIONS.has(animation.animationName)) continue;
    const target =
      animation.effect instanceof KeyframeEffect && animation.effect.target;
    if (target && column.contains(target)) animation.finish();
  }
}
