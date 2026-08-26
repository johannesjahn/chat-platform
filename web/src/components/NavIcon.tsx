import type { LucideIcon } from "lucide-react";

import { useLogoPress } from "@/lib/logoPress";
import { cn } from "@/lib/utils";

export type NavIconProps = {
  icon: LucideIcon;
  className?: string;
};

/**
 * An icon in the top nav, animated like the brand mark next to it: the same
 * tilt-and-grow on hover, a matching primary-coloured glow, and the shared
 * `logo-press` pop when its button or link is clicked (see `useLogoPress`).
 *
 * It renders the bare `<svg>` — no wrapper — so it stays a direct child of the
 * surrounding Button and keeps that component's `[&_svg]` / `has-[>svg]`
 * sizing and padding rules working. Hover is driven by the `nav-icon` group on
 * that control, so hovering anywhere on the button animates the icon.
 *
 * Both animations are `prefers-reduced-motion`-aware (the transition through
 * `motion-safe:`, the pop through the reduced-motion block in styles.css), so
 * with motion reduced this is a plain static icon.
 */
export function NavIcon({ icon: Icon, className }: NavIconProps) {
  const { ref, pressed, endPress } = useLogoPress<SVGSVGElement>();

  return (
    <Icon
      ref={ref}
      aria-hidden
      onAnimationEnd={endPress}
      className={cn(
        // Tailwind's `scale`/`rotate` utilities set those as their own
        // properties rather than folding into `transform`, so they have to be
        // named here or the hover tilt would snap instead of easing.
        "size-4 transition-[transform,translate,scale,rotate,filter] duration-300 ease-out",
        "motion-safe:group-hover/nav-icon:-rotate-6 motion-safe:group-hover/nav-icon:scale-110",
        "group-hover/nav-icon:drop-shadow-[0_0_6px_var(--primary)]",
        pressed && "animate-logo-press",
        className,
      )}
    />
  );
}
