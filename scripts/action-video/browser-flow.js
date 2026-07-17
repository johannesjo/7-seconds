async (page) => {
  const canvas = page.locator('#pixi-container canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Game canvas was not available');

  const { x: left, y: top, width, height } = box;
  const spacing = 60;
  const startX = left + (width - spacing * 4) / 2;
  const clampX = (x) => Math.max(left + 24, Math.min(left + width - 24, x));
  const point = (unit, dx, y) => [clampX(startX + spacing * unit + width * dx), top + height * y];
  const paths = [
    [point(0, 0, .92), point(0, -.05, .82), point(0, -.03, .70), point(0, .02, .60), point(0, .03, .50), point(0, .04, .38)],
    [point(1, 0, .92), point(1, .02, .80), point(1, .06, .68), point(1, .09, .56), point(1, .10, .43)],
    [point(2, 0, .92), point(2, .07, .82), point(2, .12, .73), point(2, .15, .62), point(2, .13, .50), point(2, .10, .38)],
    [point(3, 0, .92), point(3, -.02, .82), point(3, -.02, .70), point(3, -.01, .60), point(3, -.02, .48)],
    [point(4, 0, .92), point(4, .02, .83), point(4, .04, .72), point(4, .05, .60), point(4, .04, .48)],
  ];
  if (paths.length !== 5) throw new Error('Expected one path per unit');

  for (const path of paths) {
    await page.mouse.move(...path[0]);
    await page.mouse.down();
    for (const next of path.slice(1)) {
      await page.mouse.move(...next, { steps: 8 });
      await page.waitForTimeout(50);
    }
    await page.mouse.up();
    await page.waitForTimeout(140);
  }

  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(4500);
  const variant = width > 700 ? 'square' : 'mobile';
  return { variant, width, height };
}
