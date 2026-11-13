/// <reference types="bun" />
import { expect, test } from "bun:test";
import { filterContacts } from "./contactFilter";

const contacts = [
  { username: "bob", displayName: "Robert" },
  { username: "carol", displayName: null },
  { username: "boris", displayName: "Bo" },
  { username: "dave", displayName: "Dave Bowman" },
];

const names = (list: { username: string }[]) => list.map((u) => u.username);

test("a blank query keeps every contact, in order", () => {
  expect(names(filterContacts(contacts, ""))).toEqual([
    "bob",
    "carol",
    "boris",
    "dave",
  ]);
  expect(names(filterContacts(contacts, "   "))).toEqual(names(contacts));
});

test("matches a fragment of either name, case-insensitively, keeping order", () => {
  expect(names(filterContacts(contacts, "BO"))).toEqual([
    "bob",
    "boris",
    "dave",
  ]);
  expect(names(filterContacts(contacts, "ro"))).toEqual(["bob", "carol"]);
  expect(names(filterContacts(contacts, " c "))).toEqual(["carol"]);
  expect(filterContacts(contacts, "zz")).toEqual([]);
});
