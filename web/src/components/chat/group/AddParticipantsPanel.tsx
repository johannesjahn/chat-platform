import { useState } from "react";
import { Loader2, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Input } from "@/components/ui/input";
import { $api, MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import { MAX_GROUP_PARTICIPANTS, type Chat } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userHandle, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

/**
 * "Add people" under a group's members, for its owner/admins: search users,
 * pick some, add them. Split out of GroupSettingsSections in issue #811.
 * Always rendered (empty unless `canManage`), so a half-made selection
 * survives a role change; failures go to the settings' shared error line.
 */
export function AddParticipantsPanel({
  chat,
  canManage,
  onError: setActionError,
  onAdded: invalidateChat,
}: {
  chat: Chat;
  canManage: boolean;
  onError: (message: string | null) => void;
  onAdded: () => Promise<void>;
}) {
  const chatId = chat.id;
  const addParticipants = $api.useMutation("post", "/chats/{id}/participants");
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [addParticipantsSearch, setAddParticipantsSearch] = useState("");
  const [selectedToAdd, setSelectedToAdd] = useState<number[]>([]);

  const addParticipantsQuery = useDebouncedValue(
    addParticipantsSearch.trim(),
    300,
  );
  const addParticipantsSearchReady =
    addParticipantsQuery.length >= MIN_USER_SEARCH_QUERY_LENGTH;
  const { data: userSearchResults, isLoading: userSearchLoading } =
    $api.useQuery(
      "get",
      "/users/search",
      { params: { query: { q: addParticipantsQuery } } },
      { enabled: addingParticipants && addParticipantsSearchReady },
    );
  const canAddMore = chat.participants.length < MAX_GROUP_PARTICIPANTS;
  const candidatesToAdd = (userSearchResults ?? []).filter(
    (u) => !chat.participants.some((p) => p.userId === u.id),
  );

  async function handleAddParticipants() {
    if (selectedToAdd.length === 0) return;
    setActionError(null);
    try {
      await addParticipants.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { participantIds: selectedToAdd },
      });
      await invalidateChat();
      setSelectedToAdd([]);
      setAddingParticipants(false);
      setAddParticipantsSearch("");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  if (!canManage) return null;
  return (
    <div className="mt-1">
      {canAddMore ? (
        <Button
          variant="outline"
          className="w-full"
          aria-label="Add participants"
          onClick={() => {
            setAddingParticipants((v) => !v);
            setAddParticipantsSearch("");
            setSelectedToAdd([]);
          }}
        >
          <UserPlus className="size-4" />
          {addingParticipants ? "Cancel" : "Add people"}
        </Button>
      ) : (
        <p className="text-center text-xs text-muted-foreground">
          This group is full ({MAX_GROUP_PARTICIPANTS} members).
        </p>
      )}

      <Collapse open={addingParticipants && canAddMore}>
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-background/60 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={addParticipantsSearch}
              onChange={(e) => setAddParticipantsSearch(e.target.value)}
              placeholder="Search users to add…"
              className="pl-9"
            />
          </div>
          {!addParticipantsSearchReady ? (
            <p className="text-xs text-muted-foreground">
              Type at least {MIN_USER_SEARCH_QUERY_LENGTH} characters to search.
            </p>
          ) : userSearchLoading ? (
            <p className="text-xs text-muted-foreground">Searching…</p>
          ) : candidatesToAdd.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No matching users to add.
            </p>
          ) : (
            <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
              {candidatesToAdd.map((u) => {
                const isSelected = selectedToAdd.includes(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() =>
                      setSelectedToAdd((prev) =>
                        isSelected
                          ? prev.filter((id) => id !== u.id)
                          : [...prev, u.id],
                      )
                    }
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs transition-colors duration-200 motion-safe:hover:scale-[1.03]",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background/60 hover:border-primary/40",
                    )}
                  >
                    {userLabel(u)}
                    {userHandle(u) && (
                      <span
                        className={cn(
                          "ml-1",
                          !isSelected && "text-muted-foreground",
                        )}
                      >
                        {userHandle(u)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <Button
            className="self-end"
            disabled={selectedToAdd.length === 0 || addParticipants.isPending}
            onClick={() => void handleAddParticipants()}
          >
            {addParticipants.isPending && (
              <Loader2 className="size-4 animate-spin" />
            )}
            Add {selectedToAdd.length || ""}
          </Button>
        </div>
      </Collapse>
    </div>
  );
}
