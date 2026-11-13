import {
  AtSign,
  Bell,
  CornerDownRight,
  MessageSquare,
  Swords,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import type { Notification } from "@/lib/notifications";

// Each type's badge glyph, shared by the rows and the inbox's preview pane.
// Not in lib/notifications.ts, which the shell's bell badge keeps in the
// entry chunk: the glyphs would ride along to every cold load (issue #754).
export const NOTIFICATION_ICONS: Record<Notification["type"], LucideIcon> = {
  comment: MessageSquare,
  reply: CornerDownRight,
  reaction: Bell,
  mention: AtSign,
  game_invite: Swords,
  game_record: Trophy,
};
