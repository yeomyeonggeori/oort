import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HOOK = readFileSync(new URL("./useReminders.ts", import.meta.url), "utf8");
const ROW = readFileSync(
  new URL("../timeline/MessageRow.tsx", import.meta.url),
  "utf8"
);
const DIALOG = readFileSync(new URL("./RemindDialog.tsx", import.meta.url), "utf8");

describe("reminder query and create mutation wiring", () => {
  it("keeps polling while the document is hidden and refetches on focus", () => {
    expect(HOOK).toContain("refetchIntervalInBackground: true");
    expect(HOOK).toContain('refetchOnWindowFocus: "always"');
  });

  it("MessageRow consumes create through the shared mutation, not a singleton client", () => {
    expect(ROW).toContain("useReminderMutations");
    expect(ROW).toContain("reminderMutations.create.mutate");
    expect(ROW).not.toMatch(/from ["']@\/app\/queryClient["']/);
    expect(ROW).not.toContain("createReminder(");
  });

  it("snooze commit names the verb 알림 미루기", () => {
    expect(DIALOG).toContain("REMINDER_SNOOZE_COMMIT_LABEL");
  });
});
