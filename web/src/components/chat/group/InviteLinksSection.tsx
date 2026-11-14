import { useState } from "react";
import { Check, Copy, Link2, Loader2, X } from "lucide-react";
import { DetailsSection as Section } from "@/components/chat/DetailsSection";
import { Button } from "@/components/ui/button";
import { $api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * A group's invite links (issue #220), for its owner/admins: list, copy,
 * revoke, create. Split out of GroupSettingsSections in issue #811. Always
 * rendered — it fetches the list for every member, as the settings always
 * have — and empty unless `canManage`. Failures go to the settings' shared
 * error line through `onError`.
 */
export function InviteLinksSection({
  chatId,
  canManage,
  onError: setActionError,
}: {
  chatId: number;
  canManage: boolean;
  onError: (message: string | null) => void;
}) {
  const createInvite = $api.useMutation("post", "/chats/{id}/invites");
  const revokeInvite = $api.useMutation(
    "delete",
    "/chats/{id}/invites/{inviteId}",
  );
  const {
    data: invites,
    isLoading: invitesLoading,
    refetch: refetchInvites,
  } = $api.useQuery("get", "/chats/{id}/invites", {
    params: { path: { id: String(chatId) } },
  });
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);
  // Captured once on mount so the render stays pure — good enough for showing
  // whether an invite has lapsed; it refreshes each time the dialog reopens
  // (or the panel opens on another chat).
  const [now] = useState(() => Date.now());

  async function handleCreateInvite() {
    setActionError(null);
    try {
      await createInvite.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: {},
      });
      await refetchInvites();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleRevokeInvite(inviteId: number) {
    setActionError(null);
    try {
      await revokeInvite.mutateAsync({
        params: { path: { id: String(chatId), inviteId: String(inviteId) } },
      });
      await refetchInvites();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleCopyInviteLink(inviteId: number, code: string) {
    const url = `${window.location.origin}/chats/join/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedInviteId(inviteId);
      setTimeout(
        () => setCopiedInviteId((prev) => (prev === inviteId ? null : prev)),
        2000,
      );
    } catch {
      setActionError("Couldn't copy the link — copy it manually.");
    }
  }

  const activeInvites = (invites ?? []).filter((i) => i.revokedAt === null);
  if (!canManage) return null;
  return (
    <Section
      index={3}
      icon={<Link2 className="size-4" />}
      title="Invite links"
      description="Anyone with an active link can join this chat — revoke a link to cut off access."
    >
      <div className="flex flex-col gap-2">
        {invitesLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : activeInvites.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            No active invite links yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {activeInvites.map((invite) => {
              const expired =
                invite.expiresAt !== null && invite.expiresAt <= now;
              const usedUp =
                invite.maxUses !== null && invite.useCount >= invite.maxUses;
              return (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background/60 px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {invite.code.slice(0, 12)}…
                    {(expired || usedUp) && (
                      <span className="ml-1 text-destructive">
                        ({expired ? "expired" : "used up"})
                      </span>
                    )}
                    {invite.maxUses !== null &&
                      ` · ${invite.useCount}/${invite.maxUses} used`}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label="Copy invite link"
                      onClick={() =>
                        void handleCopyInviteLink(invite.id, invite.code)
                      }
                    >
                      {copiedInviteId === invite.id ? (
                        <Check className="size-4 text-green-600" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-destructive hover:text-destructive"
                      aria-label="Revoke invite link"
                      disabled={revokeInvite.isPending}
                      onClick={() => void handleRevokeInvite(invite.id)}
                    >
                      <X className="size-4" />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Button
          variant="outline"
          className="w-full"
          disabled={createInvite.isPending}
          onClick={() => void handleCreateInvite()}
        >
          {createInvite.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Link2 className="size-4" />
          )}
          Create invite link
        </Button>
      </div>
    </Section>
  );
}
