import { describe, expect, it } from "vitest";

import {
  approxStringWidth,
  buildSearchEntries,
  formatDetailLines,
  getSelectAllState,
  toggleAllItems,
  toggleSearchEntry,
  visualRowsForLine,
} from "../src/ui/search-multiselect.js";
import type { SearchItem } from "../src/ui/search-multiselect.js";

const items: SearchItem<string>[] = [
  { value: "a", label: "Alpha", group: "Group 1" },
  { value: "b", label: "Beta", group: "Group 1" },
  { value: "c", label: "Gamma" },
];

describe("buildSearchEntries", () => {
  it("returns flat items when groups are not selectable", () => {
    const entries = buildSearchEntries(items, false);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.type === "item")).toBe(true);
  });

  it("collapses group headings into one entry when collapsed", () => {
    const expanded = buildSearchEntries(items, true);
    expect(expanded).toHaveLength(4); // group + 2 items + item

    const collapsed = buildSearchEntries(items, true, new Set(["Group 1"]));
    expect(collapsed).toHaveLength(2); // collapsed group + lone item
    expect(collapsed[0]).toMatchObject({ type: "group", collapsed: true });
  });

  it("groups consecutive items sharing a group name", () => {
    const entries = buildSearchEntries(items, true);
    const group = entries.find((e) => e.type === "group");
    expect(group?.type === "group" && group.items.map((i) => i.value)).toEqual(["a", "b"]);
  });
});

describe("toggleSearchEntry", () => {
  it("toggles a single item", () => {
    const selected = new Set<string>();
    toggleSearchEntry(selected, { type: "item", item: items[0]! });
    expect(selected.has("a")).toBe(true);
    toggleSearchEntry(selected, { type: "item", item: items[0]! });
    expect(selected.has("a")).toBe(false);
  });

  it("selects all group items when any are unselected, clears when all selected", () => {
    const selected = new Set<string>(["a"]);
    const group = buildSearchEntries(items, true)[0]!;
    toggleSearchEntry(selected, group);
    expect([...selected].sort()).toEqual(["a", "b"]);
    toggleSearchEntry(selected, group);
    expect(selected.size).toBe(0);
  });
});

describe("select all", () => {
  it("reports none/partial/all states", () => {
    expect(getSelectAllState(new Set(), items)).toBe("none");
    expect(getSelectAllState(new Set(["a", "b"]), items)).toBe("partial");
    expect(getSelectAllState(new Set(["a", "b", "c"]), items)).toBe("all");
  });

  it("toggleAllItems selects everything or clears everything", () => {
    const selected = new Set<string>();
    toggleAllItems(selected, items);
    expect(selected.size).toBe(3);
    toggleAllItems(selected, items);
    expect(selected.size).toBe(0);
  });
});

describe("formatDetailLines", () => {
  it("pads to the fixed line count", () => {
    expect(formatDetailLines(undefined, 40, 2)).toEqual(["", ""]);
    expect(formatDetailLines("short", 40, 2)).toEqual(["short", ""]);
  });

  it("wraps long text at word boundaries and truncates with ellipsis", () => {
    const lines = formatDetailLines("word ".repeat(30).trim(), 20, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
  });
});

describe("terminal width helpers", () => {
  it("measures ascii and wide characters", () => {
    expect(approxStringWidth("abc")).toBe(3);
    expect(approxStringWidth("漢字")).toBe(4);
  });

  it("counts wrapped rows for overlong lines", () => {
    expect(visualRowsForLine("short", 80)).toBe(1);
    expect(visualRowsForLine("x".repeat(81), 80)).toBe(2);
  });
});
