import { test as setup, expect } from '@playwright/test';
import path from 'path';

const STORAGE_STATE_PATH = path.resolve(import.meta.dirname, '../.auth/user.json');

const E2E_USER = {
  email: 'e2e@tracearr.test',
  name: 'E2E Owner',
  username: 'e2eowner',
  password: 'TestPassword123!',
};

setup('authenticate', async ({ page }) => {
  await page.goto('/login');

  // Wait for setup status check to complete and form to render
  await page.waitForSelector('form');

  // Handle claim code gate if present (only shown on first-time setup when CLAIM_CODE is configured)
  const claimCodeInput = page.locator('#gate-claimCode');
  if (await claimCodeInput.isVisible().catch(() => false)) {
    const claimCode = process.env.CLAIM_CODE;
    if (!claimCode) {
      throw new Error(
        'Claim code gate is showing but CLAIM_CODE env var is not set. ' +
          'Set CLAIM_CODE to match the server configuration.'
      );
    }
    await claimCodeInput.fill(claimCode);
    await page.getByRole('button', { name: 'Validate Claim Code' }).click();

    // Wait for the gate to dismiss and the signup form to appear
    await page.waitForSelector('#email', { timeout: 10_000 });
  }

  // Determine if this is first-time setup (signup) or returning user (login)
  const createAccountButton = page.getByRole('button', { name: 'Create Account' });
  const signInButton = page.getByRole('button', { name: 'Sign In', exact: true });

  if (await createAccountButton.isVisible().catch(() => false)) {
    // First-time setup — sign up as the first owner
    await page.locator('#name').fill(E2E_USER.name);
    await page.locator('#username').fill(E2E_USER.username);
    await page.locator('#email').fill(E2E_USER.email);
    await page.locator('#password').fill(E2E_USER.password);
    await createAccountButton.click();
  } else {
    // Existing database — log in with credentials
    await page.locator('#identifier').fill(E2E_USER.email);
    await page.locator('#password').fill(E2E_USER.password);
    await signInButton.click();
  }

  // Wait for redirect to dashboard (confirms auth succeeded)
  await expect(page).toHaveURL('/', { timeout: 15_000 });

  // Save storage state (session is a cookie now, not a localStorage token)
  await page.context().storageState({ path: STORAGE_STATE_PATH });
});
