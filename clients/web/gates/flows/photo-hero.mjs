import assert from 'node:assert/strict';

/** #4775 stack-only flow. Supply an authenticated fixture page and its image opener.
 * Run once per light/dark scheme, with large text; this helper also checks reduced motion.
 * Worker only authors this flow. The planner supplies midFrame and runs it after S1 lands.
 * #5204: gate:attachment's `hero` section (`ATTACH_GATE_ONLY=hero`) now runs it in light and dark with the app's large text. */
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
    // 도착한 뒤에 세면 hero 복제본은 이미 걷혀 0 이다 — 움직임이 있었어도 통과하는 단정은 아무것도 지키지 못한다(#5204).
    // 그래서 열고 닫는 내내 `.stage-hero` 가 **한 번이라도** DOM 에 들어왔는지를 관찰자로 센다.
    await page.evaluate(() => {
      const seen = {count: 0};
      const mark = node => {
        if (node instanceof Element && (node.matches('.stage-hero') || node.querySelector('.stage-hero'))) seen.count += 1;
      };
      const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(mark)));
      observer.observe(document.body, {childList: true, subtree: true});
      window.__oort4775Reduced = {seen, observer, mark};
    });
    await opener.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="image-lightbox"]')?.dataset.stagePhase === 'open');
    assert.equal(await page.locator('.stage-hero').count(), 0, 'Reduced motion must have no hero animation');
    await page.keyboard.press('Escape');
    await page.getByTestId('image-lightbox').waitFor({state: 'detached'});
    const inserted = await page.evaluate(() => {
      const {seen, observer, mark} = window.__oort4775Reduced;
      observer.takeRecords().forEach(record => record.addedNodes.forEach(mark));
      return seen.count;
    });
    assert.equal(inserted, 0, 'Reduced motion put a hero clone in the page while opening or closing');
  } finally {
    await page.evaluate(() => {
      if (window.__oort4775Probe) window.__oort4775Probe.running = false;
      delete window.__oort4775Probe;
      window.__oort4775Reduced?.observer.disconnect();
      delete window.__oort4775Reduced;
    });
  }
}
