import assert from 'node:assert/strict';

/** #4775 stack-only flow. Supply an authenticated fixture page and its image opener.
 * Run once per light/dark scheme, with large text; this helper also checks reduced motion.
 * Worker only authors this flow. The planner supplies midFrame and runs it after S1 lands. */
export async function exercisePhotoHero(page, opener, {midFrame}) {
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await opener.scrollIntoViewIfNeeded();
  await opener.evaluate(node => {
    const row = node.closest('[data-testid="timeline-message"]') ?? node;
    const ancestors = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
    const before = row.getBoundingClientRect();
    const offsets = ancestors.map(parent => [parent.scrollLeft, parent.scrollTop]);
    const probe = {running: true, moved: false};
    window.__oort4775Probe = probe;
    const sample = () => {
      const rect = row.getBoundingClientRect();
      probe.moved ||= rect.top !== before.top || rect.left !== before.left ||
        ancestors.some((parent, index) => parent.scrollLeft !== offsets[index][0] || parent.scrollTop !== offsets[index][1]);
      if (probe.running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  try {
    await opener.click();
    // Pause at a visible intermediate geometry, before the spring has nearly settled.
    await page.waitForFunction(() => document.querySelector('.stage-hero')?.getAnimations().length > 0);
    await page.evaluate(() => {
      const motion = document.querySelector('.stage-hero').getAnimations()[0];
      motion.pause();
      motion.currentTime = Number(motion.effect.getTiming().duration) / 4;
    });
    if (midFrame) await page.screenshot({path: midFrame});
    await page.evaluate(() => document.querySelector('.stage-hero').getAnimations()[0].play());
    await page.waitForFunction(() => document.querySelector('[data-testid="image-lightbox"]')?.dataset.stagePhase === 'open');
    await page.locator('.lightbox-photo').dblclick();
    await page.waitForFunction(() => document.querySelector('.lightbox-photo')?.hasAttribute('data-zoomed'));
    await page.keyboard.press('Escape');
    await page.getByTestId('image-lightbox').waitFor({state: 'detached'});
    await page.waitForFunction(node => node === document.activeElement, await opener.elementHandle());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const moved = await page.evaluate(() => window.__oort4775Probe.moved);
    assert.equal(moved, false, 'Conversation geometry/scroll moved during or after the photo hero');
    await page.emulateMedia({reducedMotion: 'reduce'});
    await opener.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="image-lightbox"]')?.dataset.stagePhase === 'open');
    assert.equal(await page.locator('.stage-hero').count(), 0, 'Reduced motion must have no hero animation');
    await page.keyboard.press('Escape');
    await page.getByTestId('image-lightbox').waitFor({state: 'detached'});
  } finally {
    await page.evaluate(() => {
      if (window.__oort4775Probe) window.__oort4775Probe.running = false;
      delete window.__oort4775Probe;
    });
  }
}
