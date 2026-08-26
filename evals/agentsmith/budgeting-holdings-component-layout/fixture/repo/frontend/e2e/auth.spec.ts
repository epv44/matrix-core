import { expect, test } from "@playwright/test";

const user = {
  id: "user-1",
  username: "owner",
  email: "owner@example.com",
  household_id: "household-1",
  role: "ADMIN",
  is_active: 1,
  must_change_password: 0,
};

test("initial setup collects household, username, email, and password", async ({ page }) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setup_required: true } }),
  );
  await page.route("**/api/auth/setup", (route) =>
    route.fulfill({ json: { user, csrf_token: "csrf-test" } }),
  );
  await page.goto("/");

  await expect(page.getByPlaceholder("Your display name")).toHaveCount(0);
  await page.getByPlaceholder("Household name").fill("Our home");
  await page.getByPlaceholder("Username").fill("owner");
  await page.getByPlaceholder("Email").fill("owner@example.com");
  await page.getByPlaceholder("Password (12+ characters)").fill("a-secure-password");
  const requestPromise = page.waitForRequest("**/api/auth/setup");
  await page.getByRole("button", { name: "Create household" }).click();

  expect((await requestPromise).postDataJSON()).toEqual({
    household_name: "Our home",
    username: "owner",
    email: "owner@example.com",
    password: "a-secure-password",
  });
});

test("sign in uses email and password only", async ({ page }) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setup_required: false } }),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, json: { detail: "Authentication required" } }),
  );
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({ json: { user, csrf_token: "csrf-test" } }),
  );
  await page.goto("/");

  await expect(page.getByPlaceholder("Username")).toHaveCount(0);
  await page.getByPlaceholder("Email").fill("owner@example.com");
  await page.getByPlaceholder("Password (12+ characters)").fill("a-secure-password");
  const requestPromise = page.waitForRequest("**/api/auth/login");
  await page.getByRole("button", { name: "Sign in" }).click();

  expect((await requestPromise).postDataJSON()).toEqual({
    email: "owner@example.com",
    password: "a-secure-password",
  });
});

test("invited member chooses their own username and password", async ({ page }) => {
  const member = { ...user, username: "partner", email: "partner@example.com", role: "MEMBER" };
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({ json: { setup_required: false } }),
  );
  await page.route("**/api/auth/invitations/inspect", (route) =>
    route.fulfill({
      json: {
        invitation: {
          id: "invitation-1",
          email: "partner@example.com",
          household_name: "Our household",
          expires_at: "2030-01-01T00:00:00+00:00",
          created_at: "2026-01-01T00:00:00+00:00",
        },
      },
    }),
  );
  await page.route("**/api/auth/invitations/accept", (route) =>
    route.fulfill({ json: { user: member, csrf_token: "csrf-member" } }),
  );
  await page.goto("/invite/single-use-token");

  await expect(page.getByText("Invited as partner@example.com")).toBeVisible();
  await page.getByPlaceholder("Username").fill("partner");
  await page.getByPlaceholder("Password (12+ characters)").fill("partner-chosen-password");
  await page.getByPlaceholder("Confirm password").fill("partner-chosen-password");
  const requestPromise = page.waitForRequest("**/api/auth/invitations/accept");
  await page.getByRole("button", { name: "Create account" }).click();

  expect((await requestPromise).postDataJSON()).toEqual({
    token: "single-use-token",
    username: "partner",
    password: "partner-chosen-password",
  });
  await expect(page).toHaveURL("/");
});
