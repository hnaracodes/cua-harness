import { expect, test, type Page } from "@playwright/test";

// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const png = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

async function home(page: Page, query = "?mock") {
  await page.goto(`/${query}`);
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
}

test("Enter sends, Shift+Enter makes a newline", async ({ page }) => {
  await home(page);
  const input = page.getByTestId("composer-input");
  await input.click();
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  await expect(input).toHaveValue("line one\nline two");
  await expect(page.getByTestId("composer-send")).toBeEnabled();
});

test("rejects bad attachments on their own chip; a good image still sends", async ({ page }) => {
  await home(page);
  await page.getByTestId("composer-file").setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") },
    { name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(6 * 1024 * 1024, 1) },
  ]);
  await expect(page.getByTestId("attachment-error")).toHaveCount(2);
  await expect(page.getByTestId("attachment-error").first()).toContainText("Unsupported type text/plain");
  await expect(page.getByTestId("attachment-error").nth(1)).toContainText("5 MB or smaller");
  await page.getByTestId("composer-file").setInputFiles([png("ok.png")]);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(3);
  await expect(page.getByText("Sent to Anthropic with your task.")).toBeVisible();
  await page.getByTestId("composer-input").fill("Fill this form using the screenshot I attach");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
});

test("a fifth image is rejected", async ({ page }) => {
  await home(page);
  await page.getByTestId("composer-file").setInputFiles([png("1.png"), png("2.png"), png("3.png"), png("4.png"), png("5.png")]);
  await expect(page.getByTestId("attachment-error")).toHaveCount(1);
  await expect(page.getByTestId("attachment-error")).toContainText("At most 4 images per task.");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(5);
});

test("removing an attached image removes its chip and the note", async ({ page }) => {
  await home(page);
  await page.getByTestId("composer-file").setInputFiles([png("a.png")]);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1);
  await page.getByRole("button", { name: "Remove image" }).click();
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  await expect(page.getByText("Sent to Anthropic with your task.")).toHaveCount(0);
});

test("suggestions fill the composer and never send", async ({ page }) => {
  await home(page);
  await expect(page.getByTestId("home-suggestion")).toHaveCount(3);
  await page.getByTestId("home-suggestion").nth(1).click();
  await expect(page.getByTestId("composer-input")).toHaveValue("Draft a reply to my latest email (don't send it)");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
  await expect(page.getByTestId("boundary-canvas")).toHaveCount(0);
  await expect(page.getByText("Chrome (agent's own)")).toBeVisible();
});

test("history lists a finished task and reopening it replays the run chat", async ({ page }) => {
  test.setTimeout(120_000);
  await home(page);
  await page.getByTestId("composer-input").fill("Find a tennis racket under $100");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("boundary-canvas")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("approve-all").click();
  await page.getByTestId("run-primary").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("new-task").click();
  await expect(page.getByRole("heading", { name: "What should the agent do?" })).toBeVisible();
  await page.getByTestId("history-toggle").click();
  await expect(page.getByTestId("history-item")).toHaveCount(1);
  await expect(page.getByTestId("history-item")).toContainText("Find a tennis racket under $100");
  await page.getByTestId("history-item").click();
  await expect(page.getByTestId("chat-recap")).toBeVisible({ timeout: 10_000 });
});

test("health pill shows Ready and opens its details", async ({ page }) => {
  await home(page);
  const pill = page.getByTestId("health-pill");
  await expect(pill).toContainText("Ready");
  await pill.click();
  await expect(page.getByRole("dialog", { name: "Daemon status" })).toContainText("This session");
});

test("daemon down: pill and banner say Reconnecting…, sending is blocked with a reason", async ({ page }) => {
  await page.goto("/?mock&down=1");
  await expect(page.getByTestId("health-pill")).toContainText("Reconnecting…", { timeout: 10_000 });
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting to the daemon…" })).toBeVisible();
  await page.getByTestId("composer-input").fill("anything");
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await expect(page.getByText("The daemon is reconnecting…")).toBeVisible();
});
