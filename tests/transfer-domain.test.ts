import { describe, expect, it } from "vitest";
import { summaryText, transferDedupeKey, type Transfer } from "../src/transfer-domain.js";
import { nextScheduledTime } from "../src/time.js";

function transfer(index: number): Transfer {
  return {
    id: `move-${index}`,
    player: `Player ${index}`,
    fromClub: "Club A",
    toClub: "Club B",
    timestamp: Date.UTC(2026, 6, 25, 12, index),
    league: index % 2 ? "League One" : "League Two",
    sourceLinks: [],
    readBy: [],
  };
}

describe("transfer domain", () => {
  it("keeps the same identity when a transfer is reported by multiple sources", () => {
    const first = transfer(1);
    const second = { ...first, sourceLinks: ["https://source.example/report"] };
    expect(transferDedupeKey(first)).toBe(transferDedupeKey(second));
  });

  it("formats daily summaries in pages of fifteen transfers", () => {
    const text = summaryText(Array.from({ length: 16 }, (_, index) => transfer(index)), "Daily transfer summary", 1);
    expect(text).toContain("Player 15");
    expect(text).toContain("Page 2 of 2");
    expect(text).not.toContain("Player 0 —");
  });

  it("schedules 08:00 in the owner timezone", () => {
    const before = Date.UTC(2026, 6, 25, 6, 30);
    const scheduled = nextScheduledTime("08:00", "Europe/London", before);
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(scheduled))).toBe("08:00");
  });
});
