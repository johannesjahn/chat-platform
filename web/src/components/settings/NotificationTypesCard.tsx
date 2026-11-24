import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NOTIFICATION_ICONS } from "@/components/notificationIcons";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchClient } from "@/lib/api";
import type { components } from "@/lib/api-types";
import { errorMessage } from "@/lib/errors";
import {
  notificationPreferencesQueryKey,
  type NotificationType,
} from "@/lib/notifications";

type Preferences = components["schemas"]["NotificationPreferences"];

const TYPES: ReadonlyArray<{ type: NotificationType; label: string }> = [
  { type: "comment", label: "Comments on your posts" },
  { type: "reply", label: "Replies to your comments" },
  { type: "reaction", label: "Reactions" },
  { type: "mention", label: "Mentions" },
  { type: "game_invite", label: "Game invites" },
  { type: "game_record", label: "Lost leaderboard records" },
];

/** Which kinds of notification reach the bell and inbox (issue #900). */
export function NotificationTypesCard() {
  const queryClient = useQueryClient();
  const [saveError, setSaveError] = useState<string | null>(null);
  const { data, error } = useQuery({
    queryKey: notificationPreferencesQueryKey,
    queryFn: async ({ signal }) => {
      const { data: preferences, error: failure } = await fetchClient.GET(
        "/notifications/preferences",
        { signal },
      );
      if (failure) throw failure;
      return preferences;
    },
  });
  const save = useMutation({
    mutationFn: async (body: Partial<Preferences>) => {
      const { data: preferences, error: failure } = await fetchClient.PATCH(
        "/notifications/preferences",
        { body },
      );
      if (failure) throw failure;
      return preferences;
    },
    mutationKey: notificationPreferencesQueryKey,
    // Shown at once; the response of the last save still out settles it.
    onMutate: (changes) => {
      setSaveError(null);
      queryClient.setQueryData<Preferences>(
        notificationPreferencesQueryKey,
        (current) => current && { ...current, ...changes },
      );
    },
    onSuccess: (preferences) => {
      if (
        queryClient.isMutating({
          mutationKey: notificationPreferencesQueryKey,
        }) === 1
      )
        queryClient.setQueryData(notificationPreferencesQueryKey, preferences);
    },
    onError: (failure) => {
      setSaveError(errorMessage(failure));
      return queryClient.invalidateQueries({
        queryKey: notificationPreferencesQueryKey,
      });
    },
  });
  const failure = saveError ?? (error ? errorMessage(error) : null);

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>What to notify you about</CardTitle>
        <CardDescription>
          Anything you turn off no longer reaches your notifications, on every
          device. What&apos;s already there stays.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {failure && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {failure}
          </p>
        )}
        {data
          ? TYPES.map(({ type, label }) => {
              const Icon = NOTIFICATION_ICONS[type];
              return (
                <label
                  key={type}
                  className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm transition-colors hover:bg-accent/50"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{label}</span>
                  <input
                    type="checkbox"
                    className="size-6 shrink-0 accent-primary"
                    checked={data[type]}
                    onChange={(e) => save.mutate({ [type]: e.target.checked })}
                  />
                </label>
              );
            })
          : !error && <Skeleton className="h-60 w-full rounded-lg" />}
      </CardContent>
    </Card>
  );
}
