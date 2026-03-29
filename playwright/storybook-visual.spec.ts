import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

type StoryIndexEntry = {
  id: string;
  type: string;
};

type StoryIndex = {
  entries: Record<string, StoryIndexEntry>;
};

const indexPath = path.join(process.cwd(), 'storybook-static', 'index.json');

function loadStoryIds(): string[] {
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      'storybook-static/index.json が見つかりません。先に `pnpm build-storybook` を実行してください。',
    );
  }
  const raw = fs.readFileSync(indexPath, 'utf8');
  const index = JSON.parse(raw) as StoryIndex;
  return Object.values(index.entries)
    .filter((entry) => entry.type === 'story')
    .map((entry) => entry.id)
    .sort((a, b) => a.localeCompare(b));
}

const storyIds = loadStoryIds();

for (const id of storyIds) {
  test(`Storybook visual: ${id}`, async ({ page }) => {
    const qs = new URLSearchParams({ id, viewMode: 'story' });
    await page.goto(`/iframe.html?${qs}`, { waitUntil: 'load' });
    const root = page.locator('#storybook-root');
    await root.waitFor({ state: 'attached' });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#storybook-root');
        return Boolean(el && el.childElementCount > 0);
      },
      { timeout: 60_000 },
    );

    const error = page.locator('.sb-errordisplay');
    if ((await error.count()) > 0 && (await error.isVisible())) {
      throw new Error(`Storybook preview error for ${id}`);
    }

    await page.evaluate(() => document.fonts.ready);

    await expect(root).toHaveScreenshot(`${id}.png`, {
      animations: 'disabled',
      caret: 'hide',
    });
  });
}
